import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FileDiff, PrDiff } from '@sherpa/protocol';
import { prDiffSchema } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { walkPatch } from '../../route/diff-index.js';



import type { LocalIterationRecord, LocalIterationsStore } from './iterations-store.js';
import { fileIterationsStore, MAX_LOCAL_ITERATIONS, memoryIterationsStore } from './iterations-store.js';
import type { LocalHostOptions } from './local-host.js';
import { LocalHost } from './local-host.js';
import { MAX_FILE_BYTES } from './snapshot.js';
import { memoryThreadsStore } from './threads-store.js';
import type { CommandRunner } from './vcs.js';

/**
 * Local host iteration history and slices between iterations support progress carryover,
 * note anchors and the stale route banner.
 */

const PREFIX = 'app';

function fileOf(diff: PrDiff, filePath: string): FileDiff {
    const file = diff.files.find((candidate) => candidate.path === filePath);
    if (file === undefined) {
        throw new Error(`slice has no file ${filePath}`);
    }
    return file;
}

describe('local host iteration history', () => {
    let root: string;
    let fake: FakeVcs;
    let iterations: LocalIterationsStore;

    beforeEach(() => {
        root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-iters-')));
        fake = new FakeVcs({ root, prefix: PREFIX });
        iterations = memoryIterationsStore();
        fake.commit(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 2;', 'const c = 3;', ''].join('\n'));
        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 22;', 'const c = 3;', ''].join('\n'));
    });

    afterEach(() => {
        fs.rmSync(root, { recursive: true, force: true });
    });

    function makeHost(overrides: Partial<LocalHostOptions> = {}): LocalHost {
        return new LocalHost({
            prKey: 'local-git-app-0badc0de',
            vcs: scriptedVcs(fake.runner),
            projectDir: fake.projectDir,
            base: null,
            branch: fake.branch,
            threads: memoryThreadsStore(),
            iterations,
            pollIntervalMs: 600_000,
            ...overrides,
        });
    }

    it('an edit creates the next iteration and keeps the previous one in the list', async () => {
        const host = makeHost();
        const first = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 222;', 'const c = 3;', ''].join('\n'));
        await host.refresh();
        const second = (await host.getDiff()).diffId;

        expect(second).not.toBe(first);
        expect((await host.listIterations()).map((iteration) => [iteration.diffId, iteration.status])).toEqual([
            [first, 'previous'],
            [second, 'active'],
        ]);
        // The diff itself identifies the reviewed working-tree side: short identical heads must not occur.
        const heads = (await host.listIterations()).map((iteration) => iteration.headCommit.slice(0, 7));
        expect(new Set(heads).size).toBe(2);
    });

    it('sends the full list to subscribers on every change', async () => {
        const host = makeHost();
        const seen: string[][] = [];
        const stop = host.watchIterations((list) => seen.push(list.map((iteration) => iteration.diffId)));
        const first = (await host.getDiff()).diffId;
        await expect.poll(() => seen.length).toBeGreaterThan(0);

        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');
        await host.refresh();
        const second = (await host.getDiff()).diffId;

        await expect.poll(() => seen.at(-1)).toEqual([first, second]);
        stop();
    });

    it('preserves history when the host is recreated with the same storage', async () => {
        const first = (await makeHost().getDiff()).diffId;
        fake.writeDisk(`${PREFIX}/src/b.ts`, 'const b = 1;\n');

        const revived = makeHost();
        const second = (await revived.getDiff()).diffId;

        expect((await revived.listIterations()).map((iteration) => iteration.diffId)).toEqual([first, second]);
    });

    it('restores the same iteration on restart with the same tree instead of creating a new one', async () => {
        const first = await makeHost().listIterations();

        const revived = await makeHost().listIterations();

        expect(revived).toEqual(first);
    });

    it('slices a modification with a patch that the hunk parser can read', async () => {
        const host = makeHost();
        const base = (await host.getDiff()).diffId;
        fake.writeDisk(`${PREFIX}/src/a.ts`, ['const a = 1;', 'const b = 222;', 'const c = 3;', ''].join('\n'));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base, head });

        expect(() => prDiffSchema.parse(slice)).not.toThrow();
        expect(slice.diffId).toBe(head);
        expect(slice.baseCommit).toBe(base);
        const file = fileOf(slice, 'src/a.ts');
        expect(file.changeType).toBe('modify');
        expect(file.fileId).toBe(`slice:${base.slice(0, 12)}:${head.slice(0, 12)}:src/a.ts`);
        expect(file).toMatchObject({ additions: 1, deletions: 1, binary: false });
        // The slice patch uses the same parser as an iteration patch: line numbers refer to the new side.
        const changed = [...walkPatch(file.patch ?? '')].filter((line) => line.changed && line.new !== null);
        expect(changed.map((line) => [line.new, line.raw])).toEqual([[2, '+const b = 222;']]);
    });

    it('slices additions and deletions with the file present on only one side', async () => {
        const host = makeHost();
        fake.commit(`${PREFIX}/src/gone.ts`, 'export const gone = 1;\n');
        fake.writeDisk(`${PREFIX}/src/gone.ts`, 'export const gone = 2;\n');
        await host.refresh();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/src/fresh.ts`, 'export const fresh = 1;\n');
        fake.removeDisk(`${PREFIX}/src/gone.ts`);
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base, head });

        const added = fileOf(slice, 'src/fresh.ts');
        expect(added.changeType).toBe('add');
        expect(added.patch).toContain('--- /dev/null');
        expect(added.patch).toContain('+export const fresh = 1;');
        expect(added).toMatchObject({ additions: 1, deletions: 0 });

        const removed = fileOf(slice, 'src/gone.ts');
        expect(removed.changeType).toBe('delete');
        expect(removed.patch).toContain('+++ /dev/null');
        expect(removed).toMatchObject({ additions: 0, deletions: 1 });

        // A file unchanged between iterations does not appear in the slice.
        expect(slice.files.map((file) => file.path)).toEqual(['src/fresh.ts', 'src/gone.ts']);
    });

    it('includes a binary side in the slice without a patch', async () => {
        const host = makeHost();
        fake.writeDisk(`${PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x02]));
        await host.refresh();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x03]));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const file = fileOf(await host.getDiff({ base, head }), 'cache.bin');
        expect(file).toMatchObject({ changeType: 'modify', binary: true, patch: null });
    });

    it('includes a side over the size limit in the slice without contents', async () => {
        const host = makeHost();
        const base = (await host.getDiff()).diffId;

        fake.writeDisk(`${PREFIX}/dump.csv`, Buffer.alloc(MAX_FILE_BYTES + 1, 0x41));
        await host.refresh();
        const head = (await host.getDiff()).diffId;

        const file = fileOf(await host.getDiff({ base, head }), 'dump.csv');
        expect(file).toMatchObject({ changeType: 'add', binary: true, patch: null });
    });

    it('returns an empty slice for an iteration compared with itself', async () => {
        const host = makeHost();
        const only = (await host.getDiff()).diffId;

        const slice = await host.getDiff({ base: only, head: only });

        expect(slice.files).toEqual([]);
        expect(slice.diffId).toBe(only);
    });

    it('keeps review working when history storage fails: the diff remains, slices are unavailable', async () => {
        const logs: string[] = [];
        const broken: LocalIterationsStore = {
            read: () => Promise.reject(new Error('index.json: EACCES')),
            append: () => Promise.reject(new Error('ENOSPC: no space left on device')),
            blob: () => Promise.resolve(null),
        };
        const host = makeHost({ iterations: broken, log: (message) => logs.push(message) });

        const diff = await host.getDiff();
        expect(diff.files.map((file) => file.path)).toContain('src/a.ts');
        await expect(host.getPr()).resolves.toMatchObject({ id: 'local-git-app-0badc0de' });
        // The host does not know previous iterations: only the active one remains, and slices for it are rejected.
        expect(await host.listIterations()).toMatchObject([{ diffId: diff.diffId, status: 'active' }]);
        await expect(host.getDiff({ base: 'diff-0', head: diff.diffId })).rejects.toThrow('is unknown');

        expect(logs.join('\n')).toContain('could not read iteration history: index.json: EACCES');
        expect(logs.join('\n')).toContain(`could not record iteration ${diff.diffId} in history: ENOSPC`);
    });

    it('records a file rewritten between diff and read without contents', async () => {
        // The edit reaches disk after the diff: the patch describes the old state, but the file is already new.
        let raced = false;
        const racing: CommandRunner = async (args) => {
            const outcome = await fake.runner(args);
            if (args.includes('--name-status') && !raced) {
                raced = true;
                fake.writeDisk(
                    `${PREFIX}/src/a.ts`,
                    ['const a = 1;', 'const b = 2222222;', 'const c = 3;', ''].join('\n'),
                );
            }
            return outcome;
        };
        const host = makeHost({ vcs: scriptedVcs(racing) });

        const base = (await host.getDiff()).diffId;
        const recorded = (await iterations.read()).at(-1)?.files.find((file) => file.path === 'src/a.ts');
        expect(recorded?.blob).toBeNull();

        // This side's contents are unknown: the slice shows the file without a patch, and its
        // viewed mark does not carry over.
        await host.refresh();
        const head = (await host.getDiff()).diffId;
        expect(fileOf(await host.getDiff({ base, head }), 'src/a.ts')).toMatchObject({
            binary: true,
            patch: null,
        });
    });

    it('rejects an unknown iteration permanently', async () => {
        const host = makeHost();
        const head = (await host.getDiff()).diffId;

        await expect(host.getDiff({ base: 'no-such-iteration', head })).rejects.toMatchObject({
            code: 'bad_request',
            message: 'iteration no-such-iteration is unknown to the local host',
        });
        await expect(host.getDiff({ base: head, head: 'no-such-iteration' })).rejects.toThrow('is unknown');
    });
});

