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
import { CONTEXT_BUDGET_BYTES, prDiffContext } from './route-payload.js';
import type { PatchLine } from './route/diff-index.js';
import { walkPatch } from './route/diff-index.js';
import type { FileSide, SharedPayloadStore } from './shared-payload.js';
import { diffKeyOf } from './shared-payload.js';

/** Total file budget for the question directory. Shared files have their own budget. */
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
    /** File budget for the question directory. */
    readonly budgetBytes?: number;
    /** Shared file budget (PR diff, file text), separate from task files. */
    readonly sharedBudgetBytes?: number;
}

export interface ChatPayloadFile {
    readonly name: string;
    readonly content: string;
}

/** Immutable question context, written to stable paths under `shared/` instead of copied per task. */
export type SharedChatContext =
    | { readonly kind: 'guide'; readonly name: string; readonly content: string }
    | { readonly kind: 'pr-diff'; readonly diffKey: string; readonly content: string }
    | {
          readonly kind: 'file';
          readonly diffKey: string;
          readonly fileId: string;
          readonly side: FileSide;
          readonly content: string;
      };

export interface ChatPayload {
    readonly instructions: string;
    /** Shared task files, listed first in `contextFiles`. */
    readonly shared: readonly SharedChatContext[];
    /** Files in the question directory. */
    readonly files: readonly ChatPayloadFile[];
}

interface PayloadFileSpec {
    readonly name: string;
    readonly order: number;
    readonly minimum: string;
    readonly render: (maxBytes: number) => string;
}

/**
 * Builds self-contained question context, using shared paths for immutable data and files in the
 * question directory for question-specific data under a total budget.
 */
export function buildChatPayload(context: ChatPayloadContext, options: ChatPayloadOptions = {}): ChatPayload {
    const budgetBytes = options.budgetBytes ?? CHAT_PAYLOAD_BUDGET_BYTES;
    const sharedBudgetBytes = options.sharedBudgetBytes ?? CONTEXT_BUDGET_BYTES;
    const guide: SharedChatContext = { kind: 'guide', name: 'chat-guide', content: CHAT_GUIDE };

    if (context.anchor === null) {
        const diff = sharedPrDiff(context, sharedBudgetBytes);
        return {
            instructions: chatInstructions(),
            shared: diff === null ? [guide] : [guide, diff],
            files: fitOwnFiles(prPayloadSpecs(context), budgetBytes),
        };
    }

    const file = sharedAnchorFile(context, context.anchor, sharedBudgetBytes);
    return {
        instructions: chatInstructions(),
        shared: file === null ? [guide] : [guide, file],
        files: fitOwnFiles(anchoredPayloadSpecs(context, context.anchor, file === null), budgetBytes),
    };
}

/** Directory path for the next question. Retries cannot overwrite an earlier task payload. */
export function questionDirIn(payloadDir: string): string {
    return path.join(payloadDir, randomUUID());
}

