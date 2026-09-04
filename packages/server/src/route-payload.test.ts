import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Locale, PrDiff, PrMeta, Thread } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { IterationMap } from './iterations/index.js';
import { buildIterationMap, identityMap } from './iterations/index.js';
import type { RegenerationBudgets, RouteTaskContext } from './route-payload.js';
import {
    CONTEXT_BUDGET_BYTES,
    prDiffContext,
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
import { SharedPayloadStore } from './shared-payload.js';

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
    capabilities: { stickyShip: true, fileViewedSync: false, fileContent: true, commentIssues: true, iterations: false },
    verdicts: [],
};

/** Builder context: fixture diff and PR metadata. The default generation language is Russian. */
function context(diff: PrDiff = mediumDiff(), locale: Locale = 'ru'): RouteTaskContext {
    return { diff, meta: META, locale };
}

/** Stop intents from the raw fixture skeleton, matching `RouteStore.stopIntents`. */
function intents(): Map<number, string> {
    return new Map(mediumRawResults().skeleton.stops.map((stop, index) => [index + 1, stop.intent]));
}

/** Full context size without truncation, the baseline for budget tests. */
function fullSize(): number {
    return Buffer.byteLength(prDiffContext(context(), CONTEXT_BUDGET_BYTES), 'utf8');
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

describe('shared diff context', () => {
    it('includes PR metadata, the full file list and every complete patch', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES);

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
        const text = prDiffContext(context(diff), CONTEXT_BUDGET_BYTES);
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
        const text = prDiffContext({ diff: mediumDiff(), meta: null }, CONTEXT_BUDGET_BYTES);

        expect(text).toContain('no pull request metadata');
        expect(text).toContain('- Volume: 18 files');
        expect(omittedPaths(text)).toEqual([]);
    });

    it('truncates to fit the budget while keeping the complete file list', () => {
        const budget = 12_000;
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), budget);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omittedPaths(text).length).toBeGreaterThan(0);
        // The coverage rule requires every file to be known, so never truncate the list.
        for (const file of diff.files) {
            expect(text).toContain(`| \`${file.path}\` |`);
        }
    });

    it('names the file, size and obligation to place its ranges in the truncation marker', () => {
        const text = prDiffContext(context(), 12_000);
        const lock = mediumDiff().files.find((file) => file.path === 'pnpm-lock.yaml');

        expect(omittedPaths(text)).toContain('pnpm-lock.yaml');
        expect(text).toContain(
            `patch omitted — ${String((lock?.additions ?? 0) + (lock?.deletions ?? 0))} lines, ` +
                'use the stats above; the file still must be placed',
        );
    });

    it('truncates generated files first because the team does not require their review', () => {
        // Set the budget 1 byte below full context to truncate exactly 1 file, the largest generated file.
        const text = prDiffContext(context(), fullSize() - 1);

        expect(omittedPaths(text)).toEqual(['pnpm-lock.yaml']);
    });

    it('cuts the largest patch next to lose fewer files within the same budget', () => {
        const diff = mediumDiff();
        const generated = diff.files.filter((file) => file.generated).map((file) => file.path);
        // Shrink the budget byte by byte until all generated patches are cut. The largest goes next.
        let text = prDiffContext(context(diff), fullSize() - 1);
        while (omittedPaths(text).length <= generated.length) {
            text = prDiffContext(context(diff), Buffer.byteLength(text, 'utf8') - 1);
        }

        const omitted = omittedPaths(text);
        expect(omitted).toEqual(expect.arrayContaining(generated));
        // Tests are protected, so the largest remaining file is the edit window documentation.
        expect(omitted).toContain('services/orders/docs/edit-window.md');
        expect(omitted).toHaveLength(generated.length + 1);
    });

    it('keeps the file list but no patches when the budget is below the non-truncatable part', () => {
        const diff = mediumDiff();
        const text = prDiffContext(context(diff), 10);

        expect(omittedPaths(text)).toHaveLength(diff.files.length);
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
        expect(prDiffContext(context(), CONTEXT_BUDGET_BYTES)).toContain('| file # | file | change | +/- | notes |');
    });
});

