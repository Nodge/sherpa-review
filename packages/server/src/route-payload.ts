import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FileDiff, Locale, PrDiff, PrMeta, RouteStop, UiGenerationCap } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import type { EnqueueInput } from './queue.js';
import type { RegenerationContextFiles } from './route-prompts.js';
import { promptLocale, sectionGuide, sectionInstructions, skeletonGuide, skeletonInstructions } from './route-prompts.js';
import type { RouteRegenerationContext } from './route-regeneration.js';
import {
    PREVIOUS_ROUTE_FILE,
    previousRouteContext,
    THREADS_SINCE_FILE,
    threadsSinceContext,
} from './route-regeneration.js';
import { walkPatch } from './route/diff-index.js';
import type { SharedPayloadStore } from './shared-payload.js';
import { diffKeyOf } from './shared-payload.js';

/**
 * Route generation task payload (docs/protocol.md §4): large context in files, short instructions in
 * stdout, and the result schema as part of the task.
 *
 * Each task is self-contained. The agent session may have died and reconnected, so the payload
 * includes everything needed: the guide, PR diff and (for sections) route plan. The unchanged part (guide and
 * diff) lives at a stable path in the shared directory (`shared-payload.ts`). The generation directory holds
 * only its own files. Text is in English because the model reads it. The generation locale names the result language.
 * The guide filename includes a content hash so that 2 locales do not compete for the same file.
 *
 * Priority is background. Route generation takes minutes and must not run ahead of work the reviewer
 * is waiting for at the screen (docs/protocol.md §5).
 *
 * Writes are synchronous. The orchestrator enqueues tasks during synchronous reconciliation, which
 * runs from a queue subscriber and the result acceptance handler. Payload files total hundreds of kilobytes per
 * generation and are written only a handful of times per route, so synchronous writes cost less than
 * an asynchronous state machine around them.
 */

/**
 * Diff context file budget in bytes (docs/architecture.md §7.5). ~320 KB is roughly
 * 80 thousand tokens. A large PR fits in full, while a pathological one (generated assets,
 * megabytes of snapshot tests) is truncated so it cannot consume the model context window and ruin latency.
 * The changed file list is outside the budget and is never truncated.
 */
export const CONTEXT_BUDGET_BYTES = 320 * 1024;

/**
 * Regeneration context budgets, counted separately from the PR diff. The interdiff must not
 * displace patches used by sections for anchors. The previous route is the cheapest to lose,
 * because it only helps preserve stop numbers. 128 KB fits any ordinary push in full, and 64 KB fits
 * a route with about 10 stops and 10 threads with replies.
 */
export const REGENERATION_BUDGETS: RegenerationBudgets = {
    interdiff: 128 * 1024,
    previousRoute: 64 * 1024,
    threadsSince: 64 * 1024,
};

export interface RegenerationBudgets {
    readonly interdiff: number;
    readonly previousRoute: number;
    readonly threadsSince: number;
}

/** Payload directories use the same 0700 permissions as other PR state (docs/architecture.md §6). */
const DIR_MODE = 0o700;
/** The payload has no secrets, but outsiders have no reason to read it either. */
const FILE_MODE = 0o600;

/** PR data the builder needs. The diff is required. Metadata is optional (its failure does not break the route). */
export interface RoutePayloadContext {
    readonly diff: PrDiff;
    readonly meta: PrMeta | null;
    /** Previous pass for a route rebuilt after a push. null means the first generation. */
    readonly regeneration?: RouteRegenerationContext | null;
}

/** Route task context: the same PR plus the language the task requests for its result. */
export interface RouteTaskContext extends RoutePayloadContext {
    readonly locale: Locale;
}

export interface RoutePayloadWriterOptions {
    /** Isolated route directory. Each generation gets a subdirectory here. */
    readonly payloadDir: string;
    /** Shared PR context: the guide and diff use a stable path, not a copy per task. */
    readonly shared: SharedPayloadStore;
    readonly budgetBytes?: number;
    /** Regeneration file limits, defaulting to `REGENERATION_BUDGETS`. */
    readonly regenerationBudgets?: Partial<RegenerationBudgets>;
}

