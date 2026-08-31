import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { PrDiff, PrMeta } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { RoutePayloadContext } from './route-payload.js';
import { CONTEXT_BUDGET_BYTES, RoutePayloadWriter, sectionContext, skeletonContext } from './route-payload.js';
import { indexDiff } from './route/diff-index.js';
import { mediumDiff, mediumRawResults, mediumReadySnapshot } from './route/fixture-support.js';

/**
 * Payload for route generation tasks (M2-T5) on the `medium` fixture diff: 18 files, 862
 * changed lines, including a generated lockfile and 3 test files. These are exactly the roles
 * that budget truncation distinguishes.
 */

const META: PrMeta = {
    id: '4242',
    url: 'https://github.com/quillmart/quillmart/pull/4242',
    title: 'Order editing window',
    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
    fromBranch: 'alice/edit-window',
    toBranch: 'main',
    state: 'open',
    statusLabel: 'Awaiting review',
    checks: null,
    updatedAt: '2026-08-20T10:00:00.000Z',
    capabilities: { stickyShip: true, fileViewedSync: false, fileContent: true, commentIssues: true },
};

/** Builder context: fixture diff plus PR metadata. */
function context(diff: PrDiff = mediumDiff()): RoutePayloadContext {
    return { diff, meta: META };
}

/** Stop intents from the raw fixture skeleton, matching `RouteStore.stopIntents`. */
function intents(): Map<number, string> {
    return new Map(mediumRawResults().skeleton.stops.map((stop, index) => [index + 1, stop.intent]));
}

