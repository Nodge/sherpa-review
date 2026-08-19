/**
 * Protocol limits and timings (rpc-design §5, §7, spec §3.5).
 * Contract defaults: the server can override them through config, but semantics stay unchanged.
 */

/** `complete` result limit. Larger results fail the task with a clear message. */
export const RESULT_MAX_BYTES = 256 * 1024;

/** Upper bound for `worker next` long-poll, below harness timeouts (Claude Code: 10 min maximum). */
export const LONG_POLL_MAX_SECONDS = 240;

/** No CLI calls for longer than this means the worker is dead (must be > LONG_POLL_MAX_SECONDS). */
export const WORKER_DEAD_AFTER_SECONDS = 360;

/** Lease TTL by priority class. */
export const LEASE_TTL_SECONDS = { interactive: 600, background: 1800 } as const;

/** Attempts per task. Exhausting them fails the task with a UI-visible error. */
export const MAX_TASK_ATTEMPTS = 3;

/** `task progress` text limit: a status line for the UI, not a result. */
export const PROGRESS_TEXT_MAX_CHARS = 500;

/**
 * Worker endpoint paths are part of the CLI↔server contract (rpc-design §3).
 * All use POST with a JSON body matching the corresponding schema from `messages.ts`.
 */
export const WORKER_ENDPOINTS = {
    next: '/api/worker/next',
    complete: '/api/task/complete',
    progress: '/api/task/progress',
    fail: '/api/task/fail',
} as const;
