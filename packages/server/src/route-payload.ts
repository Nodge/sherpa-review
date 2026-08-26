import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { FileDiff, PrDiff, PrMeta, RouteStop } from '@sherpa/protocol';
import { generateJsonSchemas } from '@sherpa/protocol';

import type { EnqueueInput } from './queue.js';
import { SECTION_GUIDE, sectionInstructions, SKELETON_GUIDE, skeletonInstructions } from './route-prompts.js';
import { walkPatch } from './route/diff-index.js';

/**
 * Route generation task payloads (rpc-design §4): large context goes in files, instructions in
 * stdout, and the result schema as part of the task.
 *
 * Each task is self-contained. The agent session may have died and reconnected, so the payload
 * carries everything needed: the guide, PR diff and (for sections) the route plan. The text is English for the
 * model. The model writes result text in Russian.
 *
 * Priority is background. Route generation takes minutes and must not run ahead of work the reviewer
 * is waiting for on screen (rpc-design §5).
 *
 * Writes are synchronous. The orchestrator enqueues tasks during synchronous reconciliation, which
 * runs from a queue subscriber and the result acceptance handler. Payload files total hundreds of kilobytes per
 * generation and are written only a handful of times per route, so synchronous writes cost less than
 * an asynchronous state machine around them.
 */

/**
 * Budget for the diff context file, in bytes (requirements §3.5, decision 5). ~320 KB is roughly
 * 80 thousand tokens. A large PR fits in full, while a pathological one (generated assets,
 * megabytes of snapshot tests) is truncated so it cannot consume the model context window and ruin latency.
 * The changed file list is outside the budget and is never truncated.
 */
export const CONTEXT_BUDGET_BYTES = 320 * 1024;

/** Payload directories have the same 0700 permissions as the rest of the PR state (requirements §6). */
const DIR_MODE = 0o700;
/** The payload has no secrets, but outsiders have no reason to read it either. */
const FILE_MODE = 0o600;

/** PR data the builder needs. The diff is required. Metadata is optional (its failure does not break the route). */
export interface RoutePayloadContext {
    readonly diff: PrDiff;
    readonly meta: PrMeta | null;
}

export interface RoutePayloadWriterOptions {
    /** Payload directory inside the PR state directory. Generation subdirectories are created here. */
    readonly payloadDir: string;
    readonly budgetBytes?: number;
}

/**
 * Write route task payloads to disk. Each generation gets one subdirectory. A new
 * generation creates its own and removes previous ones to keep the directory from growing without bounds.
 */
export class RoutePayloadWriter {
    private readonly payloadDir: string;
    private readonly budgetBytes: number;
    private generationDir: string | null = null;

    constructor(options: RoutePayloadWriterOptions) {
        this.payloadDir = options.payloadDir;
        this.budgetBytes = options.budgetBytes ?? CONTEXT_BUDGET_BYTES;
    }

    /** A new generation gets a fresh subdirectory. Previous ones are removed. */
    beginGeneration(): void {
        this.startGeneration();
    }

    /** The `route.skeleton` task returns the summary, stop plan and Full tour order in one result. */
    skeletonTask(context: RoutePayloadContext): EnqueueInput {
        const guide = this.writeFile('skeleton-guide.md', SKELETON_GUIDE);
        const pr = this.writeFile('skeleton-context.md', skeletonContext(context, this.budgetBytes));
        return {
            type: 'route.skeleton',
            priority: 'background',
            instructions: skeletonInstructions(),
            contextFiles: [guide, pr],
            resultSchemaFile: this.writeSchema('skeleton'),
        };
    }

