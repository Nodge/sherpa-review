import type { RpcErrorCode } from '@sherpa/protocol';

/**
 * An error with a message ready for the model: what happened and what to do next.
 * No stacks or dumps in the output, as a language model reads the CLI output (`docs/protocol.md §3`).
 */
export class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

/**
 * Server rejection under the contract. Prints the message as is. Commands use the code
 * to respond to specific rejections with their own action instead of exiting with an error.
 */
export class RpcCallError extends CliError {
    readonly code: RpcErrorCode;

    constructor(code: RpcErrorCode, message: string) {
        super(message);
        this.name = 'RpcCallError';
        this.code = code;
    }
}

/** User-facing message from any caught error. */
export function userMessage(error: unknown): string {
    if (error instanceof CliError) {
        return error.message;
    }

    const detail = error instanceof Error ? error.message : String(error);
    return `sherpa: unexpected failure — ${detail}\nRepeat the command; if it keeps failing, restart the Sherpa skill.`;
}
