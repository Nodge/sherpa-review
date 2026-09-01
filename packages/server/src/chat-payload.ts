import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type {
    ChatAnchor,
    ChatExchange,
    FileContent,
    FileDiff,
    PrDiff,
    PrMeta,
    RouteSnapshot,
    RouteStop,
    UiRouteState,
} from '@sherpa/protocol';

import { CHAT_GUIDE, chatInstructions } from './chat-prompts.js';
import type { EnqueueInput } from './queue.js';
import type { PatchLine } from './route/diff-index.js';
import { walkPatch } from './route/diff-index.js';

/** Total file budget for one chat payload. */
export const CHAT_PAYLOAD_BUDGET_BYTES = 320 * 1024;
/** Recent completed exchanges sufficient to follow the conversation. */
export const CHAT_HISTORY_EXCHANGES = 8;
/** Hard limit for a single history exchange so the question and answer cannot crowd out code context. */
export const CHAT_HISTORY_EXCHANGE_BYTES = 8 * 1024;

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const GUTTER_WIDTH = 5;
const NO_LINE = '.';

export interface ChatPayloadContext {
    readonly question: string;
    readonly anchor: ChatAnchor | null;
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly fileContent: FileContent | null;
    readonly route: UiRouteState;
    readonly history: readonly ChatExchange[];
}

export interface ChatPayloadOptions {
    readonly budgetBytes?: number;
}

export interface ChatPayloadFile {
    readonly name: string;
    readonly content: string;
}

export interface ChatPayload {
    readonly instructions: string;
    readonly files: readonly ChatPayloadFile[];
}

interface PayloadFileSpec {
    readonly name: string;
    readonly order: number;
    readonly minimum: string;
    readonly render: (maxBytes: number) => string;
}

/** Builds a self-contained set of question files within the total budget. */
export function buildChatPayload(context: ChatPayloadContext, options: ChatPayloadOptions = {}): ChatPayload {
    const budgetBytes = options.budgetBytes ?? CHAT_PAYLOAD_BUDGET_BYTES;
    const specs =
        context.anchor === null ? prPayloadSpecs(context) : anchoredPayloadSpecs(context, context.anchor);
    return {
        instructions: chatInstructions(),
        files: fitPayloadFiles(specs, budgetBytes).sort((left, right) => left.order - right.order),
    };
}