    /**
     * The `route.section` task fills one or more planned stops. Target numbers go
     * in the task text. `taskSchema` has no separate field, so the server controls batching.
     * "Other" has no sections. The skeleton synthesized it, and the UI computes its contents.
     */
    sectionTask(
        context: RoutePayloadContext,
        planIndexes: readonly number[],
        stops: readonly RouteStop[],
        intents: ReadonlyMap<number, string>,
    ): EnqueueInput {
        const guide = this.writeFile('section-guide.md', SECTION_GUIDE);
        const name = `section-${planIndexes.map(pad2).join('-')}-context.md`;
        const pr = this.writeFile(name, sectionContext(context, planIndexes, stops, intents, this.budgetBytes));
        return {
            type: 'route.section',
            priority: 'background',
            instructions: sectionInstructions(planIndexes),
            contextFiles: [guide, pr],
            resultSchemaFile: this.writeSchema('section'),
        };
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

    /** Result schema as a file (rpc-design §4). Zod is canonical, JSON Schema is derived. */
    private writeSchema(kind: 'skeleton' | 'section'): string {
        const key = kind === 'skeleton' ? 'routeSkeletonResult' : 'routeSectionResult';
        const schema = generateJsonSchemas()[key];
        return this.writeFile(`route-${kind}-result.schema.json`, `${JSON.stringify(schema, null, 2)}\n`);
    }
}

/** Skeleton task context file: PR header, full file list and patches within budget. */
export function skeletonContext(context: RoutePayloadContext, budgetBytes: number): string {
    return prContext(context, budgetBytes, { protectTests: false, prefix: null });
}

/**
 * Section task context file: the whole route plan with target stops marked, followed by
 * the same diff. A stop has no anchors until it is filled, so the model decides which files
 * belong to it. There is no basis for trimming the diff to "the stop's files".
 */
export function sectionContext(
    context: RoutePayloadContext,
    planIndexes: readonly number[],
    stops: readonly RouteStop[],
    intents: ReadonlyMap<number, string>,
    budgetBytes: number,
): string {
    const prefix = planBlock(planIndexes, stops, intents);
    // Tests are trimmed last: the digest must anchor to real lines in test files.
    return prContext(context, budgetBytes, { protectTests: true, prefix });
}

interface ContextOptions {
    readonly protectTests: boolean;
    /** Block before the diff (the route plan for sections). */
    readonly prefix: string | null;
}

/**
 * Patch block header. Patches include a line-number gutter, so this also explains how to read it.
 * Section anchors use absolute line numbers. The model must not compute them from hunk headers
 * because an offset of a couple of lines causes acceptance to reject the anchor.
 */
const PATCHES_HEADING = [
    '## Patches',
    '',
    'Every patch line is printed with its line numbers in front of it: `old new | line`.',
    '`old` is the number on the old side of the file, `new` on the new side, `.` means the line does',
    'not exist on that side. Added (`+`) lines are numbered on the new side only, deleted (`-`) lines',
    'on the old side only, unchanged context lines exist on both. Hunk headers (`@@`) carry no',
    'numbers of their own.',
    '',
    'Line anchors of a stop are validated against exactly these printed numbers: read them off the',
    'gutter, never count lines yourself.',
].join('\n');

/**
 * PR context within budget: header, full file list and patches. The budget covers the entire
 * output file, including block separators. Otherwise "no more than N bytes" stops being
 * true exactly when it matters (requirements §3.5).
 */
function prContext(context: RoutePayloadContext, budgetBytes: number, options: ContextOptions): string {
    const { diff, meta } = context;
    const head = [metaBlock(diff, meta), fileListBlock(diff)].join('\n\n');
    const sections = diff.files.map((file, index) => ({
        file,
        index,
        full: patchBlock(file, index, false),
        omitted: patchBlock(file, index, true),
    }));

    const fixed = [...(options.prefix === null ? [] : [options.prefix]), head, PATCHES_HEADING];
    const blockCount = fixed.length + sections.length;
    // `join('\n\n')` and the trailing newline also take bytes in the file.
    let size =
        fixed.reduce((total, block) => total + byteLength(block), 0) +
        sections.reduce((total, section) => total + byteLength(section.full), 0) +
        2 * (blockCount - 1) +
        1;

    const kept = new Set(sections.map((section) => section.index));
    for (const section of dropOrder(sections, options.protectTests)) {
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
    return `${[...fixed, ...patches].join('\n\n')}\n`;
}

/**
 * Truncation order. Generated files go first (the team does not require their review),
 * tests in section payloads go last. Within each group, the largest patch goes first: it
 * frees budget with the fewest files lost. The path breaks ties deterministically.
 */
function dropOrder<T extends { file: FileDiff; full: string }>(sections: readonly T[], protectTests: boolean): T[] {
    return [...sections].sort((left, right) => {
        const rank = protectionRank(left.file, protectTests) - protectionRank(right.file, protectTests);
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
function protectionRank(file: FileDiff, protectTests: boolean): number {
    if (protectTests && isTestPath(file.path)) {
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
                'Intent, written for you by the planner (Russian, the reviewer never sees it):',
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
        'these stop numbers with the `file #` column of the changed files list below.',
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
