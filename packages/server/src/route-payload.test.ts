import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, PrDiff, PrMeta, Thread } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import type { RegenerationBudgets, RoutePayloadContext, RouteTaskContext } from './route-payload.js';
import {
    CONTEXT_BUDGET_BYTES,
    interdiffContext,
    prDiffPayload,
    RoutePayloadWriter,
    sectionPlanContext,
} from './route-payload.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import { indexDiff } from './route/diff-index.js';
import {
    mediumDiff,
    mediumDiffV2,
    mediumInterdiffV1V2,
    mediumRawResults,
    mediumReadySnapshot,
    mediumThreadsV2,
} from './route/fixture-support.js';
import { diffKeyOf, PR_DIFF_FILE, SharedPayloadStore } from './shared-payload.js';

/**
 * Route generation task payload on the `medium` fixture diff: 21 files, 868
 * changed lines, including a generated lockfile and 3 test files. These are exactly the roles
 * that budget truncation distinguishes.
 */

const META: PrMeta = {
    id: '4242',
    url: 'https://github.com/quillmart/quillmart/pull/4242',
    title: 'Order editing window',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false, avatarUrl: null },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'Awaiting review',
    checks: null,
    updatedAt: '2026-08-20T10:00:00.000Z',
    capabilities: { publishVerdicts: ['comment', 'ship', 'sticky_ship', 'request_changes'], fileViewedSync: false, fileContent: true, commentIssues: true, commentResolve: true, editPublished: true, iterations: false, blobs: false },
    verdicts: [],
    viewer: { login: 'bob', displayName: null, bot: false, avatarUrl: null },
};

/** Directory for separate patch files when printing without disk access. Stubs only name it. */
const PATCHES_DIR = '/payload/shared/diff/base-head/patches';

/** Builder context: fixture diff and PR metadata. The default generation language is Russian. */
function context(diff: PrDiff = mediumDiff(), locale: Locale = 'ru'): RouteTaskContext {
    return { diff, meta: META, locale };
}

/** Stop intents from the raw fixture skeleton, matching `RouteStore.stopIntents`. */
function intents(): Map<number, string> {
    return new Map(mediumRawResults().skeleton.stops.map((stop, index) => [index + 1, stop.intent]));
}

/** Shared diff file text without separate patches or a cap. */
function prDiffContext(payloadContext: RoutePayloadContext, budgetBytes: number, patchesDir: string): string {
    return prDiffPayload(payloadContext, budgetBytes, patchesDir).content;
}

/** Full context size without truncation, the baseline for budget tests. */
function fullSize(): number {
    return Buffer.byteLength(prDiffContext(context(), CONTEXT_BUDGET_BYTES, PATCHES_DIR), 'utf8');
}

/** Patch line with a gutter: `old new | line`. */
const GUTTER = /^ *(\d+|\.) +(\d+|\.) \| (.*)$/gm;
/** Patch lines outside a hunk have no line numbers and must not get any. */
const OUTSIDE_HUNK = /^(diff --git |index |--- |\+\+\+ |@@ |new file |deleted file |similarity |rename |\\ |$)/;

/** Printed patch bodies by file path. Truncated blocks are excluded. */
function printedPatches(text: string): Map<string, string> {
    const blocks = new Map<string, string>();
    let current: string | null = null;
    let body: string[] = [];
    const remember = (): void => {
        const printed = body.join('\n').trim();
        if (current !== null && printed.startsWith('```')) {
            blocks.set(current, printed);
        }
    };

    for (const line of text.split('\n')) {
        const header = /^### File \d+\. `([^`]+)` /.exec(line);
        if (header === null) {
            body.push(line);
            continue;
        }
        remember();
        current = header[1] ?? '';
        body = [];
    }
    remember();
    return blocks;
}