/**
 * Write route task payloads to disk. Each generation gets one subdirectory. A new
 * generation creates its own and removes previous ones to keep the directory from growing without bounds.
 */
export class RoutePayloadWriter {
    private readonly payloadDir: string;
    private readonly shared: SharedPayloadStore;
    private readonly budgetBytes: number;
    private readonly regenerationBudgets: RegenerationBudgets;
    private generationDir: string | null = null;

    constructor(options: RoutePayloadWriterOptions) {
        this.payloadDir = options.payloadDir;
        this.shared = options.shared;
        this.budgetBytes = options.budgetBytes ?? CONTEXT_BUDGET_BYTES;
        this.regenerationBudgets = { ...REGENERATION_BUDGETS, ...options.regenerationBudgets };
    }

    /**
     * Start a new generation with a fresh subdirectory and remove previous ones. Write regeneration context
     * once here, shared by the skeleton and all sections of the generation.
     */
    beginGeneration(regeneration: RouteRegenerationContext | null = null): void {
        this.startGeneration();
        this.writeRegeneration(regeneration);
    }

    /**
     * Rewrite regeneration context in the current generation directory without clearing it.
     * Needed after a restart. The previous process wrote files for the iteration where generation started,
     * but the task uses the active iteration, so the task text and files would disagree about whether a push occurred.
     * Called only when the directory has no live tasks.
     */
    restoreRegeneration(regeneration: RouteRegenerationContext | null): void {
        const dir = this.currentDir();
        for (const name of [PREVIOUS_ROUTE_FILE, THREADS_SINCE_FILE]) {
            fs.rmSync(path.join(dir, name), { force: true });
        }
        this.writeRegeneration(regeneration);
    }

    private writeRegeneration(regeneration: RouteRegenerationContext | null): void {
        if (regeneration === null) {
            return;
        }
        const budgets = this.regenerationBudgets;
        this.writeFile(PREVIOUS_ROUTE_FILE, previousRouteContext(regeneration, budgets.previousRoute));
        this.writeFile(THREADS_SINCE_FILE, threadsSinceContext(regeneration, budgets.threadsSince));
    }

    /** The `route.skeleton` task returns the summary, stop plan and Full tour order in one result. */
    skeletonTask(context: RouteTaskContext): EnqueueInput {
        // Write the PR diff first. It starts collecting shared keys, then the slice adds to that collection.
        const prDiff = this.prDiff(context);
        const regeneration = this.regenerationFiles(context);
        const locale = context.locale;
        return {
            type: 'route.skeleton',
            priority: 'background',
            instructions: skeletonInstructions(locale, regeneration.present),
            // The skeleton has no context of its own. Both the guide and diff use shared paths.
            contextFiles: [
                this.shared.guide('skeleton-guide', skeletonGuide(locale)),
                prDiff.file,
                ...regeneration.files,
            ],
            resultSchemaFile: this.writeSchema('skeleton'),
        };
    }

    /**
     * Generation cap from the diff and budget, using the same pure function that prints skeleton context.
     * Skeleton acceptance recalculates it because enqueue context may not survive the process, and the cap
     * must reach the route header from the snapshot even after a restart.
     */
    generationCap(context: RoutePayloadContext): UiGenerationCap {
        return prDiffPayload(context, this.budgetBytes).cap;
    }

    /**
     * The `route.section` task fills one or more planned stops. Target numbers go
     * in the task text. `taskSchema` has no separate field, so the server controls batching.
     * "Other" has no sections. The skeleton synthesized it, and the UI computes its contents.
     */
    sectionTask(
        context: RouteTaskContext,
        planIndexes: readonly number[],
        stops: readonly RouteStop[],
        intents: ReadonlyMap<number, string>,
    ): EnqueueInput {
        const locale = context.locale;
        const name = `section-${planIndexes.map(pad2).join('-')}-plan.md`;
        const plan = this.writeFile(name, sectionPlanContext(planIndexes, stops, intents, locale));
        const prDiff = this.prDiff(context);
        const regeneration = this.regenerationFiles(context);
        return {
            type: 'route.section',
            priority: 'background',
            instructions: sectionInstructions(locale, planIndexes, regeneration.present),
            contextFiles: [
                this.shared.guide('section-guide', sectionGuide(locale)),
                prDiff.file,
                ...regeneration.files,
                plan,
            ],
            resultSchemaFile: this.writeSchema('section'),
        };
    }