/** Materializes a separate question directory: retry does not overwrite the previous task payload. */
export async function materializeChatPayload(payloadDir: string, payload: ChatPayload): Promise<EnqueueInput> {
    await fs.mkdir(payloadDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(payloadDir, DIR_MODE);

    const taskDir = path.join(payloadDir, randomUUID());
    await fs.mkdir(taskDir, { mode: DIR_MODE });
    await fs.chmod(taskDir, DIR_MODE);

    const contextFiles: string[] = [];
    for (const file of payload.files) {
        const filePath = path.join(taskDir, file.name);
        await fs.writeFile(filePath, file.content, { encoding: 'utf8', mode: FILE_MODE });
        contextFiles.push(filePath);
    }

    return {
        type: 'chat',
        priority: 'interactive',
        instructions: payload.instructions,
        contextFiles,
    };
}

function anchoredPayloadSpecs(context: ChatPayloadContext, anchor: ChatAnchor): PayloadFileSpec[] {
    const file = fileOf(context.diff, anchor);
    const selection = selectedPatchContext(anchor, file);
    const route = anchoredRouteContext(anchor, context.route.snapshot);
    const history = historyContext(context.history);
    const fileMinimum = unavailableBlock(
        'Surrounding file',
        'The surrounding file did not fit in the chat payload budget.',
    );

    return [
        fixedSpec('chat-guide.md', 0, CHAT_GUIDE),
        fixedSpec('question.md', 1, questionContext(context.question, anchor, context.pr)),
        flexibleSpec('selection.patch.md', 2, selection),
        flexibleSpec('route-context.md', 4, route),
        flexibleSpec('history.md', 5, history),
        {
            name: 'file-context.md',
            order: 3,
            minimum: fileMinimum,
            render: (maxBytes) => surroundingFileContext(anchor, context.fileContent, maxBytes),
        },
    ];
}

function prPayloadSpecs(context: ChatPayloadContext): PayloadFileSpec[] {
    const prMinimum = unavailableBlock('Pull request context', 'This context did not fit in the chat payload budget.');
    return [
        fixedSpec('chat-guide.md', 0, CHAT_GUIDE),
        fixedSpec('question.md', 1, questionContext(context.question, null, context.pr)),
        {
            name: 'pr-context.md',
            order: 2,
            minimum: prMinimum,
            render: (maxBytes) => prLevelContext(context.pr, context.diff, context.route.snapshot, maxBytes),
        },
        flexibleSpec('history.md', 3, historyContext(context.history)),
    ];
}

function fixedSpec(name: string, order: number, content: string): PayloadFileSpec {
    const minimum = unavailableBlock(name, 'This file was truncated by the chat payload budget.');
    return { name, order, minimum, render: (maxBytes) => fitText(content, maxBytes, minimum) };
}

function flexibleSpec(name: string, order: number, content: string): PayloadFileSpec {
    const minimum = unavailableBlock(name, 'This context did not fit in the chat payload budget.');
    return { name, order, minimum, render: (maxBytes) => fitText(content, maxBytes, minimum) };
}

/**
 * Array order sets priority. `order` only sets the order of task paths. The remaining budget
 * always reserves a notice for files not yet built.
 */
function fitPayloadFiles(
    specs: readonly PayloadFileSpec[],
    budgetBytes: number,
): (ChatPayloadFile & { order: number })[] {
    const budget = Math.max(0, budgetBytes);
    const files: (ChatPayloadFile & { order: number })[] = [];
    let used = 0;

    for (let index = 0; index < specs.length; index += 1) {
        const spec = specs[index];
        if (spec === undefined) {
            continue;
        }
        const reserve = specs
            .slice(index + 1)
            .reduce((total, next) => total + byteLength(next.minimum), 0);
        const maxBytes = Math.max(0, budget - used - reserve);
        const content = fitText(spec.render(maxBytes), maxBytes, spec.minimum);
        used += byteLength(content);
        files.push({ name: spec.name, content, order: spec.order });
    }

    return files;
}

function questionContext(question: string, anchor: ChatAnchor | null, pr: PrMeta | null): string {
    const scope =
        anchor === null
            ? 'Whole pull request.'
            : `Selected range: ${anchor.path}:${String(anchor.start)}-${String(anchor.end)} (${anchor.side} side).`;
    const prLines =
        pr === null
            ? ['Pull request metadata is unavailable.']
            : [`Pull request: ${pr.title}`, `URL: ${pr.url}`];
    return ['# Reviewer question', '', question, '', `Scope: ${scope}`, ...prLines, ''].join('\n');
}

/** Patch for the selected range. The same `walkPatch` numbers lines and validates route anchors. */
export function selectedPatchContext(anchor: ChatAnchor, file: FileDiff | null): string {
    const heading = [
        '# Selected patch range',
        '',
        `File: ${anchor.path}`,
        `Anchor: ${anchor.side} ${String(anchor.start)}-${String(anchor.end)} (inclusive)`,
        '',
        'Gutter: `old new | line`; `.` means the line does not exist on that side.',
        'Numbers are produced by the same patch walk used for anchor validation.',
        '',
    ];
    if (file === null) {
        return [...heading, '[UNAVAILABLE: the selected file is absent from the active diff.]', ''].join('\n');
    }
    if (file.patch === null) {
        const reason = file.binary ? 'the selected file is binary' : 'the host supplied no textual patch';
        return [...heading, `[UNAVAILABLE: ${reason}.]`, ''].join('\n');
    }

    const blocks = selectedPatchBlocks(file.patch, anchor);
    if (blocks.length === 0) {
        return [
            ...heading,
            '[UNAVAILABLE: the selected range is outside the textual patch supplied by the host.]',
            '',
        ].join('\n');
    }
    return [...heading, ...blocks, ''].join('\n');
}

interface PatchGroup {
    readonly header: PatchLine;
    readonly body: PatchLine[];
}

function selectedPatchBlocks(patch: string, anchor: ChatAnchor): string[] {
    const groups: PatchGroup[] = [];
    let current: { header: PatchLine; body: PatchLine[] } | null = null;
    for (const line of walkPatch(patch)) {
        if (line.raw.startsWith('@@ ')) {
            current = { header: line, body: [] };
            groups.push(current);
        } else if (current !== null) {
            current.body.push(line);
        }
    }

    const blocks: string[] = [];
    for (const group of groups) {
        let first = group.body.findIndex((line) => lineInAnchor(line, anchor));
        if (first === -1) {
            continue;
        }
        let last = group.body.length - 1;
        while (last >= first) {
            const line = group.body[last];
            if (line === undefined || lineInAnchor(line, anchor)) {
                break;
            }
            last -= 1;
        }
        while (first > 0) {
            const line = group.body[first - 1];
            if (line === undefined || !oppositeChangedLine(line, anchor.side)) {
                break;
            }
            first -= 1;
        }
        while (last + 1 < group.body.length) {
            const line = group.body[last + 1];
            if (line === undefined || !oppositeChangedLine(line, anchor.side)) {
                break;
            }
            last += 1;
        }
        blocks.push([formatPatchLine(group.header), ...group.body.slice(first, last + 1).map(formatPatchLine)].join('\n'));
    }
    return blocks;
}

function lineInAnchor(line: PatchLine, anchor: ChatAnchor): boolean {
    const number = line[anchor.side];
    return number !== null && number >= anchor.start && number <= anchor.end;
}

function oppositeChangedLine(line: PatchLine, side: ChatAnchor['side']): boolean {
    return line.changed && line[side] === null;
}

function formatPatchLine(line: PatchLine): string {
    return `${gutterCell(line.old)} ${gutterCell(line.new)} | ${line.raw}`;
}

function gutterCell(value: number | null): string {
    return (value === null ? NO_LINE : String(value)).padStart(GUTTER_WIDTH, ' ');
}

/** Full file on the requested side, centered on the anchor. Adds both markers when truncated. */
export function surroundingFileContext(
    anchor: ChatAnchor,
    content: FileContent | null,
    budgetBytes: number,
): string {
    const heading = [
        '# Surrounding file',
        '',
        `File: ${anchor.path}`,
        `Side: ${anchor.side}`,
        'Gutter: `line | content`.',
        '',
    ].join('\n');
    if (content === null) {
        return fitText(
            `${heading}[UNAVAILABLE: the host could not provide full contents of the selected file.]\n`,
            budgetBytes,
            unavailableBlock('Surrounding file', 'The host could not provide this context.'),
        );
    }

    const text = anchor.side === 'old' ? content.oldText : content.newText;
    if (text === null) {
        return fitText(
            `${heading}[UNAVAILABLE: this side of the selected file does not exist.]\n`,
            budgetBytes,
            unavailableBlock('Surrounding file', 'The selected side does not exist.'),
        );
    }

    const rawLines = text.split('\n');
    const width = Math.max(1, String(rawLines.length).length);
    const lines = rawLines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`);
    const full = `${heading}${lines.join('\n')}\n`;
    if (byteLength(full) <= budgetBytes) {
        return full;
    }

    const topMarker = '[TRUNCATED: earlier file lines omitted by the chat payload budget.]';
    const bottomMarker = '[TRUNCATED: later file lines omitted by the chat payload budget.]';
    const frameBytes = byteLength([heading.trimEnd(), '', topMarker, '', bottomMarker, ''].join('\n'));
    if (frameBytes >= budgetBytes) {
        return fitText(full, budgetBytes, unavailableBlock('Surrounding file', 'File context was truncated.'));
    }

    const bodyBudget = budgetBytes - frameBytes;
    const anchorStart = Math.min(Math.max(anchor.start - 1, 0), Math.max(lines.length - 1, 0));
    const anchorEnd = Math.min(Math.max(anchor.end, anchorStart + 1), lines.length);
    let start = anchorStart;
    let end = anchorStart;
    let used = 0;

    while (end < anchorEnd) {
        const next = byteLength(`${lines[end] ?? ''}\n`);
        if (used + next > bodyBudget) {
            break;
        }
        used += next;
        end += 1;
    }

    let takeAbove = true;
    let aboveOpen = start > 0;
    let belowOpen = end < lines.length;
    while (aboveOpen || belowOpen) {
        const useAbove = takeAbove ? aboveOpen : !belowOpen && aboveOpen;
        const index = useAbove ? start - 1 : end;
        const next = byteLength(`${lines[index] ?? ''}\n`);
        if (used + next > bodyBudget) {
            if (useAbove) {
                aboveOpen = false;
            } else {
                belowOpen = false;
            }
        } else if (useAbove) {
            start = index;
            used += next;
            aboveOpen = start > 0;
        } else {
            end = index + 1;
            used += next;
            belowOpen = end < lines.length;
        }
        takeAbove = !takeAbove;
    }

    const body = lines.slice(start, end);
    const result = [heading.trimEnd(), ...(start > 0 ? ['', topMarker] : []), '', ...body, ...(end < lines.length ? ['', bottomMarker] : []), ''].join(
        '\n',
    );
    return fitText(result, budgetBytes, unavailableBlock('Surrounding file', 'File context was truncated.'));
}

function anchoredRouteContext(anchor: ChatAnchor, snapshot: RouteSnapshot | null): string {
    if (snapshot === null) {
        return unavailableBlock('Route context', 'No route snapshot is available for this pull request.');
    }
    const stops = snapshot.stops.filter((stop) => stopOverlaps(stop, anchor));
    const blocks = stops.map((stop) => stopBlock(stop, anchor));
    return [
        '# Route context',
        '',
        '## Pull request summary',
        '',
        snapshot.summary || '[UNAVAILABLE: the route summary is empty.]',
        '',
        '## Route stops overlapping the selected range',
        '',
        ...(blocks.length === 0 ? ['No route stop anchor overlaps this selected range.'] : blocks),
        '',
    ].join('\n');
}

function stopOverlaps(stop: RouteStop, anchor: ChatAnchor): boolean {
    return stop.anchors.some(
        (candidate) =>
            (candidate.fileId === anchor.fileId || candidate.path === anchor.path) &&
            candidate.side === anchor.side &&
            candidate.start <= anchor.end &&
            candidate.end >= anchor.start,
    );
}

function stopBlock(stop: RouteStop, anchor: ChatAnchor): string {
    const anchors = stop.anchors
        .filter(
            (candidate) =>
                (candidate.fileId === anchor.fileId || candidate.path === anchor.path) &&
                candidate.side === anchor.side &&
                candidate.start <= anchor.end &&
                candidate.end >= anchor.start,
        )
        .map((candidate) => `- ${candidate.path}:${String(candidate.start)}-${String(candidate.end)} (${candidate.side})`);
    return [
        `### Stop ${String(stop.planIndex)}: ${stop.title}`,
        '',
        `Tier: ${stop.tier}; status: ${stop.status}.`,
        ...(stop.paragraph === null ? [] : ['', stop.paragraph]),
        ...(stop.bridge === null ? [] : ['', `Bridge: ${stop.bridge}`]),
        '',
        ...anchors,
    ].join('\n');
}