/** Files whose patches are marked truncated but not written separately. */
function omittedPaths(text: string): string[] {
    return [...text.matchAll(/^### File \d+\. `([^`]+)` .*\n\npatch omitted/gm)].map((match) => match[1] ?? '');
}

/** Files whose patches are written to separate files. */
function movedPaths(text: string): string[] {
    return [...text.matchAll(/^### File \d+\. `([^`]+)` .*\n\npatch moved/gm)].map((match) => match[1] ?? '');
}

/** All files whose patches are absent from the shared diff file, both marked and written separately. */
function droppedPaths(text: string): string[] {
    return [...text.matchAll(/^### File \d+\. `([^`]+)` .*\n\npatch (omitted|moved)/gm)].map((match) => match[1] ?? '');
}

const TEST_FILES = [
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/__tests__/edit-policy.test.ts',
    'services/orders/src/domain/__tests__/edit-window.test.ts',
];

describe('shared diff context', () => {
    it('includes PR metadata, the full file list and every complete patch', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES, PATCHES_DIR);

        expect(text).toContain('- Title: Order editing window');
        expect(text).toContain('- Author: alice (Alice Ingram)');
        expect(text).toContain('- Branches: alice/edit-window -> main');
        expect(text).toContain(`- Diff: base ${diff.baseCommit} -> head ${diff.headCommit}`);
        expect(text).toContain('- Volume: 21 files, +812 / -56 lines');

        for (const file of diff.files) {
            expect(text).toContain(`\`${file.path}\``);
            for (const line of (file.patch ?? '').split('\n')) {
                // The patch is printed line by line with a number gutter, so it cannot be found as a whole.
                expect(text).toContain(`| ${line}`);
            }
        }
        expect(omittedPaths(text)).toEqual([]);
    });

    it('prints patch line numbers for both sides, matching those accepted by the validator', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES, PATCHES_DIR);
        const index = indexDiff(diff);

        expect(text).toContain('`old new | line`');

        // Changed line numbers printed in the gutter must match what the validator
        // considers a changed line in the file. A mismatch makes model anchors fail acceptance.
        let checked = 0;
        for (const [filePath, body] of printedPatches(text)) {
            const printed = { old: new Set<number>(), new: new Set<number>() };
            for (const [, oldCell = '', newCell = '', raw = ''] of body.matchAll(GUTTER)) {
                if (oldCell === '.' && newCell === '.') {
                    expect(raw, `${filePath}: a line without numbers must be outside a hunk`).toMatch(OUTSIDE_HUNK);
                    continue;
                }
                const prefix = raw.slice(0, 1);
                if (prefix === '+') {
                    expect(oldCell, `${filePath}: an added line has no old number`).toBe('.');
                    printed.new.add(Number(newCell));
                } else if (prefix === '-') {
                    expect(newCell, `${filePath}: a deleted line has no new number`).toBe('.');
                    printed.old.add(Number(oldCell));
                }
            }

            const expected = index.get(filePath);
            expect(expected, `${filePath} is missing from the diff index`).toBeDefined();
            expect([...printed.old].sort()).toEqual([...(expected?.old ?? [])].sort());
            expect([...printed.new].sort()).toEqual([...(expected?.new ?? [])].sort());
            checked += 1;
        }
        expect(checked).toBe(diff.files.filter((file) => file.patch !== null).length);
    });

    it('builds context without PR metadata when the host does not provide it', () => {
        const text = prDiffContext({ diff: mediumDiff(), meta: null }, CONTEXT_BUDGET_BYTES, PATCHES_DIR);

        expect(text).toContain('no pull request metadata');
        expect(text).toContain('- Volume: 21 files');
        expect(omittedPaths(text)).toEqual([]);
    });

    it('truncates to fit the budget while keeping the complete file list', () => {
        const budget = 12_000;
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), budget, PATCHES_DIR);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(droppedPaths(text).length).toBeGreaterThan(0);
        // The coverage rule requires every file to be known, so never truncate the list.
        for (const file of diff.files) {
            expect(text).toContain(`| \`${file.path}\` |`);
        }
    });

    it('names the file, size and obligation to place its ranges in the truncation marker', () => {
        const text = prDiffContext(context(), 12_000, PATCHES_DIR);
        const lock = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');

        expect(omittedPaths(text)).toContain('pnpm-lock.yaml');
        expect(text).toContain(
            `patch omitted — ${String((lock?.additions ?? 0) + (lock?.deletions ?? 0))} lines, ` +
                'use the stats above; the file still must be placed',
        );
    });

    it('truncates generated files first because the team does not require their review', () => {
        // Set the budget 1 byte below full context to truncate exactly 1 file, the largest generated file.
        const text = prDiffContext(context(), fullSize() - 1, PATCHES_DIR);

        expect(omittedPaths(text)).toEqual(['pnpm-lock.yaml']);
    });

    it('truncates tests after generated files, largest first, and keeps source files', () => {
        const diff = mediumDiff();
        const generated = diff.files.filter((file) => file.generated).map((file) => file.path);
        // Reduce the budget byte by byte until all generated files are truncated. The largest test goes next.
        let text = prDiffContext(context(diff), fullSize() - 1, PATCHES_DIR);
        while (droppedPaths(text).length <= generated.length) {
            text = prDiffContext(context(diff), Buffer.byteLength(text, 'utf8') - 1, PATCHES_DIR);
        }

        const dropped = droppedPaths(text);
        expect(dropped).toEqual(expect.arrayContaining(generated));
        expect(dropped).toContain('services/orders/src/domain/__tests__/edit-window.test.ts');
        expect(dropped).toHaveLength(generated.length + 1);
    });

    it('keeps the file list but no patches when the budget is below the non-truncatable part', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), 10, PATCHES_DIR);

        // Binary files have no patch, so there is nothing to truncate.
        expect(droppedPaths(text)).toHaveLength(diff.files.filter((file) => file.patch !== null).length);
        expect(text).toContain('| `pnpm-lock.yaml` |');
    });
});

