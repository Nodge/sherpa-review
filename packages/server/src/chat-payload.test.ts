import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ChatAnchor, ChatExchange, FileContent, PrDiff, PrMeta, UiRouteState } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildChatPayload,
    CHAT_HISTORY_EXCHANGE_BYTES,
    CHAT_HISTORY_EXCHANGES,
    CHAT_PAYLOAD_BUDGET_BYTES,
    materializeChatPayload,
    questionDirIn,
    selectedPatchContext,
    surroundingFileContext,
} from './chat-payload.js';
import { walkPatch } from './route/diff-index.js';
import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';
import { diffKeyOf, SharedPayloadStore } from './shared-payload.js';

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
    capabilities: { stickyShip: true, fileViewedSync: false, fileContent: true, commentIssues: true, iterations: false, blobs: false },
    verdicts: [],
};

const READY_ROUTE: UiRouteState = {
    phase: 'ready',
    smallPr: false,
    snapshot: mediumReadySnapshot(),
    failure: null,
    stale: null,
};
const EMPTY_ROUTE: UiRouteState = { phase: 'none', smallPr: false, snapshot: null, failure: null, stale: null };
const GUTTER = /^ *(\d+|\.) +(\d+|\.) \| (.*)$/gm;

function fixtureAnchor(): ChatAnchor {
    const diff = mediumDiff();
    for (const stop of mediumReadySnapshot().stops) {
        for (const candidate of stop.anchors) {
            const file = diff.files.find((item) => item.fileId === candidate.fileId);
            if (file?.patch !== null && file?.patch !== undefined) {
                const { collapsed: _collapsed, ...anchor } = candidate;
                return { ...anchor, diffId: diff.diffId };
            }
        }
    }
    throw new Error('medium fixture has no anchor with a text patch');
}

function fileContent(anchor: ChatAnchor, lineCount = Math.max(anchor.end + 100, 1000)): FileContent {
    const text = Array.from({ length: lineCount }, (_, index) => `line ${String(index + 1)}`).join('\n');
    return { oldText: text, newText: text };
}

function exchange(id: number, answer = `Answer ${String(id)}`): ChatExchange {
    return {
        id,
        question: `Question ${String(id)}`,
        anchor: null,
        status: 'done',
        taskId: id,
        answer,
        progressText: null,
        error: null,
        locale: null,
        createdAt: `2026-09-01T10:${String(id).padStart(2, '0')}:00.000Z`,
        updatedAt: `2026-09-01T10:${String(id).padStart(2, '0')}:01.000Z`,
    };
}

function fileOf(payload: ReturnType<typeof buildChatPayload>, name: string): string {
    return payload.files.find((file) => file.name === name)?.content ?? '';
}

function payloadBytes(payload: ReturnType<typeof buildChatPayload>): number {
    return payload.files.reduce((total, file) => total + Buffer.byteLength(file.content, 'utf8'), 0);
}