    /**
     * Task regeneration context. The slice is written to the shared directory (idempotently), while
     * the previous route and discussion are already in the generation directory, written by `beginGeneration`
     * or, after a server restart, `restoreRegeneration`.
     */
    private regenerationFiles(context: RoutePayloadContext): {
        files: string[];
        present: RegenerationContextFiles;
    } {
        const interdiff = context.regeneration?.interdiff ?? null;
        const interdiffFile =
            interdiff === null
                ? null
                : this.shared.interdiff(
                      diffKeyOf(interdiff),
                      interdiffContext(interdiff, this.regenerationBudgets.interdiff),
                  );
        const previousRoute = this.existingFile(PREVIOUS_ROUTE_FILE);
        const threadsSince = this.existingFile(THREADS_SINCE_FILE);
        return {
            files: [interdiffFile, previousRoute, threadsSince].filter((file): file is string => file !== null),
            present: {
                pushed: context.regeneration?.pushed ?? false,
                interdiff: interdiffFile !== null,
                previousRoute: previousRoute !== null,
                threadsSince: threadsSince !== null,
            },
        };
    }

    /** A file in the generation directory, if present. After a restart, the previous process wrote it. */
    private existingFile(name: string): string | null {
        const file = path.join(this.currentDir(), name);
        return fs.existsSync(file) ? file : null;
    }

    /** Shared PR diff keyed by the commit pair. The skeleton, sections and PR chat question use the same one. */
    private prDiff(context: RoutePayloadContext): { file: string; cap: UiGenerationCap } {
        const built = prDiffPayload(context, this.budgetBytes);
        return { file: this.shared.prDiff(diffKeyOf(context.diff), built.content), cap: built.cap };
    }

    /** A fresh generation subdirectory. Old contents are removed because their tasks were just cancelled. */
    private startGeneration(): string {
        const dir = path.join(this.payloadDir, `gen-${Date.now().toString(36)}-${randomBytes(3).toString('hex')}`);
        this.makeDir(dir);

        for (const entry of fs.readdirSync(this.payloadDir)) {
            const stale = path.join(this.payloadDir, entry);
            if (stale !== dir) {
                fs.rmSync(stale, { recursive: true, force: true });
            }
        }

        this.generationDir = dir;
        return dir;
    }

    /**
     * The current generation directory. Lazy access supports server restarts. Reconciliation finds a generation
     * started by the previous process and supplies its missing tasks. It reuses that generation's directory
     * because its tasks survived the restart along with their
     * context files. Cleaning it would leave the tasks with broken paths.
     */
    private currentDir(): string {
        const known = this.generationDir;
        if (known !== null) {
            return known;
        }

        const adopted = this.latestGenerationDir();
        if (adopted === null) {
            return this.startGeneration();
        }
        this.makeDir(adopted);
        this.generationDir = adopted;
        return adopted;
    }

    /** The newest generation subdirectory. `null` means no payload has been written for this PR yet. */
    private latestGenerationDir(): string | null {
        if (!fs.existsSync(this.payloadDir)) {
            return null;
        }

        let latest: { dir: string; time: number } | null = null;
        for (const entry of fs.readdirSync(this.payloadDir, { withFileTypes: true })) {
            if (!entry.isDirectory()) {
                continue;
            }
            const dir = path.join(this.payloadDir, entry.name);
            const time = fs.statSync(dir).mtimeMs;
            // Break timestamp ties by name. Names end in random bytes, so the order is stable.
            if (latest === null || time > latest.time || (time === latest.time && dir > latest.dir)) {
                latest = { dir, time };
            }
        }
        return latest?.dir ?? null;
    }