const PR_PATCHES_HEADING = [
    '## Patches',
    '',
    'Every patch line uses the `old new | line` gutter. `.` means that side has no line.',
].join('\n');

/** Whole-PR question context: header and plan are protected, patches use the remaining budget. */
function prLevelContext(
    pr: PrMeta | null,
    diff: PrDiff | null,
    snapshot: RouteSnapshot | null,
    budgetBytes: number,
): string {
    const meta =
        pr === null
            ? ['# Pull request', '', '[UNAVAILABLE: pull request metadata is not available.]']
            : [
                  '# Pull request',
                  '',
                  `Title: ${pr.title}`,
                  `URL: ${pr.url}`,
                  `Branches: ${pr.fromBranch} -> ${pr.toBranch}`,
                  `State: ${pr.state} (${pr.statusLabel})`,
              ];
    const route =
        snapshot === null
            ? ['## Route summary and plan', '', '[UNAVAILABLE: no route snapshot is available.]']
            : [
                  '## Route summary and plan',
                  '',
                  snapshot.summary || '[UNAVAILABLE: the route summary is empty.]',
                  '',
                  ...routePlan(snapshot),
              ];
    const files =
        diff === null
            ? ['## Changed files', '', '[UNAVAILABLE: the host could not provide the active diff.]']
            : [
                  `## Changed files (${String(diff.files.length)})`,
                  '',
                  ...diff.files.map(
                      (file) =>
                          `- \`${file.path}\` — ${file.changeType}, +${String(file.additions)} / -${String(file.deletions)}` +
                          `${file.generated ? '; generated, no review required' : ''}${file.binary ? '; binary' : ''}`,
                  ),
              ];
    const head = [...meta, '', ...route, '', ...files].join('\n');
    if (diff === null) {
        return fitText(
            `${head}\n`,
            budgetBytes,
            unavailableBlock('Pull request context', 'The active diff is unavailable.'),
        );
    }

    const sections = diff.files.map((file, index) => ({
        file,
        index,
        full: prPatchBlock(file, index, false),
        omitted: prPatchBlock(file, index, true),
    }));
    const fixed = [head, PR_PATCHES_HEADING];
    const blockCount = fixed.length + sections.length;
    let size =
        fixed.reduce((total, block) => total + byteLength(block), 0) +
        sections.reduce((total, section) => total + byteLength(section.full), 0) +
        2 * (blockCount - 1) +
        1;
    const kept = new Set(sections.map((section) => section.index));
    for (const section of prPatchDropOrder(sections)) {
        if (size <= budgetBytes) {
            break;
        }
        const saved = byteLength(section.full) - byteLength(section.omitted);
        if (saved <= 0) {
            continue;
        }
        kept.delete(section.index);
        size -= saved;
    }

    const patches = sections.map((section) => (kept.has(section.index) ? section.full : section.omitted));
    const result = `${[...fixed, ...patches].join('\n\n')}\n`;
    return fitText(
        result,
        budgetBytes,
        unavailableBlock('Pull request context', 'This context did not fit in the chat payload budget.'),
    );
}