describe('anchored chat payload', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;
    let shared: SharedPayloadStore;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-payload-'));
        payloadDir = path.join(root, 'chat');
        sharedDir = path.join(root, 'shared');
        shared = new SharedPayloadStore(sharedDir, () => []);
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    async function materialize(
        context: Parameters<typeof buildChatPayload>[0],
        options?: Parameters<typeof buildChatPayload>[1],
    ) {
        return materializeChatPayload(questionDirIn(payloadDir), shared, buildChatPayload(context, options));
    }

    it('uses stable paths for shared context and a fresh question directory for its own files', async () => {
        const anchor = fixtureAnchor();
        const context = {
            question: 'Why are the operations in this order?',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: fileContent(anchor),
            route: READY_ROUTE,
            history: [exchange(1)],
        };
        const first = await materialize(context);
        const second = await materialize(context);

        expect(first.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            expect.stringMatching(/\.new\.md$/),
            'question.md',
            'selection.patch.md',
            'route-context.md',
            'history.md',
        ]);
        // The first two paths are shared. The model reads them once per session.
        expect(first.contextFiles.slice(0, 2)).toEqual(second.contextFiles.slice(0, 2));
        expect(first.contextFiles[0]?.startsWith(path.join(sharedDir, 'guides'))).toBe(true);
        expect(first.contextFiles[1]?.startsWith(path.join(sharedDir, 'diff', diffKeyOf(mediumDiff()), 'files'))).toBe(
            true,
        );
        // Each question has its own directory, so a retry cannot overwrite an earlier task payload.
        expect(path.dirname(first.contextFiles[2] ?? '')).not.toBe(path.dirname(second.contextFiles[2] ?? ''));
        expect(first.contextFiles.slice(2).every((file) => file.startsWith(payloadDir))).toBe(true);
        expect(first.contextFiles.every((file) => fs.existsSync(file))).toBe(true);
        expect(fs.readFileSync(first.contextFiles[0] ?? '', 'utf8')).toContain('# Task: answer the reviewer question');
        expect(fs.readFileSync(first.contextFiles[1] ?? '', 'utf8')).toContain(`File: ${anchor.path}`);
        expect(fs.readFileSync(first.contextFiles[2] ?? '', 'utf8')).toContain(context.question);
        const routeContext = fs.readFileSync(first.contextFiles[4] ?? '', 'utf8');
        const coveringStop = mediumReadySnapshot().stops.find((stop) =>
            stop.anchors.some(
                (candidate) =>
                    candidate.fileId === anchor.fileId &&
                    candidate.side === anchor.side &&
                    candidate.start <= anchor.end &&
                    candidate.end >= anchor.start,
            ),
        );
        expect(routeContext).toContain('## Pull request summary');
        expect(routeContext).toContain(coveringStop?.title);
        expect(first.resultSchemaFile).toBeUndefined();
        expect(Buffer.byteLength(first.instructions, 'utf8')).toBeLessThan(500);
        // Shared context rule: read a path under `shared/` once per session.
        expect(first.instructions).toContain('shared/');
        expect(first.instructions).toContain('once per session');
        expect(fs.readFileSync(first.contextFiles[0] ?? '', 'utf8')).toContain('once per session');
    });

    it('two questions about one file share a path without rewriting it', async () => {
        const anchor = fixtureAnchor();
        const base = {
            question: 'First question',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: fileContent(anchor),
            route: READY_ROUTE,
            history: [],
        };
        const first = await materialize(base);
        const filePath = first.contextFiles[1] ?? '';
        const stamp = fs.statSync(filePath).mtimeMs;
        fs.writeFileSync(filePath, 'replaced shared file');

        const second = await materialize({
            ...base,
            question: 'Second question',
            anchor: { ...anchor, start: anchor.start + 1, end: anchor.end + 1 },
        });

        expect(second.contextFiles[1]).toBe(filePath);
        expect(fs.readFileSync(filePath, 'utf8')).toBe('replaced shared file');
        expect(fs.statSync(filePath).mtimeMs).toBeGreaterThanOrEqual(stamp);
    });

    it('does not share a file over budget and puts an anchor-centred slice in the question directory', async () => {
        const anchor = { ...fixtureAnchor(), start: 5_000, end: 5_003 };
        const input = await materialize(
            {
                question: 'What does this range do?',
                anchor,
                pr: META,
                diff: mediumDiff(),
                fileContent: fileContent(anchor, 10_000),
                route: READY_ROUTE,
                history: [],
            },
            { sharedBudgetBytes: 4_000, budgetBytes: 20_000 },
        );

        expect(input.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'question.md',
            'selection.patch.md',
            'file-context.md',
            'route-context.md',
            'history.md',
        ]);
        const slice = input.contextFiles[3] ?? '';
        expect(slice.startsWith(payloadDir)).toBe(true);
        const text = fs.readFileSync(slice, 'utf8');
        expect(text).toContain('5000 | line 5000');
        expect(text).toContain('[TRUNCATED: earlier file lines omitted');
        expect(text).toContain('[TRUNCATED: later file lines omitted');
        expect(fs.existsSync(path.join(sharedDir, 'diff', diffKeyOf(mediumDiff()), 'files'))).toBe(false);
    });

    it('prints the range with the same walkPatch numbers used to build the anchor', () => {
        const anchor = fixtureAnchor();
        const file = mediumDiff().files.find((candidate) => candidate.fileId === anchor.fileId) ?? null;
        const text = selectedPatchContext(anchor, file);
        const printed = new Set<number>();
        for (const [, oldCell = '', newCell = ''] of text.matchAll(GUTTER)) {
            const cell = anchor.side === 'old' ? oldCell : newCell;
            if (cell !== '.') {
                printed.add(Number(cell));
            }
        }
        const expected = new Set<number>();
        for (const line of walkPatch(file?.patch ?? '')) {
            const number = line[anchor.side];
            if (number !== null && number >= anchor.start && number <= anchor.end) {
                expected.add(number);
            }
        }

        expect(printed).toEqual(expected);
        expect(text).toContain('Numbers are produced by the same patch walk used for anchor validation.');
    });

    it('centres a large file on the range and explicitly marks truncation', () => {
        const anchor = { ...fixtureAnchor(), start: 5_000, end: 5_003 };
        const text = surroundingFileContext(anchor, fileContent(anchor, 10_000), 4_000);

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(4_000);
        expect(text).toContain('5000 | line 5000');
        expect(text).toContain('[TRUNCATED: earlier file lines omitted');
        expect(text).toContain('[TRUNCATED: later file lines omitted');
    });

    it('keeps the question and explicit markers when route, diff and file contents are absent', () => {
        const anchor = fixtureAnchor();
        const payload = buildChatPayload({
            question: 'What does this range do?',
            anchor,
            pr: null,
            diff: null,
            fileContent: null,
            route: EMPTY_ROUTE,
            history: [],
        });

        expect(fileOf(payload, 'question.md')).toContain('What does this range do?');
        expect(fileOf(payload, 'question.md')).toContain('[UNAVAILABLE: the host could not provide the active diff.]');
        expect(payload.shared.map((entry) => entry.kind)).toEqual(['guide']);
        expect(fileOf(payload, 'selection.patch.md')).toContain('[UNAVAILABLE: the selected file is absent');
        expect(fileOf(payload, 'file-context.md')).toContain('[UNAVAILABLE: the host could not provide');
        expect(fileOf(payload, 'route-context.md')).toContain('No route snapshot is available');
    });
});