    private makeDir(dir: string): void {
        fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
        // mkdir applies mode through umask, and the directories may already exist.
        fs.chmodSync(this.payloadDir, DIR_MODE);
        fs.chmodSync(dir, DIR_MODE);
    }

    private writeFile(name: string, content: string): string {
        const file = path.join(this.currentDir(), name);
        fs.writeFileSync(file, content, { mode: FILE_MODE });
        return file;
    }

    /** Result schema as a file (docs/protocol.md §4). Zod is canonical, JSON Schema is derived. */
    private writeSchema(kind: 'skeleton' | 'section'): string {
        const key = kind === 'skeleton' ? 'routeSkeletonResult' : 'routeSectionResult';
        const schema = generateJsonSchemas()[key];
        return this.writeFile(`route-${kind}-result.schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
    }
}

/**
 * Shared diff context file with the PR header, full file list and patches within budget. All tasks share it.
 * The skeleton, sections and PR-wide chat questions read it, so they share a truncation policy
 * based on section needs: tests are trimmed last, since the digest must anchor to their actual lines.
 */
export function prDiffContext(context: RoutePayloadContext, budgetBytes: number): string {
    return prContext(context, budgetBytes).content;
}

/**
 * The same file with truncation metrics, which the UI shows in the route header and the
 * banner. Calculated in the same pass as the text, since there is no reason to trim the diff twice.
 */
export function prDiffPayload(context: RoutePayloadContext, budgetBytes: number): PatchedContext {
    return prContext(context, budgetBytes);
}

/**
 * The slice between iterations for regeneration tasks uses the same patches and line-number gutter, but
 * its old side is the head of the previous route's iteration, and its new side is the head of this generation's iteration.
 * It has its own budget. The interdiff must not displace the PR diff used for anchors.
 */
export function interdiffContext(interdiff: PrDiff, budgetBytes: number): string {
    return patchedContext(interdiff, interdiffHead(interdiff), budgetBytes, INTERDIFF_PATCHES_HEADING).content;
}

/** Slice header explaining which patches these are, which commits they compare and how to read them. */
function interdiffHead(interdiff: PrDiff): string {
    const additions = interdiff.files.reduce((total, file) => total + file.additions, 0);
    const deletions = interdiff.files.reduce((total, file) => total + file.deletions, 0);
    const rows = interdiff.files.map((file, index) =>
        row([
            fileNumber(index),
            `\`${file.path}\``,
            file.changeType,
            `+${String(file.additions)} / -${String(file.deletions)}`,
            fileNotes(file),
        ]),
    );
    return [
        `# Interdiff ${shortCommit(interdiff.baseCommit)} -> ${shortCommit(interdiff.headCommit)}`,
        '',
        'What the author pushed after the previous route was built. The old side of these patches is',
        'the commit of the previous route, the new side is the commit this task works on. This is not',
        'the diff of the pull request: it never replaces the file list you must cover.',
        '',
        `- Slice: ${interdiff.baseCommit} -> ${interdiff.headCommit}`,
        `- Volume: ${String(interdiff.files.length)} files, +${String(additions)} / -${String(deletions)} lines`,
        '',
        '## Files the push touched',
        '',
        '| file # | file | change | +/- | notes |',
        '|---|---|---|---|---|',
        ...rows,
    ].join('\n');
}

/** A commit in the same short form the UI displays. */
function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

/**
 * A section task's own file with the full route plan, target stops marked and their intents.
 * The diff is shared and absent here. Stops have no anchors until filled, so the model decides
 * which files belong to a stop. There is no basis for trimming the diff to "the stop's files".
 */
export function sectionPlanContext(
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
    locale: Locale = 'en',
): string {
    return `${planBlock(planIndexes, stops, intents, locale)}\n`;
}

/**
 * Patch block header. Patches include a line-number gutter, so this also explains how to read it.
 * Section anchors use absolute line numbers. The model must not compute them from hunk headers
 * because an offset of a couple of lines causes acceptance to reject the anchor.
 */
