/**
 * An error with a message ready for the model: what happened and what to do next.
 * Stack traces and dumps stay out of the output because a language model reads the CLI output (rpc-design §3).
 */
export class CliError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CliError';
    }
}

/** User-facing message from any caught error. */
export function userMessage(error: unknown): string {
    if (error instanceof CliError) {
        return error.message;
    }

    const detail = error instanceof Error ? error.message : String(error);
    return `sherpa: unexpected failure: ${detail}\nRepeat the command. If it keeps failing, restart the Sherpa skill.`;
}
