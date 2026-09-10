import type { RpcErrorCode } from '@sherpa/protocol';

/**
 * A domain error with a contract code: endpoints convert it to an `rpcError` body
 * and the corresponding HTTP status without making assumptions.
 */
export class RpcFailure extends Error {
    readonly code: RpcErrorCode;
    readonly details: readonly string[] | undefined;

    constructor(code: RpcErrorCode, message: string, details?: readonly string[]) {
        super(message);
        this.name = 'RpcFailure';
        this.code = code;
        this.details = details;
    }
}

/** A live server for the same PR already holds the manifest. A second process must not start (docs/architecture.md §1). */
export class ServerAlreadyRunningError extends Error {
    readonly prKey: string;
    readonly port: number;
    readonly pid: number;

    constructor(details: { prKey: string; port: number; pid: number }) {
        super(
            `A Sherpa server for PR ${details.prKey} is already running: PID ${String(details.pid)}, ` +
                `port ${String(details.port)}. A second server for the same PR cannot start.`,
        );
        this.name = 'ServerAlreadyRunningError';
        this.prKey = details.prKey;
        this.port = details.port;
        this.pid = details.pid;
    }
}

/**
 * Describes a `fetch` network error for logs and endpoint responses. `fetch` itself throws a generic
 * "fetch failed", with the cause (`SELF_SIGNED_CERT_IN_CHAIN`, `ECONNREFUSED`) in `cause`.
 * Without it, logs cannot explain the failure. `AbortSignal.timeout` timeouts get a dedicated message.
 */
export function describeFetchError(error: unknown): string {
    if (!(error instanceof Error)) {
        return String(error);
    }
    if (error.name === 'TimeoutError') {
        return 'timeout';
    }
    const cause = describeCause(error.cause);
    return cause === null ? error.message : `${error.message}: ${cause}`;
}

function describeCause(cause: unknown): string | null {
    if (!(cause instanceof Error)) {
        return null;
    }
    const code = 'code' in cause && typeof cause.code === 'string' ? cause.code : null;
    if (code === null) {
        return cause.message;
    }
    return cause.message === '' ? code : `${code} ${cause.message}`;
}