/** Full context size without truncation, the baseline for budget tests. */
function fullSize(): number {
    return Buffer.byteLength(skeletonContext(context(), CONTEXT_BUDGET_BYTES), 'utf8');
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

function omittedPaths(text: string): string[] {
    return [...text.matchAll(/^### File \d+\. `([^`]+)` .*\n\npatch omitted/gm)].map((match) => match[1] ?? '');
}

describe('skeleton task context', () => {
    it('includes PR metadata, the full file list and every complete patch', () => {
        const diff = mediumDiff();
        const text = skeletonContext(context(diff), CONTEXT_BUDGET_BYTES);

        expect(text).toContain('- Title: Order editing window');
        expect(text).toContain('- Author: alice (Alice Ingram)');
        expect(text).toContain('- Branches: alice/edit-window -> main');
        expect(text).toContain(`- Diff: base ${diff.baseCommit} -> head ${diff.headCommit}`);
        expect(text).toContain('- Volume: 18 files, +806 / -56 lines');

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
        const text = skeletonContext(context(diff), CONTEXT_BUDGET_BYTES);
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
        const text = skeletonContext({ diff: mediumDiff(), meta: null }, CONTEXT_BUDGET_BYTES);

        expect(text).toContain('no pull request metadata');
        expect(text).toContain('- Volume: 18 files');
        expect(omittedPaths(text)).toEqual([]);
    });

    it('truncates to fit the budget while keeping the complete file list', () => {
        const budget = 12_000;
        const diff = mediumDiff();
        const text = skeletonContext(context(diff), budget);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omittedPaths(text).length).toBeGreaterThan(0);
        // The coverage rule requires every file to be known, so never truncate the list.
        for (const file of diff.files) {
            expect(text).toContain(`| \`${file.path}\` |`);
        }
    });

    it('names the file, size and obligation to place its ranges in the truncation marker', () => {
        const text = skeletonContext(context(), 12_000);
        const lock = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');

        expect(omittedPaths(text)).toContain('pnpm-lock.yaml');
        expect(text).toContain(
            `patch omitted — ${String((lock?.additions ?? 0) + (lock?.deletions ?? 0))} lines, ` +
                'use the stats above; the file still must be placed',
        );
    });

    it('truncates generated files first because the team does not require their review', () => {
        // Set the budget 1 byte below full context to truncate exactly 1 file, the largest generated file.
        const text = skeletonContext(context(), fullSize() - 1);

        expect(omittedPaths(text)).toEqual(['pnpm-lock.yaml']);
    });

    it('cuts the largest patch next to lose fewer files within the same budget', () => {
        const diff = mediumDiff();
        const generated = diff.files.filter((file) => file.generated).map((file) => file.path);
        // Shrink the budget byte by byte until all generated patches are cut. The largest goes next.
        let text = skeletonContext(context(diff), fullSize() - 1);
        while (omittedPaths(text).length <= generated.length) {
            text = skeletonContext(context(diff), Buffer.byteLength(text, 'utf8') - 1);
        }

        const omitted = omittedPaths(text);
        expect(omitted).toEqual(expect.arrayContaining(generated));
        // The fixture's largest non-generated patch is the edit window test (4.5 KB).
        expect(omitted).toContain('services/orders/src/domain/__tests__/edit-window.test.ts');
        expect(omitted).toHaveLength(generated.length + 1);
    });

    it('keeps the file list but no patches when the budget is below the non-truncatable part', () => {
        const diff = mediumDiff();
        const text = skeletonContext(context(diff), 10);

        expect(omittedPaths(text)).toHaveLength(diff.files.length);
        expect(text).toContain('| `pnpm-lock.yaml` |');
    });
});

describe('section task context', () => {
    const stops = mediumReadySnapshot().stops;

    it('includes the full plan with target stops distinguished and intents preserved', () => {
        const text = sectionContext(context(), [3], stops, intents(), CONTEXT_BUDGET_BYTES);

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

    it('targets every stop in a multi-stop batch and treats the rest as neighbors', () => {
        const text = sectionContext(context(), [1, 2], stops, intents(), CONTEXT_BUDGET_BYTES);

        expect(text).toContain('### Stop 1 —');
        expect(text).toContain('### Stop 2 —');
        expect(text).not.toContain('### Stop 3 —');
        expect(text).toContain(`- stop 3 (medium) ${stops[2]?.title ?? ''}`);
    });

    it('prints stop numbers as schema numbers, not two-digit file numbers', () => {
        const text = sectionContext(context(), [3], stops, intents(), CONTEXT_BUDGET_BYTES);
        const plan = text.slice(0, text.indexOf('# Pull request'));

        // `planIndex` is z.number(), so the schema rejects "03" in the model JSON.
        expect(plan).not.toMatch(/^\| 0\d \|/m);
        expect(plan).not.toMatch(/### Stop 0\d /);
        expect(plan).toContain('`"planIndex": 3`');
        // Only files retain two-digit numbering, and the columns have different names.
        expect(plan).toContain('| stop # | tier | title | |');
        expect(text).toContain('| file # | file | change | +/- | notes |');
    });

    it('cuts test files last because the digest needs their lines for anchors', () => {
        // The budget fits the mandatory part and tests, but not the full diff.
        const budget = 20_000;
        const text = sectionContext(context(), [4], stops, intents(), budget);
        const omitted = omittedPaths(text);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omitted.length).toBeGreaterThan(0);
        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
        // The same skeleton budget does not protect tests. This is a payload difference, not a coincidence.
        expect(omittedPaths(skeletonContext(context(), budget)).some((file) => file.includes('__tests__'))).toBe(true);
    });

    it('test protection overrides the generated flag: a snapshot test outlasts a regular file', () => {
        // The host correctly marks the snapshot as generated, but the digest needs its lines for testPath/testLine.
        const diff = mediumDiff();
        const generatedTest = diff.files.map((file) =>
            file.path.includes('__tests__') ? { ...file, generated: true } : file,
        );
        const marked = { ...diff, files: generatedTest };
        const budget = Buffer.byteLength(sectionContext(context(marked), [4], stops, intents(), 1e9), 'utf8') - 1;

        const omitted = omittedPaths(sectionContext(context(marked), [4], stops, intents(), budget));

        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
        expect(omitted).toEqual(['pnpm-lock.yaml']);
    });
});

describe('writing payload to disk', () => {
    let payloadDir: string;

    beforeEach(async () => {
        payloadDir = path.join(await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-payload-')), 'payload');
    });

    afterEach(async () => {
        await fs.promises.rm(path.dirname(payloadDir), { recursive: true, force: true });
    });

    function writer(): RoutePayloadWriter {
        return new RoutePayloadWriter({ payloadDir });
    }

    it('the skeleton task has its guide, context and schema on disk', () => {
        const input = writer().skeletonTask(context());

        expect(input.type).toBe('route.skeleton');
        expect(input.priority).toBe('background');
        expect(input.contextFiles).toHaveLength(2);
        for (const file of input.contextFiles) {
            expect(path.isAbsolute(file)).toBe(true);
            expect(fs.readFileSync(file, 'utf8').length).toBeGreaterThan(0);
        }

        const [guide, pr] = input.contextFiles;
        expect(fs.readFileSync(guide ?? '', 'utf8')).toContain('# Task: plan the review route');
        expect(fs.readFileSync(pr ?? '', 'utf8')).toContain('## Changed files (18, complete list)');
        expect(input.instructions).toContain('Plan the review route');
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

    it('the section task puts target numbers in instructions and the plan in context', () => {
        const input = writer().sectionTask(context(), [3, 4], mediumReadySnapshot().stops, intents());

        expect(input.type).toBe('route.section');
        expect(input.instructions).toContain('3, 4');
        expect(input.contextFiles[1]).toContain('section-03-04-context.md');
        expect(fs.readFileSync(input.contextFiles[1] ?? '', 'utf8')).toContain('# Route plan');
    });

    it('truncates context on disk to the builder budget', () => {
        const small = new RoutePayloadWriter({ payloadDir, budgetBytes: 12_000 });
        const input = small.skeletonTask(context());
        const text = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12_000);
        expect(text).toContain('patch omitted');
    });

    it('a new generation clears the previous subdirectory', () => {
        const builder = writer();
        const first = builder.skeletonTask(context());
        builder.beginGeneration();
        const second = builder.skeletonTask(context());

        expect(fs.existsSync(first.contextFiles[0] ?? '')).toBe(false);
        expect(fs.existsSync(second.contextFiles[0] ?? '')).toBe(true);
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('reuses the existing generation directory with a new builder instead of clearing it', () => {
        // Server restart. The generation is the same, and its tasks and their context files are still live.
        const before = writer().skeletonTask(context());
        const after = writer().sectionTask(context(), [1], mediumReadySnapshot().stops, intents());

        expect(fs.existsSync(before.contextFiles[0] ?? '')).toBe(true);
        expect(path.dirname(after.contextFiles[0] ?? '')).toBe(path.dirname(before.contextFiles[0] ?? ''));
        expect(fs.readdirSync(payloadDir)).toHaveLength(1);
    });

    it('keeps payload directories private, following the convention for other PR state', () => {
        const input = writer().skeletonTask(context());

        expect(fs.statSync(payloadDir).mode & 0o777).toBe(0o700);
        expect(fs.statSync(path.dirname(input.contextFiles[0] ?? '')).mode & 0o777).toBe(0o700);
    });
});