function routePlan(snapshot: RouteSnapshot): string[] {
    const ordered = [...snapshot.stops].sort((left, right) => left.planIndex - right.planIndex);
    const byId = new Map(ordered.map((stop) => [stop.id, stop]));
    const stops = ordered.flatMap((stop) => [
        `#### ${String(stop.planIndex)}. ${stop.title}`,
        '',
        `Tier: ${stop.tier}; status: ${stop.status}.`,
        '',
        stop.paragraph ?? '[UNAVAILABLE: this route stop has no paragraph yet.]',
        '',
    ]);
    return [
        '### Plan order',
        '',
        ...stops,
        '### Full-tour order',
        '',
        ...snapshot.tourOrder.map((id, index) => {
            const stop = byId.get(id);
            return `- ${String(index + 1)}. ${stop === undefined ? id : `${String(stop.planIndex)}. ${stop.title}`}`;
        }),
    ];
}

function prPatchBlock(file: FileDiff, index: number, omit: boolean): string {
    const stats = `+${String(file.additions)} / -${String(file.deletions)}`;
    const header = `### File ${String(index + 1)}. \`${file.path}\` — ${file.changeType}, ${stats}`;
    if (file.patch === null) {
        const reason = file.binary ? 'binary file' : 'the host gave no textual patch';
        return `${header}\n\n[UNAVAILABLE: no patch — ${reason}.]`;
    }
    if (omit) {
        const lines = file.additions + file.deletions;
        return `${header}\n\n[TRUNCATED: patch omitted — ${String(lines)} changed lines; use the stats and changed-file list.]`;
    }

    const body = numberedPatch(file.patch);
    const fence = '`'.repeat(fenceLength(body));
    return `${header}\n\n${fence}text\n${body}\n${fence}`;
}

