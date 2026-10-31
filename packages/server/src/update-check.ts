import fs from 'node:fs';

import type { DistributionVersion, UiUpdate, UiUpdateInstall } from '@sherpa/protocol';
import { distributionVersionSchema } from '@sherpa/protocol';

import { describeFetchError } from './errors.js';
import { updateCheckPathFor } from './paths.js';
import type { SettingsStore } from './settings-store.js';
import type { UpdateChannel } from './update-channel.js';
import { SERVER_VERSION } from './version.js';

/**
 * Checks for a new version through the build update channel. Notification only: Sherpa does not
 * download or install anything. It reports a release and tells you how to update.
 */

/** How long the cache stays fresh: server restarts must not hammer the channel. */
const CACHE_TTL_MS = 30 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5000;

/** Placeholder version for a non-release build: comparing it with a published version makes no sense. */
const DEV_VERSION = '0.0.0';

export interface UpdateCheckOptions {
    /** Distribution directory realpath from `--install-dir`. undefined means a dev run without a distribution. */
    readonly installDir?: string;
    /** Transport. Defaults to global fetch. */
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
    /** Result cache file. Defaults to `<sherpaDir>/update-check.json`. */
    readonly cacheFile?: string;
    /** Embedded server version. Overridden only in tests, where `SERVER_VERSION` is zero. */
    readonly currentVersion?: string;
}

export interface UpdateCheckerOptions extends UpdateCheckOptions {
    /** Build channel. null disables checks entirely, and `get()` always returns null. */
    readonly channel: UpdateChannel | null;
    /** State root used to derive the cache path when `cacheFile` is not set. */
    readonly sherpaDir: string;
    /** Reads the dismissed version when assembling the snapshot, because settings live on disk. */
    readonly settings: SettingsStore;
    /**
     * `false` means no network requests (host with `disablesUpdateCheck`): the dev endpoint supplies the version,
     * and the channel supplies the update hint.
     */
    readonly enabled?: boolean;
}

/**
 * Forced check result: a failure cannot be reported as "no updates". The command palette must
 * say "failed to check" instead of confirming the version is up to date.
 */
export interface UpdateForceResult {
    readonly update: UiUpdate | null;
    /** Human-readable failure reason. null means the check succeeded (or was disabled). */
    readonly failure: string | null;
}

type LoadResult =
    | { readonly ok: true; readonly latest: DistributionVersion | null }
    | { readonly ok: false; readonly reason: string };

/** Cache file contents. `latest: null` means the check failed or the channel does not know the version. */
interface UpdateCheckCache {
    /** `UpdateChannel.id`: a record from another channel (or without a channel) counts as a missing cache. */
    readonly channel: string;
    readonly checkedAt: string;
    readonly latest: DistributionVersion | null;
}

/**
 * Asks the channel for the latest version and holds the result for the UI snapshot.
 * `get()` is synchronous for the same reason as in `PrMetaCache`: snapshots are assembled in a timer
 * and a microtask, where a network call has no place.
 *
 * A failed check does not break the server: one line in stderr, `update` stays null, and server startup
 * neither waits nor fails.
 */
export class UpdateChecker {
    private readonly settings: SettingsStore;
    private readonly fetchImpl: typeof fetch;
    private readonly now: () => Date;
    private readonly cacheFile: string;
    private readonly currentVersion: string;
    private readonly channel: UpdateChannel | null;
    /** Channel hint. null means no channel. */
    private readonly install: UiUpdateInstall | null;
    private readonly enabled: boolean;
    private readonly listeners = new Set<() => void>();
    /** Latest known published version. null means unknown, not checked or a failed check. */
    private latest: DistributionVersion | null = null;
    private closed = false;
    /** Last issued check number, increasing in request start order. */
    private started = 0;
    /** Number of the check whose response is currently in `latest`. */
    private applied = 0;

    constructor(options: UpdateCheckerOptions) {
        this.settings = options.settings;
        this.fetchImpl = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
        this.now = options.now ?? (() => new Date());
        this.cacheFile = options.cacheFile ?? updateCheckPathFor(options.sherpaDir);
        this.currentVersion = options.currentVersion ?? SERVER_VERSION;
        this.channel = options.channel;
        this.install = options.channel?.install(options.installDir ?? null) ?? null;
        this.enabled = options.enabled ?? true;
    }