const GUTTER_EXPLAINED = [
    'Every patch line is printed with its line numbers in front of it: `old new | line`.',
    '`old` is the number on the old side of the file, `new` on the new side, `.` means the line does',
    'not exist on that side. Added (`+`) lines are numbered on the new side only, deleted (`-`) lines',
    'on the old side only, unchanged context lines exist on both. Hunk headers (`@@`) carry no',
    'numbers of their own.',
].join('\n');

const PATCHES_HEADING = [
    '## Patches',
    '',
    GUTTER_EXPLAINED,
    '',
    'Line anchors of a stop are validated against exactly these printed numbers: read them off the',
    'gutter, never count lines yourself.',
].join('\n');

/**
 * Slice patch header. The gutter is the same, but it cannot be used for anchors. The slice's old side is
 * the previous iteration's head, while `side: 'old'` resolves against the PR base. The new side also has a gap
 * (a line a push restores to its base value is `+` in the slice but context in the PR diff).
 */
const INTERDIFF_PATCHES_HEADING = [
    '## Patches of the push',
    '',
    GUTTER_EXPLAINED,
    '',
    'Never take line anchors from here. These numbers belong to the slice: its old side is the commit',
    'of the previous route, not the base of the pull request, and its new side marks lines the push',
    'moved, not lines the pull request changed. Anchors are read off the gutter of the pull request',
    'diff and validated against it alone. This file tells you what moved, nothing more.',
].join('\n');

/**
 * PR context within budget: header, full file list and patches. The budget covers the entire
 * output file, including block separators. Otherwise "no more than N bytes" stops being
 * true exactly when it matters (docs/architecture.md §7.5).
 */
function prContext(context: RoutePayloadContext, budgetBytes: number): PatchedContext {
    const { diff, meta } = context;
    return patchedContext(diff, [metaBlock(diff, meta), fileListBlock(diff)].join('\n\n'), budgetBytes);
}

/** The finished context file and what it lacks compared with the full diff. */
interface PatchedContext {
    readonly content: string;
    readonly cap: UiGenerationCap;
}

/**
 * Header and patches within a budget. Shared printer for the PR diff and slice between iterations. Their patch
 * headers differ because the PR diff supports anchors and the slice does not.
 */
function patchedContext(
    diff: PrDiff,
    head: string,
    budgetBytes: number,
    patchesHeading: string = PATCHES_HEADING,
): PatchedContext {
    const sections = diff.files.map((file, index) => ({
        file,
        index,
        full: patchBlock(file, index, false),
        omitted: patchBlock(file, index, true),
    }));

    const fixed = [head, patchesHeading];
    const blockCount = fixed.length + sections.length;
    // `join('\n\n')` and the trailing newline also take bytes in the file.
    let size =
        fixed.reduce((total, block) => total + byteLength(block), 0) +
        sections.reduce((total, section) => total + byteLength(section.full), 0) +
        2 * (blockCount - 1) +
        1;

    const kept = new Set(sections.map((section) => section.index));
    for (const section of dropOrder(sections)) {
        if (size <= budgetBytes) {
            break;
        }
        const saved = byteLength(section.full) - byteLength(section.omitted);
        // The truncation note can be longer than the patch itself. Such files cannot be trimmed.
        if (saved <= 0) {
            continue;
        }
        kept.delete(section.index);
        size -= saved;
    }

    const patches = sections.map((section) => (kept.has(section.index) ? section.full : section.omitted));
    const dropped = sections.filter((section) => !kept.has(section.index));
    return {
        content: `${[...fixed, ...patches].join('\n\n')}\n`,
        cap: {
            filesCovered: kept.size,
            filesTotal: sections.length,
            // Rank 0 means exactly "generated and not a test": a generated snapshot test is trimmed like
            // regular code, so counting it in the generated group would be false.
            machineFiles: dropped.filter((section) => protectionRank(section.file) === 0).length,
            truncated: dropped.some((section) => protectionRank(section.file) >= 1),
        },
    };
}

/**
 * Truncation order. Generated files go first (the team does not require their review),
 * tests last. Within each group, trim the largest patch first to free up budget
 * while losing as few files as possible. The path breaks ties deterministically.
 */