function numberedPatch(patch: string): string {
    const lines = [...walkPatch(patch)];
    const last = lines.at(-1);
    if (last?.raw === '' && last.old === null && last.new === null) {
        lines.pop();
    }
    return lines.map(formatPatchLine).join('\n');
}

function fenceLength(text: string): number {
    const runs = text.match(/`+/g) ?? [];
    const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
    return Math.max(3, longest + 1);
}

function prPatchDropOrder<T extends { file: FileDiff; full: string }>(sections: readonly T[]): T[] {
    return [...sections].sort((left, right) => {
        const generated = Number(right.file.generated) - Number(left.file.generated);
        if (generated !== 0) {
            return generated;
        }
        const size = byteLength(right.full) - byteLength(left.full);
        return size !== 0 ? size : left.file.path.localeCompare(right.file.path);
    });
}

function historyContext(history: readonly ChatExchange[]): string {
    const completed = history
        .filter((exchange) => exchange.status === 'done' && exchange.answer !== null)
        .slice(-CHAT_HISTORY_EXCHANGES)
        .reverse();
    if (completed.length === 0) {
        return '# Recent completed chat exchanges\n\nNo completed earlier chat exchanges.\n';
    }

    const blocks = completed.map(historyExchangeBlock);
    return ['# Recent completed chat exchanges (newest first)', '', ...blocks, ''].join('\n\n');
}

/** Truncates each past exchange before applying the total budget so it cannot crowd out current code. */
function historyExchangeBlock(exchange: ChatExchange, index: number): string {
    const scope =
        exchange.anchor === null
            ? 'whole pull request'
            : `${exchange.anchor.path}:${String(exchange.anchor.start)}-${String(exchange.anchor.end)} (${exchange.anchor.side})`;
    const beforeAnswer = [
        `## ${String(index + 1)}. Exchange ${String(exchange.id)} — ${scope}`,
        '',
        'Reviewer:',
        '',
        exchange.question,
        '',
        'Agent:',
        '',
    ].join('\n');
    const answer = exchange.answer ?? '';
    const full = `${beforeAnswer}\n${answer}`;
    if (byteLength(full) <= CHAT_HISTORY_EXCHANGE_BYTES) {
        return full;
    }

    const answerMarker =
        `\n\n[TRUNCATED: assistant reply exceeds ${String(CHAT_HISTORY_EXCHANGE_BYTES)} bytes per chat exchange.]`;
    const answerPrefix = `${beforeAnswer}\n`;
    if (byteLength(answerPrefix) + byteLength(answerMarker) <= CHAT_HISTORY_EXCHANGE_BYTES) {
        const available = CHAT_HISTORY_EXCHANGE_BYTES - byteLength(answerPrefix) - byteLength(answerMarker);
        return `${answerPrefix}${truncateUtf8(answer, available).trimEnd()}${answerMarker}`;
    }

    const exchangeMarker =
        `\n\n[TRUNCATED: exchange exceeds ${String(CHAT_HISTORY_EXCHANGE_BYTES)} bytes in chat history.]`;
    const available = CHAT_HISTORY_EXCHANGE_BYTES - byteLength(exchangeMarker);
    return `${truncateUtf8(full, available).trimEnd()}${exchangeMarker}`;
}

