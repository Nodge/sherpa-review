/**
 * Protocol limits and timings (`docs/protocol.md §5, §7`, `docs/architecture.md §7.5`).
 * Contract defaults: the server can override them through config, but semantics stay unchanged.
 */

/** `complete` result limit. Larger results fail the task with a clear message. */
export const RESULT_MAX_BYTES = 256 * 1024;

/** One `worker next` long-poll window. The CLI requests again when it expires. */
export const LONG_POLL_DEFAULT_SECONDS = 240;

/**
 * Silence while holding a lease beyond this duration → the worker is considered dead.
 * Does not affect waiting in `next`: while the call is pending, its open connection proves liveness
 * (`docs/protocol.md §7`), so a long wait does not make the worker dead.
 */
export const WORKER_DEAD_AFTER_SECONDS = 360;

/**
 * UI departure grace: sends `done` to the worker when the last UI connection has been closed longer than this
 * duration. Page reloads, tab navigation, laptop sleep and brief network
 * interruptions break SSE for seconds without the reviewer leaving, so this must be at least a minute.
 */
export const UI_GONE_GRACE_SECONDS = 60;

/** Lease TTL by priority class. */
export const LEASE_TTL_SECONDS = { interactive: 600, background: 1800 } as const;

/** Attempts per task. Exhausting them fails the task with a UI-visible error. */
export const MAX_TASK_ATTEMPTS = 3;

/**
 * Diff image side limit (`ImageSide.size`): above it, the UI does not load the side and offers
 * a download from the host, while the host's `getBlob` returns null. Same policy as for file text content.
 */
export const IMAGE_BLOB_MAX_BYTES = 10_000_000;

/** `task progress` text limit: a status line for the UI, not a result. */
export const PROGRESS_TEXT_MAX_CHARS = 500;

/**
 * Local review outcome instruction limit (`sherpa up --local --verdicts <instruction>`): the instruction
 * is printed verbatim in the `review.feedback` task as a user request, not a document.
 */
export const VERDICTS_INSTRUCTION_MAX_CHARS = 2000;

/**
 * Worker endpoint paths are part of the CLI↔server contract (`docs/protocol.md §3`).
 * All use POST with a JSON body matching the corresponding schema from `messages.ts`.
 */
export const WORKER_ENDPOINTS = {
    register: '/api/worker/register',
    next: '/api/worker/next',
    complete: '/api/task/complete',
    progress: '/api/task/progress',
    fail: '/api/task/fail',
} as const;
