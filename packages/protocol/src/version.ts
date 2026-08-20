import { z } from 'zod';

/**
 * Session↔server protocol version (rpc-design §9).
 * Compatibility rule: in the 0.x line, a minor change is breaking. From 1.0 onward, matching majors suffice.
 */
export const PROTOCOL_VERSION = '0.1.1';

/** Semver string without prereleases or metadata, for protocol, CLI and server versions. */
export const semverSchema = z.string().regex(/^\d+\.\d+\.\d+$/, 'expected a version in X.Y.Z format');

/** Checks two protocol versions for compatibility by the rule above. Unrecognized strings are incompatible. */
export function protocolVersionsCompatible(a: string, b: string): boolean {
    const pa = parseVersion(a);
    const pb = parseVersion(b);
    if (pa === null || pb === null) {
        return false;
    }
    if (pa.major !== pb.major) {
        return false;
    }
    return pa.major > 0 || pa.minor === pb.minor;
}

function parseVersion(version: string): { major: number; minor: number } | null {
    const match = /^(\d+)\.(\d+)\.\d+$/.exec(version);
    if (match === null) {
        return null;
    }
    return { major: Number(match[1] ?? ''), minor: Number(match[2] ?? '') };
}
