import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { emptyReviewData, fileThreadsStore } from './threads-store.js';

describe('file-backed thread storage', () => {
    let dir: string;
    let filePath: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-threads-'));
        filePath = path.join(dir, 'state', 'local-review.json');
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('returns an empty review for a missing file and creates the directory and file with 0600 on write', async () => {
        const store = fileThreadsStore(filePath);
        expect(await store.read()).toEqual(emptyReviewData());

        const data = emptyReviewData();
        data.nextId = 7;
        data.verdict = { verdict: 'ship', diffId: 'deadbeef' };
        await store.write(data);

        expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
        expect(await store.read()).toEqual(data);
        // No temporary write file remains beside the result.
        expect(fs.readdirSync(path.dirname(filePath))).toEqual(['local-review.json']);
    });

    it('fails on an unexpected format with the path instead of silently resetting', async () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{"nextId":"many"}');

        await expect(fileThreadsStore(filePath).read()).rejects.toThrow(filePath);
    });
});