function dropOrder<T extends { file: FileDiff; full: string }>(sections: readonly T[]): T[] {
    return [...sections].sort((left, right) => {
        const rank = protectionRank(left.file) - protectionRank(right.file);
        if (rank !== 0) {
            return rank;
        }
        const size = byteLength(right.full) - byteLength(left.full);
        return size !== 0 ? size : left.file.path.localeCompare(right.file.path);
    });
}

/**
 * Protection rank: 0 is trimmed first, 2 last. Test protection overrides the generated flag:
 * the host correctly marks snapshot tests as generated, but the digest still needs their lines for
 * `testPath`/`testLine`.
 */
function protectionRank(file: FileDiff): number {
    if (isTestPath(file.path)) {
        return 2;
    }
    return file.generated ? 0 : 1;
}

/** Identifies test files by path, using a test directory or filename suffix. Does not parse contents. */
const TEST_PATH = /(^|\/)(tests?|spec|specs|__tests__)(\/|$)|[._-](test|spec|tests|specs)\.[^/]+$/i;

function isTestPath(filePath: string): boolean {
    return TEST_PATH.test(filePath);
}

function metaBlock(diff: PrDiff, meta: PrMeta | null): string {
    const additions = diff.files.reduce((total, file) => total + file.additions, 0);
    const deletions = diff.files.reduce((total, file) => total + file.deletions, 0);
    const lines = ['# Pull request'];
    if (meta !== null) {
        const { login, displayName } = meta.author;
        const author = displayName === null ? login : `${login} (${displayName})`;
        lines.push(
            '',
            `- Title: ${meta.title}`,
            `- Author: ${author}`,
            `- Branches: ${meta.fromBranch} -> ${meta.toBranch}`,
            `- State: ${meta.state} (${meta.statusLabel})`,
        );
    } else {
        lines.push('', '- The host adapter gave no pull request metadata: judge by the diff alone.');
    }
    lines.push(
        `- Diff: base ${diff.baseCommit} -> head ${diff.headCommit}`,
        `- Volume: ${String(diff.files.length)} files, +${String(additions)} / -${String(deletions)} lines`,
    );
    return lines.join('\n');
}

/** Full list of changed files. Never truncated because the coverage rule requires knowing every file. */
function fileListBlock(diff: PrDiff): string {
    const rows = diff.files.map((file, index) =>
        row([
            fileNumber(index),
            `\`${file.path}\``,
            file.changeType,
            `+${String(file.additions)} / -${String(file.deletions)}`,
            fileNotes(file),
        ]),
    );
    return [
        `## Changed files (${String(diff.files.length)}, complete list)`,
        '',
        'This list is never truncated, even when patches below are. Every file here must be accounted',
        'for by the route: placed in a stop, or knowingly left to the synthetic last stop.',
        '',
        '| file # | file | change | +/- | notes |',
        '|---|---|---|---|---|',
        ...rows,
    ].join('\n');
}

function fileNotes(file: FileDiff): string {
    const notes: string[] = [];
    if (file.generated) {
        notes.push('generated, no review required');
    }
    if (file.binary) {
        notes.push('binary');
    }
    if (file.oldPath !== null && file.oldPath !== file.path) {
        notes.push(`was \`${file.oldPath}\``);
    }
    return notes.join('; ');
}

function patchBlock(file: FileDiff, index: number, omit: boolean): string {
    const stats = `+${String(file.additions)} / -${String(file.deletions)}`;
    const header = `### File ${fileNumber(index)}. \`${file.path}\` — ${file.changeType}, ${stats}`;
    if (file.patch === null) {
        const reason = file.binary ? 'binary file' : 'the host gave no textual patch';
        return `${header}\n\nno patch — ${reason}; use the stats above; the file still must be placed`;
    }
    if (omit) {
        const lines = file.additions + file.deletions;
        return `${header}\n\npatch omitted — ${String(lines)} lines, use the stats above; the file still must be placed`;
    }

    const body = numberedPatch(file.patch);
    const fence = '`'.repeat(fenceLength(body));
    return `${header}\n\n${fence}text\n${body}\n${fence}`;
}