    /** Synchronous source for `buildState`. */
    get(): UiUpdate | null {
        const latest = this.latest;
        if (this.install === null || latest === null || compareVersions(latest.version, this.currentVersion) <= 0) {
            return null;
        }
        if (this.settings.read().updates.dismissedVersion === latest.version) {
            return null;
        }
        return {
            current: this.currentVersion,
            latest: latest.version,
            releasedAt: latest.releasedAt,
            whatsNew: latest.whatsNew,
            install: this.install,
        };
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * First check after `listen`: reads a fresh cache from disk, asks the channel if the cache
     * is stale. Server startup does not wait for it.
     */
    start(): void {
        const channel = this.checkable();
        if (channel === null) {
            return;
        }
        void this.check(channel, false);
    }

    /**
     * Recheck from a command palette action: ignores TTL. A disabled check (no channel,
     * host without checks, dev build) returns the current value without network requests.
     */
    async force(): Promise<UpdateForceResult> {
        const channel = this.checkable();
        const failure = channel === null ? null : await this.check(channel, true);
        return { update: this.get(), failure };
    }

    /**
     * Dev endpoint: the fixture server "learns" about a new version. Leaves the disk cache untouched,
     * because the injected version must not survive a restart.
     */
    setLatest(latest: DistributionVersion): UiUpdate | null {
        this.latest = latest;
        this.notify();
        return this.get();
    }

    /**
     * Settings changed: `get()` reads `dismissedVersion`, but snapshot subscribers do not
     * learn about that. This endpoint tells them about the settings change.
     */
    settingsChanged(): void {
        this.notify();
    }

    close(): void {
        this.closed = true;
        this.listeners.clear();
    }

    /** Channel when network requests make sense. null for no channel, a host without checks or a dev build. */
    private checkable(): UpdateChannel | null {
        return this.enabled && !this.closed && this.currentVersion !== DEV_VERSION ? this.channel : null;
    }

    /** Returns the failure reason or null. The caller needs this only for `force()`. */
    private async check(channel: UpdateChannel, force: boolean): Promise<string | null> {
        // Checks finish out of start order: a request from `start()` can easily outlive
        // a forced command palette check, and its timeout would overwrite the fresh result.
        const generation = ++this.started;
        const cached = force ? null : this.readCache(channel.id);
        if (cached !== null) {
            this.applied = generation;
            this.apply(cached.latest);
            return null;
        }

        const loaded = await this.load(channel);
        const failure = loaded.ok ? null : loaded.reason;
        if (this.closed || generation < this.applied) {
            return failure;
        }
        this.applied = generation;
        if (this.apply(loaded.ok ? loaded.latest : null)) {
            this.writeCache({ channel: channel.id, checkedAt: this.now().toISOString(), latest: this.latest });
        }
        return failure;
    }

    /**
     * Stores the check result in state. A failure or "channel does not know the version" (`null`) preserves
     * an already known version: a failed recheck must not remove the toast and the top bar dot
     * or enter the cache, which restarts would read for the next half hour.
     * `false` means there is nothing to write.
     */
    private apply(latest: DistributionVersion | null): boolean {
        if (latest === null && this.latest !== null) {
            return false;
        }
        this.latest = latest;
        this.notify();
        return true;
    }

    /** The failure reason is already in stderr. Only a forced command palette check returns it to the caller. */
    private async load(channel: UpdateChannel): Promise<LoadResult> {
        try {
            const latest = await channel.latest({
                fetch: this.fetchImpl,
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            return { ok: true, latest };
        } catch (error) {
            const reason = describeFetchError(error);
            process.stderr.write(`sherpa-review-server: update check failed: ${reason}\n`);
            return { ok: false, reason };
        }
    }

    /** `null` means the cache is missing, corrupt, stale or from another channel: a request is needed. */
    private readCache(channelId: string): UpdateCheckCache | null {
        let raw: string;
        try {
            raw = fs.readFileSync(this.cacheFile, 'utf8');
        } catch {
            return null;
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            return null;
        }
        const cache = parseCache(parsed);
        if (cache?.channel !== channelId) {
            return null;
        }
        const checkedAt = Date.parse(cache.checkedAt);
        const age = this.now().getTime() - checkedAt;
        // Treat a cache from the future (clock change) as stale, or it could stay stuck forever.
        return age >= 0 && age < CACHE_TTL_MS ? cache : null;
    }

    /** Atomic write: servers for all PRs share the file, so readers must not see a partial write. */
    private writeCache(cache: UpdateCheckCache): void {
        const temp = `${this.cacheFile}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
        try {
            fs.writeFileSync(temp, `${JSON.stringify(cache, null, 4)}\n`, { mode: 0o600 });
            fs.chmodSync(temp, 0o600);
            fs.renameSync(temp, this.cacheFile);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            process.stderr.write(`sherpa-review-server: failed to write update check cache: ${describeFetchError(error)}\n`);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

/** `>0` means `a` is newer than `b`. There are no prereleases, so comparing 3 numbers is enough. */
export function compareVersions(a: string, b: string): number {
    const left = parseTriple(a);
    const right = parseTriple(b);
    for (let index = 0; index < 3; index += 1) {
        const diff = (left[index] ?? 0) - (right[index] ?? 0);
        if (diff !== 0) {
            return diff;
        }
    }
    return 0;
}

function parseTriple(version: string): readonly number[] {
    return version.split('.').map((part) => Number.parseInt(part, 10) || 0);
}

function parseCache(payload: unknown): UpdateCheckCache | null {
    if (typeof payload !== 'object' || payload === null) {
        return null;
    }
    const { channel, checkedAt, latest } = payload as { channel?: unknown; checkedAt?: unknown; latest?: unknown };
    if (typeof channel !== 'string' || typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) {
        return null;
    }
    if (latest === null) {
        return { channel, checkedAt, latest: null };
    }
    const parsed = distributionVersionSchema.safeParse(latest);
    return parsed.success ? { channel, checkedAt, latest: parsed.data } : null;
}

