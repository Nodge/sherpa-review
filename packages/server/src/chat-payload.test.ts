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
    selectedPatchContext,
    surroundingFileContext,
} from './chat-payload.js';
import { walkPatch } from './route/diff-index.js';
import { mediumDiff, mediumReadySnapshot } from './route/fixture-support.js';

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

    beforeEach(async () => {
        root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-payload-'));
    });

    afterEach(async () => {
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    it('materializes the guide and all context as separate files in a fresh directory', async () => {
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
        const first = await materializeChatPayload(root, buildChatPayload(context));
        const second = await materializeChatPayload(root, buildChatPayload(context));

        expect(first.contextFiles.map((file) => path.basename(file))).toEqual([
            'chat-guide.md',
            'question.md',
            'selection.patch.md',
            'file-context.md',
            'route-context.md',
            'history.md',
        ]);
        expect(path.dirname(first.contextFiles[0] ?? '')).not.toBe(path.dirname(second.contextFiles[0] ?? ''));
        expect(first.contextFiles.every((file) => fs.existsSync(file))).toBe(true);
        expect(fs.readFileSync(first.contextFiles[0] ?? '', 'utf8')).toContain('# Task: answer the reviewer question');
        expect(fs.readFileSync(first.contextFiles[1] ?? '', 'utf8')).toContain(context.question);
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
        expect(fileOf(payload, 'selection.patch.md')).toContain('[UNAVAILABLE: the selected file is absent');
        expect(fileOf(payload, 'file-context.md')).toContain('[UNAVAILABLE: the host could not provide');
        expect(fileOf(payload, 'route-context.md')).toContain('No route snapshot is available');
    });
});

describe('PR-level chat payload', () => {
    it('materializes summary, plan paragraphs, file list and patches without anchor files', async () => {
        const diff = mediumDiff();
        const snapshot = mediumReadySnapshot();
        const payload = buildChatPayload({
            question: 'What does this change overall?',
            anchor: null,
            pr: META,
            diff,
            fileContent: null,
            route: READY_ROUTE,
            history: [],
        });
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sherpa-chat-pr-payload-'));
        try {
            const input = await materializeChatPayload(root, payload);
            expect(input.contextFiles.map((file) => path.basename(file))).toEqual([
                'chat-guide.md',
                'question.md',
                'pr-context.md',
                'history.md',
            ]);
            const context = fs.readFileSync(input.contextFiles[2] ?? '', 'utf8');
            expect(context).toContain(snapshot.summary);
            expect(context).toContain('### Plan order');
            expect(context).toContain('## Patches');
            for (const stop of snapshot.stops) {
                if (stop.paragraph !== null) {
                    expect(context).toContain(stop.paragraph);
                }
            }
            for (const file of diff.files) {
                expect(context).toContain(`\`${file.path}\``);
                if (file.patch !== null) {
                    const changedLine = [...walkPatch(file.patch)].find((line) => line.changed);
                    expect(changedLine).toBeDefined();
                    expect(context).toContain(changedLine?.raw);
                }
            }
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    it('fits patches into the remaining budget and marks truncated files', () => {
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
        const budgetBytes = 48 * 1024;
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
            { budgetBytes },
        );
        const context = fileOf(payload, 'pr-context.md');
        const smallChangedLine = [...walkPatch(small.patch ?? '')].find((line) => line.changed);

        expect(payloadBytes(payload)).toBeLessThanOrEqual(budgetBytes);
        expect(context).toContain(`\`${small.path}\``);
        expect(context).toContain(smallChangedLine?.raw);
        expect(context).toContain('`src/huge-chat-patch.ts`');
        expect(context).toContain('[TRUNCATED: patch omitted');
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
