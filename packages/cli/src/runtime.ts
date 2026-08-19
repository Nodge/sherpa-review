/** Minimum Node major version that runs the CLI (rpc-design §11.1). */
export const MIN_NODE_MAJOR = 20;

/**
 * Checks the runtime version. Returns a user-facing error or null if the version is suitable.
 * An unrecognized version string is accepted: better to allow an unusual runtime than block it.
 */
export function checkNodeVersion(version: string | undefined): string | null {
    const major = Number.parseInt(version?.replace(/^v/, '') ?? '', 10);
    if (!Number.isFinite(major) || major >= MIN_NODE_MAJOR) {
        return null;
    }

    const required = String(MIN_NODE_MAJOR);

    return [
        `sherpa: Node ${required} or newer is required, but Node ${version ?? 'of an unknown version'} is running.`,
        `Update Node (for example, nvm install ${required}) and run the command again.`,
    ].join('\n');
}