describe('PR-level chat payload', () => {
    let root: string;
    let payloadDir: string;
    let sharedDir: string;
    let shared: SharedPayloadStore;

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-pr-payload-'));
        payloadDir = path.join(root, 'chat');
        sharedDir = path.join(root, 'shared');
        shared = new SharedPayloadStore(sharedDir, () => []);
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    async function materialize(
        context: Parameters<typeof buildChatPayload>[0],
        options?: Parameters<typeof buildChatPayload>[1],
    ) {
        return materializeChatPayload(questionDirIn(payloadDir), shared, buildChatPayload(context, options));
    }

    function prContext(question: string) {
        return {
            question,
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history: [],
        };
    }

    it('keeps summary and plan paragraphs per question and shares the file list and patches as a diff', async () => {
        const diff = mediumDiff();
        const snapshot = mediumReadySnapshot();
        const input = await materialize(prContext('What changes overall?'));

        expect(input.contextFiles.map((file) => path.basename(file))).toEqual([
            expect.stringMatching(/^chat-guide-[0-9a-f]{8}\.md$/),
            'pr-diff.md',
            'question.md',
            'route-context.md',
            'history.md',
        ]);
        expect(input.contextFiles[1]).toBe(path.join(sharedDir, 'diff', diffKeyOf(diff), 'pr-diff.md'));

        const route = fs.readFileSync(input.contextFiles[3] ?? '', 'utf8');
        expect(route).toContain(snapshot.summary);
        expect(route).toContain('### Plan order');
        for (const stop of snapshot.stops) {
            if (stop.paragraph !== null) {
                expect(route).toContain(stop.paragraph);
            }
        }

        const context = fs.readFileSync(input.contextFiles[1] ?? '', 'utf8');
        expect(context).toContain('## Patches');
        for (const file of diff.files) {
            expect(context).toContain(`\`${file.path}\``);
            if (file.patch !== null) {
                const changedLine = [...walkPatch(file.patch)].find((line) => line.changed);
                expect(changedLine).toBeDefined();
                expect(context).toContain(changedLine?.raw);
            }
        }
    });

    it('writes the diff once for five PR questions and gives them all the same path', async () => {
        const inputs = [];
        for (const index of [1, 2, 3, 4, 5]) {
            inputs.push(await materialize(prContext(`Question ${String(index)}`)));
        }
        const diffPath = inputs[0]?.contextFiles[1] ?? '';
        // Replace the contents: materializing again must leave the file as it is.
        fs.writeFileSync(diffPath, 'replaced diff');
        const sixth = await materialize(prContext('Question 6'));

        expect(new Set(inputs.map((input) => input.contextFiles[1])).size).toBe(1);
        expect(sixth.contextFiles[1]).toBe(diffPath);
        expect(fs.readFileSync(diffPath, 'utf8')).toBe('replaced diff');
        expect(fs.readdirSync(path.dirname(diffPath))).toEqual(['pr-diff.md']);
        // Each question still has its own directory.
        expect(new Set(inputs.map((input) => path.dirname(input.contextFiles[2] ?? ''))).size).toBe(5);
    });

    it('creates a new directory and removes the previous one when the diff key changes', async () => {
        const first = await materialize(prContext('Question about the previous diff'));
        const next = mediumDiff();
        const second = await materialize({
            ...prContext('Question after a new push'),
            diff: { ...next, headCommit: `${next.headCommit}f` },
        });

        expect(second.contextFiles[1]).not.toBe(first.contextFiles[1]);
        expect(fs.existsSync(first.contextFiles[1] ?? '')).toBe(false);
        expect(fs.existsSync(second.contextFiles[1] ?? '')).toBe(true);
        expect(fs.readdirSync(path.join(sharedDir, 'diff'))).toHaveLength(1);
    });

    it('the overall diff is trimmed to its own budget, not the budget for question files', () => {
        const fixture = mediumDiff();
        const small = fixture.files.find((file) => file.patch !== null && !file.generated);
        if (small === undefined) {
            throw new Error('medium fixture has no regular file with a text patch');
        }
        const hugeLines = Array.from({ length: 20_000 }, (_, index) => `+const generated${String(index)} = ${String(index)};`);
        const diff: PrDiff = {
            ...fixture,
            files: [
                small,
                {
                    ...small,
                    fileId: 'huge-chat-patch',
                    path: 'src/huge-chat-patch.ts',
                    oldPath: null,
                    changeType: 'add',
                    additions: hugeLines.length,
                    deletions: 0,
                    patch: `@@ -0,0 +1,${String(hugeLines.length)} @@\n${hugeLines.join('\n')}\n`,
                },
            ],
        };
        const sharedBudgetBytes = 48 * 1024;
        const payload = buildChatPayload(
            {
                question: 'What changes across the whole PR?',
                anchor: null,
                pr: META,
                diff,
                fileContent: null,
                route: READY_ROUTE,
                history: [],
            },
            { sharedBudgetBytes },
        );
        const context = payload.shared.find((entry) => entry.kind === 'pr-diff')?.content ?? '';
        const smallChangedLine = [...walkPatch(small.patch ?? '')].find((line) => line.changed);

        expect(Buffer.byteLength(context, 'utf8')).toBeLessThanOrEqual(sharedBudgetBytes);
        expect(payloadBytes(payload)).toBeLessThanOrEqual(CHAT_PAYLOAD_BUDGET_BYTES);
        expect(context).toContain(`\`${small.path}\``);
        expect(context).toContain(smallChangedLine?.raw);
        expect(context).toContain('`src/huge-chat-patch.ts`');
        expect(context).toContain('patch omitted');
        expect(context).not.toContain(hugeLines.at(-1));
    });

    it('takes the last N completed exchanges, newest first', () => {
        const history = Array.from({ length: CHAT_HISTORY_EXCHANGES + 3 }, (_, index) => exchange(index + 1));
        const payload = buildChatPayload({
            question: 'Continue the discussion',
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history,
        });
        const text = fileOf(payload, 'history.md');

        expect(text.match(/^## \d+\. Exchange /gm)).toHaveLength(CHAT_HISTORY_EXCHANGES);
        expect(text).toContain(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 3)} —`);
        expect(text).not.toContain('Exchange 1 —');
        expect(text.indexOf(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 3)} —`)).toBeLessThan(
            text.indexOf(`Exchange ${String(CHAT_HISTORY_EXCHANGES + 2)} —`),
        );
    });

    it('also truncates a single history exchange in a PR-level payload', () => {
        const payload = buildChatPayload({
            question: 'Continue the discussion',
            anchor: null,
            pr: META,
            diff: mediumDiff(),
            fileContent: null,
            route: READY_ROUTE,
            history: [exchange(1, 'evidence '.repeat(30_000))],
        });
        const text = fileOf(payload, 'history.md');

        expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(CHAT_HISTORY_EXCHANGE_BYTES + 256);
        expect(text).toContain(
            `[TRUNCATED: assistant reply exceeds ${String(CHAT_HISTORY_EXCHANGE_BYTES)} bytes per chat exchange.]`,
        );
    });
});

