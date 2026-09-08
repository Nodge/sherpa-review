import fs from 'node:fs/promises';
import path from 'node:path';

import { ensurePrivateDir } from './paths.js';

/**
 * On-disk cache for diff image bytes. `blobId` addresses content, not a file: identical
 * bytes across iterations and slices share the same key, so entries never expire.
 *
 * The directory is `blobs/` inside the PR state directory. The filename is the base64url encoding of `blobId` (the id is opaque and may
 * contain `/`). Writes are atomic: a temporary file beside the target and `rename` prevent concurrent requests
 * for the same blob from reading partial content.
 *
 * The cache has no size limit or cleanup: review images are small, and the directory lives as long as
 * this PR's state.
 */
export class BlobCache {
    private readonly sherpaDir: string;
    private readonly dir: string;

    constructor(sherpaDir: string, dir: string) {
        this.sherpaDir = sherpaDir;
        this.dir = dir;
    }

    /** Cached bytes. null means the blob is not here (or this is the first read and the file does not exist at all). */
    async read(blobId: string): Promise<Uint8Array | null> {
        try {
            return new Uint8Array(await fs.readFile(this.pathOf(blobId)));
        } catch {
            return null;
        }
    }

    /** Caches bytes. A write failure is not the caller's error, since it already has the blob. */
    async write(blobId: string, bytes: Uint8Array): Promise<void> {
        const target = this.pathOf(blobId);
        const temporary = `${target}.${String(process.pid)}.${String(writeCounter++)}.tmp`;
        try {
            await ensurePrivateDir(this.sherpaDir, this.dir);
            await fs.writeFile(temporary, bytes, { mode: 0o600 });
            await fs.rename(temporary, target);
        } catch (error) {
            await fs.rm(temporary, { force: true }).catch(() => undefined);
            process.stderr.write(
                `sherpa-server: could not cache image blob: ${error instanceof Error ? error.message : String(error)}\n`,
            );
        }
    }

    private pathOf(blobId: string): string {
        return path.join(this.dir, base64url(blobId));
    }
}

/** Counter for temporary names: two concurrent requests for the same blob must not share a tmp file. */
let writeCounter = 0;

/** Filename from an opaque id: slashes and plus signs must not reach the path. */
function base64url(value: string): string {
    return Buffer.from(value, 'utf8').toString('base64url');
}
