import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bearer token length in bytes, stored as hex in the manifest (rpc-design §8). */
const TOKEN_BYTES = 32;

export function createToken(): string {
    return randomBytes(TOKEN_BYTES).toString('hex');
}

/** Extracts the token from the `Authorization: Bearer <token>` header. The scheme is case-insensitive. */
export function extractBearerToken(header: string | undefined): string | null {
    if (header === undefined) {
        return null;
    }

    const match = /^Bearer[ \t]+(\S+)$/i.exec(header.trim());
    return match?.[1] ?? null;
}

/**
 * Constant-time token comparison. Compare hashes instead of the strings themselves:
 * timingSafeEqual requires equal lengths, and hashing equalizes them without exposing the real token's length.
 */
export function tokenMatches(expected: string, provided: string | null): boolean {
    if (provided === null) {
        return false;
    }
    return timingSafeEqual(sha256(expected), sha256(provided));
}

function sha256(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
}