describe('total chat payload budget', () => {
    it('stays within 320 KB with a large file and large history', () => {
        const anchor = fixtureAnchor();
        const hugeAnswer = 'evidence '.repeat(30_000);
        const history = Array.from({ length: CHAT_HISTORY_EXCHANGES + 2 }, (_, index) =>
            exchange(index + 1, hugeAnswer),
        );
        const hugeText = Array.from({ length: 100_000 }, (_, index) => `line ${String(index + 1)} ${'x'.repeat(40)}`).join(
            '\n',
        );
        const payload = buildChatPayload({
            question: 'Explain the selected range',
            anchor,
            pr: META,
            diff: mediumDiff(),
            fileContent: { oldText: hugeText, newText: hugeText },
            route: READY_ROUTE,
            history,
        });

        const historyText = fileOf(payload, 'history.md');
        const fileContext = fileOf(payload, 'file-context.md');

        expect(payloadBytes(payload)).toBeLessThanOrEqual(CHAT_PAYLOAD_BUDGET_BYTES);
        expect(historyText.match(/\[TRUNCATED: assistant reply exceeds/g)).toHaveLength(CHAT_HISTORY_EXCHANGES);
        expect(Buffer.byteLength(historyText, 'utf8')).toBeLessThanOrEqual(
            CHAT_HISTORY_EXCHANGES * CHAT_HISTORY_EXCHANGE_BYTES + 1024,
        );
        expect(fileContext).toContain(`${String(anchor.start)} | line ${String(anchor.start)}`);
        expect(fileContext).not.toContain('The surrounding file did not fit in the chat payload budget.');
        expect(fileContext).toContain('[TRUNCATED: later file lines omitted');
        expect(Buffer.byteLength(payload.instructions, 'utf8')).toBeLessThan(500);
    });
});