describe('section task plan', () => {
    const stops = mediumReadySnapshot().stops;

    it('includes the full plan with target stops distinguished and intents preserved', () => {
        const text = sectionPlanContext([3], stops, intents());

        expect(text).toContain('# Route plan (fixed by the server)');
        for (const stop of stops) {
            expect(text).toContain(stop.title);
        }
        expect(text).toContain('| 3 | medium |');
        expect(text).toContain('**your target**');
        expect(text).toContain(`### Stop 3 — medium — ${stops[2]?.title ?? ''}`);
        // Quote the target stop intent. List neighboring intents as items for transitions.
        expect(text).toContain(`> ${intents().get(3) ?? ''}`);
        expect(text).toContain(`- stop 1 (high) ${stops[0]?.title ?? ''} — ${intents().get(1) ?? ''}`);
        // The server synthesizes "Other", leaving nothing for the model to fill.
        expect(text).toContain('synthetic, filled by the server');
    });

    it('omits the diff from the plan because it is shared at its own path', () => {
        const text = sectionPlanContext([3], stops, intents());

        expect(text).not.toContain('## Patches');
        expect(text).not.toContain('| file # | file | change | +/- | notes |');
        expect(text).not.toMatch(/^ *(\d+|\.) +(\d+|\.) \| /m);
        for (const file of mediumDiff().files) {
            expect(text).not.toContain(`\`${file.path}\``);
        }
    });

    it('targets every stop in a multi-stop batch and treats the rest as neighbors', () => {
        const text = sectionPlanContext([1, 2], stops, intents());

        expect(text).toContain('### Stop 1 —');
        expect(text).toContain('### Stop 2 —');
        expect(text).not.toContain('### Stop 3 —');
        expect(text).toContain(`- stop 3 (medium) ${stops[2]?.title ?? ''}`);
    });

    it('prints stop numbers as schema numbers, not two-digit file numbers', () => {
        const plan = sectionPlanContext([3], stops, intents());

        // `planIndex` is z.number(), so the schema rejects "03" in the model JSON.
        expect(plan).not.toMatch(/^\| 0\d \|/m);
        expect(plan).not.toMatch(/### Stop 0\d /);
        expect(plan).toContain('`"planIndex": 3`');
        // Only files retain two-digit numbering, and the columns have different names.
        expect(plan).toContain('| stop # | tier | title | |');
        expect(prDiffContext(context(), CONTEXT_BUDGET_BYTES, PATCHES_DIR)).toContain('| file # | file | change | +/- | notes |');
    });
});

describe('single truncation policy for the shared diff', () => {
    it('keeps source files in the shared file longer than tests because the plan uses source files', () => {
        const diff = mediumDiff();
        const machine = diff.files.filter((file) => file.generated).length;
        // Reduce the budget until the first file after generated files and tests is dropped. It is a source file.
        let text = prDiffContext(context(diff), fullSize() - 1, PATCHES_DIR);
        while (droppedPaths(text).length <= machine + TEST_FILES.length) {
            const dropped = droppedPaths(text);
            // Until all tests are truncated, no source files appear among truncated files.
            expect(dropped.length - machine).toBeLessThanOrEqual(TEST_FILES.length);
            expect(dropped.filter((file) => !TEST_FILES.includes(file) && !isGenerated(diff, file))).toEqual([]);
            text = prDiffContext(context(diff), Buffer.byteLength(text, 'utf8') - 1, PATCHES_DIR);
        }

        const dropped = droppedPaths(text);
        expect(dropped).toEqual(expect.arrayContaining(TEST_FILES));
        // The largest source file by printed block size is the edit window documentation.
        expect(dropped).toContain('services/orders/docs/edit-window.md');
    });

    it('treats a generated snapshot test as a test, truncating it after generated files and writing it separately', () => {
        // The host correctly marks the snapshot as generated, but the digest needs its lines for testPath/testLine.
        const diff = mediumDiff();
        const generatedTest = diff.files.map((file) =>
            file.path.includes('__tests__') ? { ...file, generated: true } : file,
        );
        const marked = { ...diff, files: generatedTest };
        const budget = Buffer.byteLength(prDiffContext(context(marked), 1e9, PATCHES_DIR), 'utf8') - 1;

        expect(droppedPaths(prDiffContext(context(marked), budget, PATCHES_DIR))).toEqual(['pnpm-lock.yaml']);

        const tight = prDiffPayload(context(marked), 20_000, PATCHES_DIR);
        expect(movedPaths(tight.content)).toEqual(expect.arrayContaining(TEST_FILES));
        expect(omittedPaths(tight.content).filter((file) => file.includes('__tests__'))).toEqual([]);
        expect(tight.cap.machineFiles).toBe(diff.files.filter((file) => file.generated).length);
    });
});

describe('separate patch files', () => {
    const budget = 20_000;

    it('writes a truncated non-generated patch to its own file and names the path in the stub', () => {
        const built = prDiffPayload(context(), budget, PATCHES_DIR);
        const moved = movedPaths(built.content);

        expect(moved.length).toBeGreaterThan(0);
        expect(built.patches).toHaveLength(moved.length);
        for (const patch of built.patches) {
            expect(path.basename(patch.name)).toBe(patch.name);
            expect(built.content).toContain(`\`${path.join(PATCHES_DIR, patch.name)}\``);
        }
        expect(built.patches.map((patch) => patch.name)).toContain('08-edit-window.test.ts.md');
        expect(built.content).toContain('read it when you need this file');
    });

    it('uses the same gutter line by line in the separate file as in the shared file', () => {
        const full = printedPatches(prDiffContext(context(), CONTEXT_BUDGET_BYTES, PATCHES_DIR));
        const built = prDiffPayload(context(), budget, PATCHES_DIR);
        const moved = movedPaths(built.content);

        for (const [index, patch] of built.patches.entries()) {
            const filePath = moved[index] ?? '';
            const printed = printedPatches(patch.content);
            expect([...printed.keys()]).toEqual([filePath]);
            expect(printed.get(filePath)).toBe(full.get(filePath));
            // The gutter and anchor header matches the shared file.
            expect(patch.content).toContain('`old new | line`');
            expect(patch.content).toContain('Line anchors of a stop are validated against exactly these printed numbers');
        }
    });

    it('does not give a generated non-test file a separate patch file because it needs no review', () => {
        const diff = mediumDiff();
        const generated = diff.files.filter((file) => file.generated).map((file) => file.path);
        const built = prDiffPayload(context(diff), budget, PATCHES_DIR);

        expect(omittedPaths(built.content)).toEqual(expect.arrayContaining(generated));
        expect(omittedPaths(built.content)).toHaveLength(generated.length);
        expect(movedPaths(built.content).filter((file) => generated.includes(file))).toEqual([]);
        for (const patch of built.patches) {
            expect(generated.some((file) => patch.content.includes(`\`${file}\``))).toBe(false);
        }
    });

    it('keeps the shared file within budget including stubs', () => {
        // The minimum is the header, file list and markers for all patches. A smaller budget is impossible.
        const floor = Buffer.byteLength(prDiffContext(context(), 10, PATCHES_DIR), 'utf8');
        for (const tight of [floor, floor + 2_000, 20_000, fullSize() - 1]) {
            const built = prDiffPayload(context(), tight, PATCHES_DIR);
            expect(Buffer.byteLength(built.content, 'utf8')).toBeLessThanOrEqual(tight);
        }
    });

    it('reverts some stubs to markers without files when hundreds of patch stubs exceed the budget', () => {
        const diff = mediumDiff();
        const source = diff.files.find((file) => file.patch !== null && !file.generated && !TEST_FILES.includes(file.path));
        if (source === undefined) {
            throw new Error('medium fixture has no regular file with a text patch');
        }
        const files = Array.from({ length: 300 }, (_, index) => {
            const count = 20 + (index % 40);
            const lines = Array.from({ length: count }, (_, line) => `+export const value${String(line)} = ${String(line)};`);
            return {
                ...source,
                fileId: `many-${String(index)}`,
                path: `src/many/file-${String(index)}.ts`,
                oldPath: null,
                changeType: 'add' as const,
                additions: count,
                deletions: 0,
                patch: `@@ -0,0 +1,${String(count)} @@\n${lines.join('\n')}\n`,
            };
        });
        const additions = new Map(files.map((file) => [file.path, file.additions]));
        const many = context({ ...diff, files });
        // The path is as long as the real directory path, under a key made of 2 full commit hashes.
        const patchesDir = path.join(
            '/home/reviewer/.sherpa/prs/fixture-1/payload/shared/diff',
            `${'a'.repeat(40)}-${'b'.repeat(40)}`,
            'patches-v2',
        );
        const floor = Buffer.byteLength(prDiffContext(many, 10, patchesDir), 'utf8');
        const budget = floor + 10_000;

        const built = prDiffPayload(many, budget, patchesDir);

        const moved = movedPaths(built.content).map((file) => additions.get(file) ?? 0);
        const omitted = omittedPaths(built.content).map((file) => additions.get(file) ?? 0);
        expect(Buffer.byteLength(built.content, 'utf8')).toBeLessThanOrEqual(budget);
        expect(moved.length).toBeGreaterThan(0);
        expect(omitted.length).toBeGreaterThan(0);
        // Reverting saves about 1 path length per patch, so large patches keep their own files.
        expect(Math.min(...moved)).toBeGreaterThanOrEqual(Math.max(...omitted));
        // Only a patch whose stub remains in the shared file has its own file.
        expect(built.patches).toHaveLength(moved.length);
    });

    it('marks a patch larger than the entire budget as truncated without a separate file', () => {
        const diff = mediumDiff();
        const source = diff.files.find((file) => file.patch !== null && !file.generated && !TEST_FILES.includes(file.path));
        if (source === undefined) {
            throw new Error('medium fixture has no regular file with a text patch');
        }
        const lines = Array.from({ length: 2_000 }, (_, index) => `+export const value${String(index)} = ${String(index)};`);
        const huge = {
            ...source,
            fileId: 'huge-source',
            path: 'src/huge-source.ts',
            oldPath: null,
            changeType: 'add' as const,
            additions: lines.length,
            deletions: 0,
            patch: `@@ -0,0 +1,${String(lines.length)} @@\n${lines.join('\n')}\n`,
        };
        const built = prDiffPayload(context({ ...diff, files: [...diff.files, huge] }), budget, PATCHES_DIR);

        expect(omittedPaths(built.content)).toContain(huge.path);
        expect(movedPaths(built.content)).not.toContain(huge.path);
        expect(built.patches.some((patch) => patch.content.includes(`\`${huge.path}\``))).toBe(false);
        expect(built.cap.truncated).toBe(true);
    });

    it('does not write interdiff patches separately because they cannot provide anchors', () => {
        const text = interdiffContext(mediumInterdiffV1V2(), 2_000);

        expect(omittedPaths(text).length).toBeGreaterThan(0);
        expect(movedPaths(text)).toEqual([]);
    });

    it('truncates generated files first and tests last in an interdiff', () => {
        // The PR diff also works as a slice here. Only file roles matter.
        const diff = mediumDiff();
        const full = Buffer.byteLength(interdiffContext(diff, 1e9), 'utf8');
        expect(omittedPaths(interdiffContext(diff, full - 1))).toEqual(['pnpm-lock.yaml']);

        // Every non-test file that is eventually truncated goes before the first test.
        const sources = omittedPaths(interdiffContext(diff, 10)).filter((file) => !TEST_FILES.includes(file));
        let text = interdiffContext(diff, full - 1);
        while (omittedPaths(text).every((file) => !TEST_FILES.includes(file))) {
            text = interdiffContext(diff, Buffer.byteLength(text, 'utf8') - 1);
        }
        expect(omittedPaths(text)).toEqual(expect.arrayContaining(sources));
    });
});

function isGenerated(diff: PrDiff, filePath: string): boolean {
    return diff.files.find((file) => file.path === filePath)?.generated ?? false;
}

describe('generation cap', () => {
    it('covers everything without truncation when the entire diff fits', () => {
        const cap = prDiffPayload(context(), CONTEXT_BUDGET_BYTES, PATCHES_DIR).cap;

        expect(cap.filesTotal).toBe(mediumDiff().files.length);
        expect(cap.filesCovered).toBe(cap.filesTotal);
        expect(cap.machineFiles).toBe(0);
        expect(cap.truncated).toBe(false);
    });

    it('counts the only dropped generated file as generated, without truncation', () => {
        // The generated lockfile is the first truncation candidate. The budget is short by exactly its size.
        const budget = fullSize() - 1;
        const cap = prDiffPayload(context(), budget, PATCHES_DIR).cap;

        expect(omittedPaths(prDiffContext(context(), budget, PATCHES_DIR))).toEqual(['pnpm-lock.yaml']);
        expect(cap.filesCovered).toBe(cap.filesTotal - 1);
        expect(cap.machineFiles).toBe(1);
        expect(cap.truncated).toBe(false);
    });

    it('builds the plan from a partial diff when a non-generated file is truncated', () => {
        const budget = 20_000;
        const cap = prDiffPayload(context(), budget, PATCHES_DIR).cap;
        const omitted = droppedPaths(prDiffContext(context(), budget, PATCHES_DIR));

        expect(cap.filesCovered).toBe(cap.filesTotal - omitted.length);
        expect(cap.machineFiles).toBeLessThan(omitted.length);
        expect(cap.truncated).toBe(true);
    });
});

describe('writing payload to disk', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-payload-'));
        payloadDir = path.join(root, 'payload', 'route');
        sharedDir = path.join(root, 'payload', 'shared');
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    function writer(budgetBytes?: number): RoutePayloadWriter {
        const shared = new SharedPayloadStore(sharedDir, () => []);
        return new RoutePayloadWriter({
            payloadDir,
            shared,
            ...(budgetBytes === undefined ? {} : { budgetBytes }),
        });
    }

    it('gives the skeleton task shared guide and diff paths and its own schema', () => {
        const input = writer().skeletonTask(context());

        expect(input.type).toBe('route.skeleton');
        expect(input.priority).toBe('background');
        expect(input.contextFiles).toHaveLength(2);
        for (const file of input.contextFiles) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
        }

        const [guide, pr] = input.contextFiles;
        expect(guide).toMatch(/shared[/\\]guides[/\\]skeleton-guide-[0-9a-f]{8}\.md$/);
        expect(pr?.startsWith(sharedDir)).toBe(true);
        expect(path.basename(pr ?? '')).toBe(PR_DIFF_FILE);
        expect(fs.readFileSync(guide ?? '', 'utf8')).toContain('# Task: plan the review route');
        expect(fs.readFileSync(pr ?? '', 'utf8')).toContain('## Changed files (21, complete list)');
        expect(input.instructions).toContain('Plan the review route');
        // The skeleton has no context of its own. The generation directory holds only the result schema.
        expect(fs.readdirSync(path.dirname(input.resultSchemaFile ?? ''))).toEqual([
            'route-skeleton-result.schema.json',
        ]);
    });

    it('uses the same result schema JSON as generateJsonSchemas', () => {
        const builder = writer();
        const skeleton = builder.skeletonTask(context());
        const sections = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        const schemas = generateJsonSchemas();
        const readSchema = (file: string | undefined): unknown => JSON.parse(fs.readFileSync(file ?? '', 'utf8'));
        expect(readSchema(skeleton.resultSchemaFile)).toEqual(schemas.routeSkeletonResult);
        expect(readSchema(sections.resultSchemaFile)).toEqual(schemas.routeSectionResult);
    });

    it('puts target numbers in section instructions and the plan in its own file without patches', () => {
        const input = writer().sectionTask(context(), [3, 4], mediumReadySnapshot().stops, intents());

        expect(input.type).toBe('route.section');
        expect(input.instructions).toContain('3, 4');
        expect(input.contextFiles).toHaveLength(3);
        const plan = input.contextFiles[2] ?? '';
        expect(plan.startsWith(payloadDir)).toBe(true);
        expect(path.basename(plan)).toBe('section-03-04-plan.md');
        const text = fs.readFileSync(plan, 'utf8');
        expect(text).toContain('# Route plan');
        expect(text).not.toContain('## Patches');
    });

    it('makes the skeleton and sections read the same shared diff', () => {
        const builder = writer();
        const skeleton = builder.skeletonTask(context());
        const first = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        const second = builder.sectionTask(context(), [2], mediumReadySnapshot().stops, intents());

        expect(first.contextFiles[1]).toBe(skeleton.contextFiles[1]);
        expect(second.contextFiles[1]).toBe(skeleton.contextFiles[1]);
        expect(first.contextFiles[0]).toBe(second.contextFiles[0]);
        expect(fs.readdirSync(path.dirname(skeleton.contextFiles[1] ?? ''))).toEqual([PR_DIFF_FILE]);
    });

    it('truncates context on disk to the builder budget', () => {
        const input = writer(12_000).skeletonTask(context());
        const text = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12_000);
        expect(text).toContain('patch omitted');
    });

    it('stores separate patches privately under the diff key next to the shared file', () => {
        const builder = writer(12_000);
        const input = builder.skeletonTask(context());
        const prDiff = input.contextFiles[1] ?? '';
        const text = fs.readFileSync(prDiff, 'utf8');
        const patchesDir = path.join(path.dirname(prDiff), 'patches-v2');
        const named = [...text.matchAll(/^patch moved to `([^`]+)`/gm)].map((match) => match[1] ?? '');

        expect(named.length).toBe(movedPaths(text).length);
        expect(named.length).toBeGreaterThan(0);
        expect(fs.readdirSync(patchesDir).sort()).toEqual(named.map((file) => path.basename(file)).sort());
        for (const file of named) {
            expect(path.dirname(file)).toBe(patchesDir);
            expect(fs.readFileSync(file, 'utf8')).toContain('## Patches');
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }
        expect(fs.statSync(patchesDir).mode & 0o777).toBe(0o700);
        // The task still includes only the shared file, which provides paths to the separate files.
        expect(input.contextFiles.filter((file) => file.startsWith(patchesDir))).toEqual([]);
        // Calculate the cap with the same stub paths as the written file.
        expect(builder.generationCap(context())).toEqual(
            prDiffPayload(context(), 12_000, patchesDir).cap,
        );
    });

    it('does not reuse an older print under the same key because the filename includes the print version', () => {
        // A task from the previous server holds the key, so cleanup kept the directory.
        const stale = path.join(sharedDir, 'diff', diffKeyOf(mediumDiff()), 'pr-diff.md');
        fs.mkdirSync(path.dirname(stale), { recursive: true });
        fs.writeFileSync(stale, 'patch omitted — 120 lines, use the stats above');
        const shared = new SharedPayloadStore(sharedDir, () => [stale]);
        shared.sweepDiffKeys();
        const builder = new RoutePayloadWriter({ payloadDir, shared, budgetBytes: 12_000 });

        const prDiff = builder.skeletonTask(context()).contextFiles[1] ?? '';
        const text = fs.readFileSync(prDiff, 'utf8');

        expect(prDiff).not.toBe(stale);
        expect(fs.existsSync(stale)).toBe(true);
        expect(movedPaths(text).length).toBeGreaterThan(0);
        // The cap and the file on disk come from the same print.
        const cap = builder.generationCap(context());
        expect(cap.filesCovered).toBe(cap.filesTotal - droppedPaths(text).length);
    });

    it('clears the previous subdirectory on new generation and keeps the shared diff', () => {
        const builder = writer();
        const first = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        builder.beginGeneration();
        const second = builder.sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        expect(fs.existsSync(first.contextFiles[2] ?? '')).toBe(false);
        expect(fs.existsSync(second.contextFiles[2] ?? '')).toBe(true);
        expect(fs.existsSync(first.contextFiles[1] ?? '')).toBe(true);
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('reuses the existing generation directory with a new builder instead of clearing it', () => {
        // Server restart. The generation is the same, and its tasks and their context files are still live.
        const before = writer().sectionTask(context(), [1], mediumReadySnapshot().stops, intents());
        const after = writer().sectionTask(context(), [2], mediumReadySnapshot().stops, intents());

        expect(fs.existsSync(before.contextFiles[2] ?? '')).toBe(true);
        expect(path.dirname(after.contextFiles[2] ?? '')).toBe(path.dirname(before.contextFiles[2] ?? ''));
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('keeps payload directories private, following the convention for other PR state', () => {
        const input = writer().sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        expect(fs.statSync(payloadDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(input.contextFiles[2] ?? '')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(sharedDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(input.contextFiles[1] ?? '')).mode & 0o777).toBe(0o700);
        expect(fs.statSync(input.contextFiles[1] ?? '').mode & 0o777).toBe(0o600);
    });
});

/**
 * Regeneration context: the previous route, interdiff and discussion since then.
 * Tested on 2 iterations of the `medium` fixture. The push touches `edit-policy.ts` and `handlers.ts`,
 * removes `card-token.ts` and rebuilds the lockfile.
 */
describe('regeneration context after a push', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-regen-'));
        payloadDir = path.join(root, 'payload', 'route');
        sharedDir = path.join(root, 'payload', 'shared');
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    function writer(
        budgets?: Partial<RegenerationBudgets>,
        openContextFiles: () => string[] = () => [],
    ): RoutePayloadWriter {
        return new RoutePayloadWriter({
            payloadDir,
            shared: new SharedPayloadStore(sharedDir, openContextFiles),
            ...(budgets === undefined ? {} : { regenerationBudgets: budgets }),
        });
    }

    function map(): IterationMap {
        return buildIterationMap({
            interdiff: mediumInterdiffV1V2(),
            fromBaseCommit: mediumDiff().baseCommit,
            toBaseCommit: mediumDiffV2().baseCommit,
        });
    }

    function regeneration(overrides: Partial<RouteRegenerationContext> = {}): RouteRegenerationContext {
        return {
            previous: mediumReadySnapshot(),
            pushed: true,
            commit: mediumDiffV2().headCommit,
            interdiff: mediumInterdiffV1V2(),
            map: map(),
            threads: mediumThreadsV2(),
            ...overrides,
        };
    }

    /** Task context for the second iteration. The diff is new, and regeneration starts from the previous snapshot. */
    function contextV2(overrides: Partial<RouteRegenerationContext> = {}): RouteTaskContext {
        return { diff: mediumDiffV2(), meta: META, locale: 'ru', regeneration: regeneration(overrides) };
    }

    function read(file: string | undefined): string {
        return fs.readFileSync(file ?? '', 'utf8');
    }

    it('includes the slice, previous route and discussion in that order for both skeleton and section', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const skeleton = builder.skeletonTask(contextV2());
        const section = builder.sectionTask(contextV2(), [2], mediumReadySnapshot().stops, intents());

        expect(skeleton.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(skeleton.contextFiles[0] ?? ''),
            PR_DIFF_FILE,
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
        expect(section.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(section.contextFiles[0] ?? ''),
            PR_DIFF_FILE,
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
            'section-02-plan.md',
        ]);
        // Instructions list the context actually present. Without a previous route, these lines are absent.
        expect(skeleton.instructions).toContain('previous-route.md');
        expect(section.instructions).toContain('threads-since.md');
    });

    it('builds tasks as for the first generation when there is no previous snapshot', () => {
        const builder = writer();
        builder.beginGeneration();
        const skeleton = builder.skeletonTask({ diff: mediumDiffV2(), meta: META, locale: 'ru' });

        expect(skeleton.contextFiles).toHaveLength(2);
        expect(skeleton.instructions).not.toContain('previous-route.md');
        expect(fs.existsSync(path.join(sharedDir, 'diff', interdiffKey(), 'interdiff.md'))).toBe(false);
    });

    it('stores the slice under the iteration heads key and prints it with the same gutter as the diff', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const interdiff = builder.skeletonTask(contextV2()).contextFiles[2] ?? '';

        expect(interdiff).toBe(path.join(sharedDir, 'diff', interdiffKey(), 'interdiff.md'));
        const text = read(interdiff);
        expect(text).toContain(
            `# Interdiff ${mediumDiff().headCommit.slice(0, 7)} -> ${mediumDiffV2().headCommit.slice(0, 7)}`,
        );
        expect(text).toContain('`old new | line`');
        expect(text).toContain('services/orders/src/api/handlers.ts');
        // Files untouched by the push are absent from the slice, which differs from the PR diff.
        expect(text).not.toContain('services/orders/src/domain/edit-window.ts');
    });

    it('forbids anchors in the slice patch header and permits them in the PR diff header', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const files = builder.skeletonTask(contextV2()).contextFiles;
        const prDiff = read(files[1]);
        const interdiff = read(files[2]);

        expect(prDiff).toContain('## Patches\n');
        expect(prDiff).toContain('Line anchors of a stop are validated against exactly these printed numbers');
        // The old side of the slice is the previous iteration head, not the PR base. It cannot promise anchor validation.
        expect(interdiff).toContain('## Patches of the push');
        expect(interdiff).toContain('Never take line anchors from here.');
        expect(interdiff).not.toContain('are validated against exactly these printed numbers');
    });

    it('includes a header, summary and stop table with anchors and a touched marker in the previous route', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const text = read(builder.skeletonTask(contextV2()).contextFiles[3]);
        const previous = mediumReadySnapshot();

        expect(text).toContain(`- Built for commit: ${previous.commit}`);
        expect(text).toContain(previous.summary.split('\n')[0] ?? '');
        expect(text).toContain('| stop # | tier | title | anchors | touched by the push |');
        expect(text).toContain('`services/orders/src/api/handlers.ts`:new:');
        // Stop 03 is on `handlers.ts`, which the push touched. Stop 01 is on `edit-window.ts`, which it did not.
        expect(tableRow(text, 3)).toContain('| yes |');
        expect(tableRow(text, 1)).toContain('| no |');
        expect(text).toContain(`### Stop 1 — ${previous.stops[0]?.tier ?? ''}`);
    });

    it('drops paragraphs from the end to fit the previous route budget and keeps the table and summary', () => {
        const builder = writer({ previousRoute: 9000 });
        builder.beginGeneration(regeneration());
        const text = read(builder.skeletonTask(contextV2()).contextFiles[3]);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(9000);
        expect(text).toContain('## Summary of the previous route');
        // The table goes last because it is the plan to preserve.
        expect(tableRow(text, 6)).not.toBe('');
        expect(text).toContain('### Stop 1 —');
        expect(text).not.toContain('### Stop 6 —');
        expect(text).toContain('the remaining stop texts of the previous route were omitted');
    });

    it('includes a new reply on an old thread in discussion and excludes unrelated and old comments', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: filterCases() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        // Author reply after the push on a thread in a touched file.
        expect(text).toContain('[thread:4820242]');
        expect(text).toContain('(new)');
        // Include PR threads regardless of files.
        expect(text).toContain('[thread:-38211]');
        // A draft is not a discussion comment, so exclude a thread containing only a draft,
        // even if the push removed its file. Also exclude a thread on an untouched file.
        expect(text).not.toContain('[thread:4820260]');
        expect(text).not.toContain('[thread:4820113]');
        // Also exclude an old thread without new comments.
        expect(text).not.toContain('[thread:4820109]');
    });

    it('keeps recent discussion threads within budget and drops old ones with a marker', () => {
        const builder = writer({ threadsSince: 1200 });
        builder.beginGeneration(regeneration({ threads: filterCases() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(1200);
        expect(text).toContain('[thread:4820242]');
        expect(text).toContain('older thread(s) omitted by the payload budget');
    });

    it('writes a file stating that no threads match instead of branching the instructions', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: [] }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('No new comments since the previous route.');
    });

    it('continues generation when the host returns no threads and states this in the file', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: null }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('[UNAVAILABLE: the host did not give the discussion of this pull request.]');
    });

    it('includes the previous route and discussion but no slice when the interdiff slice is unavailable', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ interdiff: null, map: null }));
        const files = builder.skeletonTask(contextV2({ interdiff: null, map: null })).contextFiles;

        expect(files.map((file) => path.basename(file))).toEqual([
            path.basename(files[0] ?? ''),
            PR_DIFF_FILE,
            'previous-route.md',
            'threads-since.md',
        ]);
    });

    it('omits push wording and the touched column from the previous route when regenerating on the same iteration', () => {
        const builder = writer();
        const sameCommit = { pushed: false, commit: mediumReadySnapshot().commit, interdiff: null, map: identityMap() };
        builder.beginGeneration(regeneration(sameCommit));
        const task = builder.skeletonTask(contextV2(sameCommit));
        const previous = read(task.contextFiles[2]);
        const threads = read(task.contextFiles[3]);

        expect(previous).toContain('The code has not moved since it was built');
        expect(previous).toContain('| stop # | tier | title | anchors |');
        // Omit the "touched by push" column. A column full of "no" would read as "do not touch anything".
        expect(previous).not.toContain('touched by the push');
        expect(previous).not.toContain('| no |');
        expect(previous).not.toContain('Current diff is for commit');
        expect(threads).toContain('The code has not moved');
        expect(threads).not.toContain('the push');
        expect(task.instructions).toContain('rebuild on the same commit');
    });

    // The slice is unavailable, but the iteration changed. "The same commit" would be false here and cause the model
    // to rewrite the route without checking it against the new code.
    it('names both commits in the previous route and asks the model to compare them when a push has no slice', () => {
        const builder = writer();
        const noInterdiff = { interdiff: null, map: null };
        builder.beginGeneration(regeneration(noInterdiff));
        const skeleton = builder.skeletonTask(contextV2(noInterdiff));
        const section = builder.sectionTask(contextV2(noInterdiff), [2], mediumReadySnapshot().stops, intents());
        const previous = read(skeleton.contextFiles[2]);
        const threads = read(skeleton.contextFiles[3]);

        expect(previous).toContain(`- Built for commit: ${mediumReadySnapshot().commit}`);
        expect(previous).toContain(`- Current diff is for commit: ${mediumDiffV2().headCommit}`);
        expect(previous).toContain('The author has pushed since it was built');
        expect(previous).toContain(`compare this route with the current diff in \`${PR_DIFF_FILE}\``);
        expect(previous).toContain('cannot carry what the reviewer\nhas already read');
        expect(previous).not.toContain('touched by the push |');
        expect(threads).toContain('could not tell which files the push touched');
        for (const text of [previous, threads, skeleton.instructions, section.instructions]) {
            expect(text).not.toContain('same commit');
            expect(text).not.toContain('has not moved');
        }
        expect(skeleton.instructions).toContain('could not get the interdiff');
        expect(section.instructions).toContain('Do not write `changeReason`');
        expect(skeleton.instructions).not.toContain('changeReason');
    });

    it('omits reviewer drafts from discussion because the author has not seen them', () => {
        const builder = writer();
        builder.beginGeneration(regeneration({ threads: withDraftReply() }));
        const text = read(builder.skeletonTask(contextV2()).contextFiles[4]);

        expect(text).toContain('[thread:4820242]');
        expect(text).not.toContain('reviewer draft, unseen by the author');
    });

    it('reuses existing generation files with a new builder after a server restart', () => {
        const before = writer();
        before.beginGeneration(regeneration());
        before.skeletonTask(contextV2());

        // Generation context died with the process. The slice was restored from cache, and threads are absent.
        const after = writer().sectionTask(
            { diff: mediumDiffV2(), meta: META, locale: 'ru', regeneration: regeneration({ threads: null }) },
            [2],
            mediumReadySnapshot().stops,
            intents(),
        );

        expect(after.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(after.contextFiles[0] ?? ''),
            PR_DIFF_FILE,
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
            'section-02-plan.md',
        ]);
        // Keep the discussion file written by the live generation, without rebuilding it.
        expect(read(after.contextFiles[4])).toContain('[thread:4820242]');
    });

    it('preserves both the iteration diff and the slice from the same build during shared directory cleanup', () => {
        const builder = writer();
        builder.beginGeneration(regeneration());
        const skeleton = builder.skeletonTask(contextV2());

        expect(fs.existsSync(skeleton.contextFiles[1] ?? '')).toBe(true);
        expect(fs.existsSync(skeleton.contextFiles[2] ?? '')).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff')).sort()).toEqual(
            [diffKey(mediumDiffV2()), interdiffKey()].sort(),
        );
    });

    function diffKey(diff: PrDiff): string {
        return `${diff.baseCommit}-${diff.headCommit}`;
    }

    /** The slice key is the pair of iteration heads, which share the same base. */
    function interdiffKey(): string {
        return `${mediumDiff().headCommit}-${mediumDiffV2().headCommit}`;
    }

    /** Previous route table row by the stop plan number. */
    function tableRow(text: string, planIndex: number): string {
        return text.split('\n').find((line) => line.startsWith(`| ${String(planIndex)} | `)) ?? '';
    }

    /** A thread that passed the filter, with an unsent reviewer draft among its replies. */
    function withDraftReply(): Thread[] {
        return mediumThreadsV2().map((thread) =>
            thread.id === '4820242'
                ? {
                      ...thread,
                      root: {
                          ...thread.root,
                          replies: [
                              ...thread.root.replies,
                              {
                                  ...thread.root,
                                  id: 'draft-2',
                                  draft: true,
                                  createdAt: '2026-08-21T10:58:00.000Z',
                                  body: 'reviewer draft, unseen by the author',
                                  replies: [],
                              },
                          ],
                      },
                  }
                : thread,
        );
    }

    /**
     * Threads for the "what is new" filter: an author reply after the push on a touched file (fixture
     * 4820242), a recent comment on a file untouched by the push, a recent draft on a file
     * removed by the push, and a recent PR thread.
     */
    function filterCases(): Thread[] {
        const after = '2026-08-21T10:58:00.000Z';
        return mediumThreadsV2().map((thread) => {
            if (thread.anchor === null || thread.anchor.path === 'services/orders/src/domain/edit-window.ts') {
                return { ...thread, root: { ...thread.root, createdAt: after } };
            }
            if (thread.id === '4820260') {
                return {
                    ...thread,
                    root: {
                        ...thread.root,
                        replies: [
                            { ...thread.root, id: 'draft-1', draft: true, createdAt: after, replies: [] },
                        ],
                    },
                };
            }
            return thread;
        });
    }
});