/** Gutter column width. Reviews do not have six-digit line numbers. */
const GUTTER_WIDTH = 5;
/** No line on this side. An added line has no old number, a deleted line has no new one. */
const NO_LINE = '.';

/**
 * Patch with line numbers for both sides in the gutter: `old new | line`. `walkPatch` computes them using
 * the same hunk scan the validator later uses to resolve anchors, so the printed and accepted
 * numbers are identical by construction.
 */
function numberedPatch(patch: string): string {
    const lines = [...walkPatch(patch)];
    // A patch ending with a newline leaves an empty tail. It is a split artifact, not a file line.
    const last = lines.at(-1);
    if (last?.raw === '' && last.old === null && last.new === null) {
        lines.pop();
    }
    return lines.map((line) => `${gutterCell(line.old)} ${gutterCell(line.new)} | ${line.raw}`).join('\n');
}

function gutterCell(value: number | null): string {
    return (value === null ? NO_LINE : String(value)).padStart(GUTTER_WIDTH, ' ');
}

/** Code block fence longer than the longest run of backticks inside the patch. */
function fenceLength(patch: string): number {
    const runs = patch.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return Math.max(3, longest + 1);
}

/** Route plan for a section task. Target stops are marked, and each stop has its intent. */
function planBlock(
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
    locale: Locale,
): string {
    const targets = new Set(planIndexes);
    const ordered = [...stops].sort((left, right) => left.planIndex - right.planIndex);

    const rows = ordered.map((stop) =>
        row([String(stop.planIndex), stop.tier, stop.title, planRole(stop, targets)]),
    );

    const targetBlocks = ordered
        .filter((stop) => targets.has(stop.planIndex))
        .map((stop) =>
            [
                `### Stop ${String(stop.planIndex)} — ${stop.tier} — ${stop.title}`,
                '',
                `Intent, written for you by the planner (${promptLocale(locale).inLanguage}, the reviewer never sees it):`,
                '',
                ...(intents.get(stop.planIndex) ?? '(the planner left no intent — go by the title)')
                    .split('\n')
                    .map((line) => `> ${line}`),
            ].join('\n'),
        );

    const others = ordered
        .filter((stop) => !targets.has(stop.planIndex) && stop.tier !== 'other')
        .map((stop) => {
            const intent = intents.get(stop.planIndex) ?? '—';
            return `- stop ${String(stop.planIndex)} (${stop.tier}) ${stop.title} — ${intent}`;
        });

    return [
        '# Route plan (fixed by the server)',
        '',
        'The plan is already accepted and its numbers are stable: `planIndex` is the number printed',
        'here, written as a plain JSON number (stop 3 is `"planIndex": 3`, never `"03"`). Do not confuse',
        'these stop numbers with the `file #` column of the changed files list, which lives in the shared',
        'pull request file of this task.',
        'Fill in the stops marked as your target and no others.',
        '',
        '| stop # | tier | title | |',
        '|---|---|---|---|',
        ...rows,
        '',
        '## Your target stops',
        '',
        // Blank line between blocks so the next heading does not attach to the intent quote.
        targetBlocks.join('\n\n'),
        '',
        '## The other stops — context only, do not fill them in',
        '',
        ...(others.length === 0 ? ['- none'] : others),
        '',
        'Their lines belong to them: do not anchor the same range twice, and use `bridge` to hand the',
        'reviewer over to the next stop in the order above.',
    ].join('\n');
}

/** Stop role in a section task: target, neighbour or the server's synthetic "Other". */
function planRole(stop: RouteStop, targets: ReadonlySet<number>): string {
    if (targets.has(stop.planIndex)) {
        return '**your target**';
    }
    return stop.tier === 'other' ? 'synthetic, filled by the server' : 'other stop';
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}

/**
 * File-list numbers have two digits ("03 / 07") so the list and patch headers line up.
 * Stop numbers do not use this format. The model returns `planIndex` as a number, and "03" in its JSON
 * fails acceptance.
 */
function fileNumber(index: number): string {
    return pad2(index + 1);
}

function pad2(value: number): string {
    return value < 10 ? `0${String(value)}` : String(value);
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}
