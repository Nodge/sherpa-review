/**
 * Minimum Node version: built-in `node:sqlite` has been available without a flag since 22.13, and
 * the Sherpa server uses it. The threshold applies to the whole distribution. The CLI and server bundle share
 * a directory and a runtime, so `@sherpa/server` repeats the same check (`src/runtime.ts`).
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 13;

/**
 * Minor-version threshold within a major release line. `node:sqlite` became available without a flag in 23.4, and
 * was backported to 22.13. So 23.0–23.3 is newer than the threshold but still lacks the module.
 * Release lines absent here have no threshold: everything newer than 23 shipped with the module.
 */
const MIN_MINOR_BY_MAJOR: Readonly<Record<number, number | undefined>> = { 22: MIN_NODE_MINOR, 23: 4 };

/**
 * Checks the runtime version. Returns a user-facing error or null if the version is suitable.
 * An unrecognized version string is accepted: better to allow an unusual runtime than block it.
 */
export function checkNodeVersion(version: string | undefined): string | null {
    const parts = (version ?? '').replace(/^v/, '').split('.');
    const major = Number.parseInt(parts[0] ?? '', 10);
    const minor = Number.parseInt(parts[1] ?? '', 10);
    if (!Number.isFinite(major)) {
        return null;
    }

    if (major >= MIN_NODE_MAJOR) {
        const minMinor = MIN_MINOR_BY_MAJOR[major];
        if (minMinor === undefined || !Number.isFinite(minor) || minor >= minMinor) {
            return null;
        }
    }

    const required = `${String(MIN_NODE_MAJOR)}.${String(MIN_NODE_MINOR)}`;

    return [
        `sherpa: Node ${required} or newer is required (in the 23 line — from 23.4 on), ` +
            `but Node ${version ?? 'of an unknown version'} is running.`,
        `Update Node (for example, nvm install ${required}) and run the command again.`,
    ].join('\n');
}
