/**
 * Automatic server shutdown on idle. A PR server is a background daemon started by `sherpa up`. Without this,
 * it would stay in memory until the machine reboots because there is no `down` command in the contract.
 * State lives in SQLite and survives shutdown. The next `up` starts the server again.
 */

/** Default idle threshold (decision 2026-08-20): a quarter hour without UI or CLI calls. */
export const DEFAULT_IDLE_SECONDS = 15 * 60;

/** Idle check interval. A minute is enough for a quarter-hour threshold, shorter thresholds are checked more often. */
const MAX_CHECK_INTERVAL_MS = 60_000;
const MIN_CHECK_INTERVAL_MS = 50;

/** Undocumented threshold override: the end-to-end bundle test uses it to shorten a quarter hour to seconds. */
const IDLE_SECONDS_ENV = 'SHERPA_IDLE_SECONDS';

export interface IdleWatchOptions {
    /** Idle threshold in seconds. `0` disables automatic shutdown. */
    readonly idleSeconds: number;
    /** Injectable clock, as in the queue and worker registry. Tests simulate idle time without waiting. */
    readonly now?: () => Date;
}

/**
 * Tracks server activity for the HTTP layer at the router entry point, without calls in every endpoint.
 */
export interface ActivityTracker {
    /** A request arrived. The router calls the returned function when this response connection closes. */
    open: () => () => void;
}

/**
 * The server is busy while at least one connection is open (a UI tab on SSE, a pending long-poll `next`)
 * or the time since the last request is below the threshold. Internal timers, such as SSE keepalive and the worker
 * death timer, do not count as activity, otherwise the server would never stop.
 */
export class IdleWatch implements ActivityTracker {
    private readonly idleMs: number;
    private readonly now: () => Date;

    private openConnections = 0;
    private lastActivity: number;
    private timer: NodeJS.Timeout | null = null;
    private onIdle: (() => void) | null = null;
    private fired = false;

    constructor(options: IdleWatchOptions) {
        this.idleMs = Math.max(options.idleSeconds, 0) * 1000;
        this.now = options.now ?? ((): Date => new Date());
        this.lastActivity = this.now().getTime();
    }

    /** Disabled threshold. Activity is still tracked, but nothing will stop the server. */
    get enabled(): boolean {
        return this.idleMs > 0;
    }

    open(): () => void {
        this.openConnections += 1;
        this.lastActivity = this.now().getTime();

        let closed = false;
        return () => {
            if (closed) {
                return;
            }
            closed = true;
            this.openConnections -= 1;
            // The idle countdown starts when a connection closes, not when it opens. For SSE and long-poll,
            // these moments are minutes apart.
            this.lastActivity = this.now().getTime();
        };
    }

    /**
     * Arms automatic shutdown. Activity is already tracked before this point, but there is nothing to stop
     * because the server is still starting.
     */
    arm(onIdle: () => void): void {
        if (!this.enabled || this.fired || this.timer !== null) {
            return;
        }

        this.onIdle = onIdle;
        const timer = setInterval(() => {
            this.checkNow();
        }, this.checkIntervalMs());
        // The idle timer must not keep the process alive itself.
        timer.unref();
        this.timer = timer;
    }

    /** Checks immediately. Called by the timer in production and by clock advances in tests. */
    checkNow(): void {
        const onIdle = this.onIdle;
        if (onIdle === null || this.openConnections > 0) {
            return;
        }
        if (this.now().getTime() - this.lastActivity < this.idleMs) {
            return;
        }

        this.fired = true;
        this.close();
        onIdle();
    }

    /** Stops the idle timer because there is nothing left to wake after shutdown. Repeated calls are a no-op. */
    close(): void {
        this.onIdle = null;
        if (this.timer !== null) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    private checkIntervalMs(): number {
        return Math.max(MIN_CHECK_INTERVAL_MS, Math.min(MAX_CHECK_INTERVAL_MS, this.idleMs / 2));
    }
}

/**
 * Idle threshold from the environment (`SHERPA_IDLE_SECONDS`, undocumented). The bundle end-to-end test uses it
 * to reduce a quarter hour to seconds. Invalid input, an empty value and negative numbers use the default.
 */
export function readIdleSeconds(env: NodeJS.ProcessEnv): number {
    const raw = env[IDLE_SECONDS_ENV];
    if (raw === undefined || raw.trim() === '') {
        return DEFAULT_IDLE_SECONDS;
    }

    const seconds = Number(raw);
    return Number.isFinite(seconds) && seconds >= 0 ? seconds : DEFAULT_IDLE_SECONDS;
}

/** Idle threshold for a log line, in minutes for whole-minute values and seconds otherwise. */
export function formatIdlePeriod(seconds: number): string {
    if (seconds >= 60 && seconds % 60 === 0) {
        return `${String(seconds / 60)} min`;
    }
    return `${String(seconds)} s`;
}