function fileOf(diff: PrDiff | null, anchor: ChatAnchor): FileDiff | null {
    if (diff === null) {
        return null;
    }
    return (
        diff.files.find((file) => file.fileId === anchor.fileId) ??
        diff.files.find((file) => file.path === anchor.path) ??
        null
    );
}

function unavailableBlock(heading: string, reason: string): string {
    return `# ${heading}\n\n[TRUNCATED: ${reason}]\n`;
}

function fitText(text: string, maxBytes: number, fallback: string): string {
    const max = Math.max(0, maxBytes);
    if (byteLength(text) <= max) {
        return text;
    }
    if (byteLength(fallback) >= max) {
        return truncateUtf8(fallback, max);
    }
    const marker = '\n\n[TRUNCATED: remaining content omitted by the 320 KB chat payload budget.]\n';
    if (byteLength(marker) >= max) {
        return truncateUtf8(fallback, max);
    }
    const prefix = truncateUtf8(text, max - byteLength(marker)).trimEnd();
    return `${prefix}${marker}`;
}

function truncateUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) {
        return '';
    }
    let low = 0;
    let high = text.length;
    while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (byteLength(text.slice(0, middle)) <= maxBytes) {
            low = middle;
        } else {
            high = middle - 1;
        }
    }
    let end = low;
    if (end > 0 && /[\uD800-\uDBFF]/.test(text.charAt(end - 1))) {
        end -= 1;
    }
    return text.slice(0, end);
}

function byteLength(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}