describe('iteration history storage', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-history-')));
    });

    afterEach(() => {
        fs.rmSync(dir, { recursive: true, force: true });
    });

    function recordOf(index: number): { record: LocalIterationRecord; blobs: Map<string, Uint8Array> } {
        const text = `line ${String(index)}\n`;
        const blob = String(index).padStart(64, '0');
        return {
            record: {
                diffId: `diff-${String(index)}`,
                baseCommit: 'base',
                headCommit: `diff-${String(index)}`,
                createdAt: new Date(Date.UTC(2026, 8, 12, 0, 0, index)).toISOString(),
                files: [{ path: 'src/a.ts', changeType: 'modify', kind: 'text', hash: `hash-${String(index)}`, blob }],
            },
            blobs: new Map([[blob, new TextEncoder().encode(text)]]),
        };
    }

    it('trims old iterations and removes their blobs at the history limit', async () => {
        const store = fileIterationsStore(dir);
        for (let index = 0; index < MAX_LOCAL_ITERATIONS + 5; index += 1) {
            const { record, blobs } = recordOf(index);
            await store.append(record, blobs);
        }

        const history = await store.read();
        expect(history).toHaveLength(MAX_LOCAL_ITERATIONS);
        expect(history[0]?.diffId).toBe('diff-5');
        expect(fs.readdirSync(path.join(dir, 'blobs'))).toHaveLength(MAX_LOCAL_ITERATIONS);
        expect(await store.blob('0'.padStart(64, '0'))).toBeNull();
        expect(await store.blob('5'.padStart(64, '0'))).toBe('line 5\n');
    });

    it('moves a repeated diffId to the end instead of duplicating the iteration', async () => {
        const store = fileIterationsStore(dir);
        const first = recordOf(1);
        const second = recordOf(2);
        await store.append(first.record, first.blobs);
        await store.append(second.record, second.blobs);
        await store.append(first.record, first.blobs);

        expect((await store.read()).map((record) => record.diffId)).toEqual(['diff-2', 'diff-1']);
    });

    it('restricts history permissions to the owner and does not reset a corrupt index', async () => {
        const store = fileIterationsStore(dir);
        const { record, blobs } = recordOf(1);
        await store.append(record, blobs);

        const indexPath = path.join(dir, 'index.json');
        expect(fs.statSync(indexPath).mode & 0o777).toBe(0o600);
        expect(fs.statSync(path.join(dir, 'blobs', record.files[0]?.blob ?? '')).mode & 0o777).toBe(0o600);

        fs.writeFileSync(indexPath, 'not json');
        await expect(fileIterationsStore(dir).read()).rejects.toThrow('is not valid JSON');
    });

    it('fails on an unreadable index instead of returning empty history', async () => {
        const store = fileIterationsStore(dir);
        const first = recordOf(1);
        await store.append(first.record, first.blobs);

        // A directory at the index path: reading fails with `EISDIR`, not a missing-file error.
        const indexPath = path.join(dir, 'index.json');
        fs.rmSync(indexPath);
        fs.mkdirSync(indexPath);

        await expect(store.read()).rejects.toThrow('EISDIR');
        // Writing starts by reading: it must not silently replace history with a single record.
        const second = recordOf(2);
        await expect(store.append(second.record, second.blobs)).rejects.toThrow('EISDIR');
    });
});
