import fs from 'node:fs';

import type { DistributionVersion, UiUpdate, UiUpdateInstall } from '@sherpa/protocol';
import { distributionVersionSchema } from '@sherpa/protocol';

import { describeFetchError } from './errors.js';



import { updateCheckPathFor } from './paths.js';
import type { SettingsStore } from './settings-store.js';
import { SERVER_VERSION } from './version.js';

/**
 * Check for a newer version in main. Notification only. Sherpa does not
 * it downloads or installs nothing, and reports new versions with an update command.
 */

/** Distribution path: used to build the `version.json` URL and checkout path suffix. */
export const DISTRIBUTION_PATH = 'tools/sherpa';

/** Cache freshness duration: server restarts must not hammer the API. */
const CACHE_TTL_MS = 30 * 60 * 1000;

const REQUEST_TIMEOUT_MS = 5000;


const SOURCE_CHECKOUT_TAIL = `/${DISTRIBUTION_PATH}/skill`;

/** Placeholder version for a non-release build: comparing it with main makes no sense. */
const DEV_VERSION = '0.0.0';

export interface UpdateCheckOptions {
    /** Distribution directory realpath from `--install-dir`. undefined means a dev run without a distribution. */
    readonly installDir?: string;
    /** Transport. Defaults to global fetch. */
    readonly fetch?: typeof fetch;
    readonly now?: () => Date;
    /** Result cache file. Defaults to `<sherpaDir>/update-check.json`. */
    readonly cacheFile?: string;
    /** Distribution path in main. Defaults to `tools/sherpa`. */
    readonly distributionPath?: string;
    
    readonly token?: TokenSource;
    /** Embedded server version. Overridden only in tests, where `SERVER_VERSION` is zero. */
    readonly currentVersion?: string;
}

export interface UpdateCheckerOptions extends UpdateCheckOptions {
    /** State root used to derive the cache path when `cacheFile` is not set. */
    readonly sherpaDir: string;
    /** Reads the dismissed version when assembling the snapshot, because settings live on disk. */
    readonly settings: SettingsStore;
    /** `false` disables checks entirely (fixture host): a dev endpoint supplies the state. */
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
    | { readonly ok: true; readonly latest: DistributionVersion }
    | { readonly ok: false; readonly reason: string };

/** Cache file contents. `latest: null` means a check ran and failed. */
interface UpdateCheckCache {
    readonly checkedAt: string;
    readonly latest: DistributionVersion | null;
}

/**
 * Reads the distribution's `skill/version.json` from main and keeps the result for the UI snapshot.
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
    private readonly distributionPath: string;
    private readonly token: TokenSource;
    private readonly currentVersion: string;
    private readonly install: UiUpdateInstall;
    private readonly enabled: boolean;
    private readonly listeners = new Set<() => void>();
    /** Last known distribution version in main. null means no check ran or it failed. */
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
        this.distributionPath = options.distributionPath ?? DISTRIBUTION_PATH;
        this.token = options.token ?? (() => resolveHostToken());
        this.currentVersion = options.currentVersion ?? SERVER_VERSION;
        this.install = classifyInstall(options.installDir);
        this.enabled = options.enabled ?? true;
    }

    /** Synchronous source for `buildState`. */
    get(): UiUpdate | null {
        const latest = this.latest;
        if (latest === null || compareVersions(latest.version, this.currentVersion) <= 0) {
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
     * First check after `listen`: reads a fresh cache from disk, or requests
     * main if the cache expired. Server startup does not wait for it.
     */
    start(): void {
        if (!this.checkable()) {
            return;
        }
        void this.check(false);
    }

    /**
     * Recheck from a palette command, ignoring TTL. Disabled checks (fixture,
     * dev build) return existing state without network calls.
     */
    async force(): Promise<UpdateForceResult> {
        const failure = this.checkable() ? await this.check(true) : null;
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

    /** Whether a network call makes sense: fixtures and dev builds must not compare themselves with main. */
    private checkable(): boolean {
        return this.enabled && !this.closed && this.currentVersion !== DEV_VERSION;
    }

    /** Returns the failure reason or null. The caller needs this only for `force()`. */
    private async check(force: boolean): Promise<string | null> {
        // Checks finish out of start order: a request from `start()` can easily outlive
        // a forced command palette check, and its timeout would overwrite the fresh result.
        const generation = ++this.started;
        const cached = force ? null : this.readCache();
        if (cached !== null) {
            this.applied = generation;
            this.apply(cached.latest);
            return null;
        }

        const loaded = await this.load();
        const failure = loaded.ok ? null : loaded.reason;
        if (this.closed || generation < this.applied) {
            return failure;
        }
        this.applied = generation;
        if (this.apply(loaded.ok ? loaded.latest : null)) {
            this.writeCache({ checkedAt: this.now().toISOString(), latest: this.latest });
        }
        return failure;
    }

    /**
     * Puts the check result in state. A failure (`null`) does not erase a known version:
     * a failed recheck must not hide the toast or top bar dot, or reach
     * the cache that restarted servers would read for the next half hour. `false` means nothing to write.
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
    private async load(): Promise<LoadResult> {
        
        try {
            const token = await this.token();
            const response = await this.fetchImpl(url, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`response ${String(response.status)}`);
            }
            
            return { ok: true, latest: distributionVersionSchema.parse(await response.json()) };
        } catch (error) {
            const reason = describeFetchError(error);
            process.stderr.write(`sherpa-server: update check failed: ${reason}\n`);
            return { ok: false, reason };
        }
    }

    /** `null` means the cache is absent, invalid or expired: a request is needed. */
    private readCache(): UpdateCheckCache | null {
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
        if (cache === null) {
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
            process.stderr.write(`sherpa-server: failed to write update check cache: ${describeFetchError(error)}\n`);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

/**
 * Where the distribution was installed from. A path ending in `/tools/sherpa/skill` is a checkout,
 * updated with `git pull` at the repository root. Anything else is a directory copy without a command.
 */
export function classifyInstall(installDir?: string): UiUpdateInstall {
    if (installDir === undefined) {
        return { kind: 'copy', dir: process.cwd(), command: null };
    }

    const normalized = installDir.replaceAll('\\', '/').replace(/\/+$/u, '');
    if (normalized.endsWith(SOURCE_CHECKOUT_TAIL)) {
        const root = normalized.slice(0, normalized.length - SOURCE_CHECKOUT_TAIL.length);
        const dir = root === '' ? '/' : root;
        
    }
    return { kind: 'copy', dir: installDir, command: null };
}

/** The command is copied into a terminal: an unquoted path with a space would become two arguments. */
function shellQuote(value: string): string {
    return `'${value.replaceAll("'", String.raw`'\''`)}'`;
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
    const { checkedAt, latest } = payload as { checkedAt?: unknown; latest?: unknown };
    if (typeof checkedAt !== 'string' || Number.isNaN(Date.parse(checkedAt))) {
        return null;
    }
    if (latest === null) {
        return { checkedAt, latest: null };
    }
    const parsed = distributionVersionSchema.safeParse(latest);
    return parsed.success ? { checkedAt, latest: parsed.data } : null;
}