describe('single truncation policy for the shared diff', () => {
    it('cuts test files last because the digest needs their lines for anchors', () => {
        // The budget fits the mandatory part and tests, but not the full diff.
        const budget = 20_000;
        const text = prDiffContext(context(), budget);
        const omitted = omittedPaths(text);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(budget);
        expect(omitted.length).toBeGreaterThan(0);
        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
    });

    it('test protection overrides the generated flag: a snapshot test outlasts a regular file', () => {
        // The host correctly marks the snapshot as generated, but the digest needs its lines for testPath/testLine.
        const diff = mediumDiff();
        const generatedTest = diff.files.map((file) =>
            file.path.includes('__tests__') ? { ...file, generated: true } : file,
        );
        const marked = { ...diff, files: generatedTest };
        const budget = Buffer.byteLength(prDiffContext(context(marked), 1e9), 'utf8') - 1;

        const omitted = omittedPaths(prDiffContext(context(marked), budget));

        expect(omitted.filter((file) => file.includes('__tests__'))).toEqual([]);
        expect(omitted).toEqual(['pnpm-lock.yaml']);
    });
});

describe('generation cap (M5-T14)', () => {
    it('covers everything without truncation when the entire diff fits', () => {
        const cap = prDiffPayload(context(), CONTEXT_BUDGET_BYTES).cap;

        expect(cap.filesTotal).toBe(mediumDiff().files.length);
        expect(cap.filesCovered).toBe(cap.filesTotal);
        expect(cap.machineFiles).toBe(0);
        expect(cap.truncated).toBe(false);
    });

    it('counts the only dropped generated file as generated, without truncation', () => {
        // The generated lockfile is the first truncation candidate. The budget is short by exactly its size.
        const budget = fullSize() - 1;
        const cap = prDiffPayload(context(), budget).cap;

        expect(omittedPaths(prDiffContext(context(), budget))).toEqual(['pnpm-lock.yaml']);
        expect(cap.filesCovered).toBe(cap.filesTotal - 1);
        expect(cap.machineFiles).toBe(1);
        expect(cap.truncated).toBe(false);
    });

    it('builds the plan from a partial diff when a non-generated file is truncated', () => {
        const budget = 20_000;
        const cap = prDiffPayload(context(), budget).cap;
        const omitted = omittedPaths(prDiffContext(context(), budget));

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
        expect(path.basename(pr ?? '')).toBe('pr-diff.md');
        expect(fs.readFileSync(guide ?? '', 'utf8')).toContain('# Task: plan the review route');
        expect(fs.readFileSync(pr ?? '', 'utf8')).toContain('## Changed files (18, complete list)');
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
        expect(fs.readdirSync(path.dirname(skeleton.contextFiles[1] ?? ''))).toEqual(['pr-diff.md']);
    });

    it('truncates context on disk to the builder budget', () => {
        const input = writer(12_000).skeletonTask(context());
        const text = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(12_000);
        expect(text).toContain('patch omitted');
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
 * Regeneration context (M4-T7): the previous route, slice between iterations and discussion since then.
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
            'pr-diff.md',
            'interdiff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
        expect(section.contextFiles.map((file) => path.basename(file))).toEqual([
            path.basename(section.contextFiles[0] ?? ''),
            'pr-diff.md',
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
            'pr-diff.md',
            'previous-route.md',
            'threads-since.md',
        ]);
    });

    it('without a slice, the previous route does not describe a push or print an affected column', () => {
        const builder = writer();
        const same = regeneration({ interdiff: null, map: identityMap() });
        builder.beginGeneration(same);
        const files = builder.skeletonTask(contextV2({ interdiff: null, map: identityMap() })).contextFiles;
        const previous = read(files[2]);
        const threads = read(files[3]);

        expect(previous).toContain('The code has not moved since it was built');
        expect(previous).toContain('| stop # | tier | title | anchors |');
        // Omit the "touched by push" column. A column full of "no" would read as "do not touch anything".
        expect(previous).not.toContain('touched by the push');
        expect(previous).not.toContain('| no |');
        expect(threads).toContain('The code has not moved');
        expect(threads).not.toContain('the push');
        expect(same.interdiff).toBeNull();
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
            'pr-diff.md',
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

    /** The slice key is a pair of iteration heads (T1 decision). They share a base. */
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
