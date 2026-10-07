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

    it('reads a file written before `avatarUrl` with a null author photo', async () => {
        const author = { login: 'alice', displayName: null, bot: false };
        const root = {
            id: 'c1',
            author,
            body: 'text',
            draft: false,
            createdAt: '2026-10-01T00:00:00.000Z',
            editedAt: null,
            idempotencyKey: null,
            replies: [],
        };
        const thread = {
            id: 't1',
            anchor: null,
            fileId: null,
            fileHash: null,
            resolved: false,
            resolvedBy: null,
            pinnedTo: null,
            root,
        };
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, JSON.stringify({ nextId: 2, verdict: null, threads: [thread], rounds: [] }));

        const data = await fileThreadsStore(filePath).read();
        expect(data.threads[0]?.root.author).toEqual({ ...author, avatarUrl: null });
    });

    it('fails on an unexpected format with the path instead of silently resetting', async () => {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, '{"nextId":"many"}');

        await expect(fileThreadsStore(filePath).read()).rejects.toThrow(filePath);
    });
});
