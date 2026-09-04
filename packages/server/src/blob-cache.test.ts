import fs from 'node:fs/promises';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BlobCache } from './blob-cache.js';
import { blobsDirOf } from './paths.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

/** Image byte cache on disk (M5-T23): filename, atomic writes and cache misses. */
describe('image blob cache', () => {
    const PR_KEY = 'fixture-medium';
    let sherpaDir: string;
    let dir: string;
    let cache: BlobCache;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        dir = blobsDirOf(sherpaDir, PR_KEY);
        cache = new BlobCache(sherpaDir, dir);
    });

    afterEach(async () => {
        await removeTempSherpaDir(sherpaDir);
    });

    it('reads back the exact bytes written and creates the directory automatically', async () => {
        const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);

        await cache.write('blob-1', bytes);

        expect(await cache.read('blob-1')).toEqual(bytes);
    });

    it('returns null on a cache miss', async () => {
        expect(await cache.read('never-written')).toBeNull();
    });

    it('turns an id with slashes and plus signs into a single filename', async () => {
        const blobId = 'cid:1:a/b+c=d';

        await cache.write(blobId, new Uint8Array([1, 2, 3]));

        const names = await fs.readdir(dir);
        expect(names).toEqual([Buffer.from(blobId, 'utf8').toString('base64url')]);
        expect(names[0]).not.toContain('/');
        expect(await cache.read(blobId)).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('writes atomically: no temporary files remain, contents are intact', async () => {
        const bytes = new Uint8Array(50_000).fill(7);

        await Promise.all([cache.write('blob-2', bytes), cache.write('blob-2', bytes)]);

        expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
        expect(await cache.read('blob-2')).toEqual(bytes);
    });

    it('does not throw on a write failure: the caller already has the bytes', async () => {
        // A file in place of a directory: mkdir at this path must fail.
        await fs.mkdir(path.dirname(dir), { recursive: true });
        await fs.writeFile(dir, 'occupied');

        await expect(cache.write('blob-3', new Uint8Array([1]))).resolves.toBeUndefined();
        expect(await cache.read('blob-3')).toBeNull();
    });
});