/** Materializes the question directory and its shared context. Shared files come first in the task. */
export async function materializeChatPayload(
    taskDir: string,
    shared: SharedPayloadStore,
    payload: ChatPayload,
): Promise<EnqueueInput> {
    const contextFiles = payload.shared.map((entry) => writeShared(shared, entry));

    await fs.mkdir(taskDir, { recursive: true, mode: DIR_MODE });
    await fs.chmod(path.dirname(taskDir), DIR_MODE);
    await fs.chmod(taskDir, DIR_MODE);

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

function writeShared(store: SharedPayloadStore, entry: SharedChatContext): string {
    switch (entry.kind) {
        case 'guide':
            return store.guide(entry.name, entry.content);
        case 'pr-diff':
            return store.prDiff(entry.diffKey, entry.content);
        case 'file':
            return store.fileSide(entry.diffKey, entry.fileId, entry.side, entry.content);
    }
}

/** The diff for a question about the whole PR is the same shared file read by route tasks. */
function sharedPrDiff(context: ChatPayloadContext, budgetBytes: number): SharedChatContext | null {
    const diff = context.diff;
    if (diff === null) {
        return null;
    }
    return {
        kind: 'pr-diff',
        diffKey: diffKeyOf(diff),
        content: prDiffContext({ diff, meta: context.pr }, budgetBytes),
    };
}

/**
 * Shares the surrounding file by path, so two questions about one file share a path. A file over
 * budget is not shared. Its slice is centred on the anchor and lives in the question directory.
 */
function sharedAnchorFile(
    context: ChatPayloadContext,
    anchor: ChatAnchor,
    budgetBytes: number,
): SharedChatContext | null {
    const text = anchor.side === 'old' ? context.fileContent?.oldText : context.fileContent?.newText;
    if (context.diff === null || text === null || text === undefined) {
        return null;
    }

    const content = fullFileContext(anchor.path, anchor.side, text);
    if (byteLength(content) > budgetBytes) {
        return null;
    }
    return { kind: 'file', diffKey: diffKeyOf(context.diff), fileId: anchor.fileId, side: anchor.side, content };
}

function fitOwnFiles(specs: readonly PayloadFileSpec[], budgetBytes: number): ChatPayloadFile[] {
    return fitPayloadFiles(specs, budgetBytes)
        .sort((left, right) => left.order - right.order)
        .map(({ name, content }) => ({ name, content }));
}

function anchoredPayloadSpecs(
    context: ChatPayloadContext,
    anchor: ChatAnchor,
    ownFileContext: boolean,
): PayloadFileSpec[] {
    const file = fileOf(context.diff, anchor);
    const selection = selectedPatchContext(anchor, file);
    const route = anchoredRouteContext(anchor, context.route.snapshot);
    const history = historyContext(context.history);
    const fileMinimum = unavailableBlock(
        'Surrounding file',
        'The surrounding file did not fit in the chat payload budget.',
    );

    return [
        fixedSpec('question.md', 0, questionContext(context.question, anchor, context.pr, context.diff !== null)),
        flexibleSpec('selection.patch.md', 1, selection),
        flexibleSpec('route-context.md', 3, route),
        flexibleSpec('history.md', 4, history),
        ...(ownFileContext
            ? [
                  {
                      name: 'file-context.md',
                      order: 2,
                      minimum: fileMinimum,
                      render: (maxBytes: number): string =>
                          surroundingFileContext(anchor, context.fileContent, maxBytes),
                  },
              ]
            : []),
    ];
}

function prPayloadSpecs(context: ChatPayloadContext): PayloadFileSpec[] {
    return [
        fixedSpec('question.md', 0, questionContext(context.question, null, context.pr, context.diff !== null)),
        flexibleSpec('route-context.md', 1, prRouteContext(context.route.snapshot)),
        flexibleSpec('history.md', 2, historyContext(context.history)),
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

function questionContext(
    question: string,
    anchor: ChatAnchor | null,
    pr: PrMeta | null,
    diffAvailable: boolean,
): string {
    const scope =
        anchor === null
            ? 'Whole pull request.'
            : `Selected range: ${anchor.path}:${String(anchor.start)}-${String(anchor.end)} (${anchor.side} side).`;
    const prLines =
        pr === null
            ? ['Pull request metadata is unavailable.']
            : [`Pull request: ${pr.title}`, `URL: ${pr.url}`];
    // Name the missing diff here, since this task has no shared file containing it.
    const diffLines = diffAvailable ? [] : ['[UNAVAILABLE: the host could not provide the active diff.]'];
    return ['# Reviewer question', '', question, '', `Scope: ${scope}`, ...prLines, ...diffLines, ''].join('\n');
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

/** Full text of one file side with a `line | content` gutter, shared by all questions about this file. */
export function fullFileContext(filePath: string, side: FileSide, text: string): string {
    return `${fileHeading(filePath, side)}${numberedFileLines(text).join('\n')}\n`;
}

function fileHeading(filePath: string, side: FileSide): string {
    return ['# Surrounding file', '', `File: ${filePath}`, `Side: ${side}`, 'Gutter: `line | content`.', ''].join(
        '\n',
    );
}

function numberedFileLines(text: string): string[] {
    const rawLines = text.split('\n');
    const width = Math.max(1, String(rawLines.length).length);
    return rawLines.map((line, index) => `${String(index + 1).padStart(width, ' ')} | ${line}`);
}

/** The same file, centred on the anchor and truncated. This slice lives in the question directory. */
export function surroundingFileContext(
    anchor: ChatAnchor,
    content: FileContent | null,
    budgetBytes: number,
): string {
    const heading = fileHeading(anchor.path, anchor.side);
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

    const lines = numberedFileLines(text);
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

/** Context for a question about the whole PR: summary and route plan. The diff is a shared file. */
function prRouteContext(snapshot: RouteSnapshot | null): string {
    if (snapshot === null) {
        return unavailableBlock('Route context', 'No route snapshot is available for this pull request.');
    }
    return [
        '# Route context',
        '',
        '## Pull request summary',
        '',
        snapshot.summary || '[UNAVAILABLE: the route summary is empty.]',
        '',
        '## Route summary and plan',
        '',
        ...routePlan(snapshot),
        '',
    ].join('\n');
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
