import type { ChatAnchor } from '@sherpa/protocol';
import { agentNoteSchema, chatExchangeSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { buildChatFixtures, chatFixtures } from './data/chat.js';
import { fixtureData } from './data/index.js';

const HUNK_HEADER = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/;

interface ChangedFile {
    fileId: string;
    old: Set<number>;
    new: Set<number>;
}

function changedLines(): Map<string, ChangedFile> {
    const files = new Map<string, ChangedFile>();
    for (const file of fixtureData('medium').diff.files) {
        const changed: ChangedFile = { fileId: file.fileId, old: new Set(), new: new Set() };
        let oldLine = 0;
        let newLine = 0;
        let inHunk = false;

        for (const line of file.patch?.split('\n') ?? []) {
            const header = HUNK_HEADER.exec(line);
            if (header !== null) {
                oldLine = Number(header[1]);
                newLine = Number(header[2]);
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                continue;
            }
            const prefix = line.slice(0, 1);
            if (prefix === '+') {
                changed.new.add(newLine);
                newLine += 1;
            } else if (prefix === '-') {
                changed.old.add(oldLine);
                oldLine += 1;
            } else if (prefix === ' ') {
                oldLine += 1;
                newLine += 1;
            }
        }
        files.set(file.path, changed);
    }
    return files;
}

function expectRealAnchor(anchor: ChatAnchor, files: Map<string, ChangedFile>): void {
    const file = files.get(anchor.path);
    expect(file, `anchor points to a file outside medium: ${anchor.path}`).toBeDefined();
    expect(anchor.fileId).toBe(file?.fileId);
    expect(anchor.end).toBeGreaterThanOrEqual(anchor.start);

    const side = anchor.side === 'old' ? file?.old : file?.new;
    for (let line = anchor.start; line <= anchor.end; line += 1) {
        expect(
            side?.has(line),
            `anchor covers an unchanged line ${anchor.path}:${anchor.side}:${String(line)}`,
        ).toBe(true);
    }
}

describe('medium chat fixtures', () => {
    const fixtures = chatFixtures('medium');

    it('all exchanges and notes pass protocol schemas', () => {
        expect(fixtures).not.toBeNull();
        for (const item of fixtures?.exchanges ?? []) {
            expect(() => chatExchangeSchema.parse(item)).not.toThrow();
        }
        for (const item of fixtures?.notes ?? []) {
            expect(() => agentNoteSchema.parse(item)).not.toThrow();
        }
    });

    it('includes every exchange state and a question about the whole PR', () => {
        const exchanges = fixtures?.exchanges ?? [];
        expect(new Set(exchanges.map((item) => item.status))).toEqual(
            new Set(['queued', 'running', 'done', 'failed', 'cancelled']),
        );
        expect(exchanges.some((item) => item.status === 'done' && item.anchor === null)).toBe(true);
        expect(exchanges.some((item) => item.status === 'running' && item.progressText !== null)).toBe(true);
        expect(exchanges.some((item) => item.status === 'failed' && item.error !== null)).toBe(true);
    });

    it('all anchors refer only to actually changed lines in medium', () => {
        const files = changedLines();
        for (const item of fixtures?.exchanges ?? []) {
            if (item.anchor !== null) {
                expectRealAnchor(item.anchor, files);
            }
        }
        for (const item of fixtures?.notes ?? []) {
            expectRealAnchor(item.anchor, files);
        }
    });

    it('notes copy answers from their exchanges, and the stack contains overlapping ranges', () => {
        const exchanges = new Map((fixtures?.exchanges ?? []).map((item) => [item.id, item] as const));
        for (const item of fixtures?.notes ?? []) {
            const source = exchanges.get(item.exchangeId);
            expect(source?.status).toBe('done');
            expect(item.anchor).toEqual(source?.anchor);
            expect(item.text).toBe(source?.answer);
        }

        const stack = (fixtures?.notes ?? []).filter(
            (item) => item.anchor.path === 'services/orders/src/domain/edit-window.ts',
        );
        expect(stack.length).toBeGreaterThanOrEqual(3);
        for (let index = 1; index < stack.length; index += 1) {
            const previous = stack[index - 1];
            const current = stack[index];
            expect(previous).toBeDefined();
            expect(current).toBeDefined();
            expect(Math.max(previous?.anchor.start ?? 0, current?.anchor.start ?? 0)).toBeLessThanOrEqual(
                Math.min(previous?.anchor.end ?? 0, current?.anchor.end ?? 0),
            );
        }
    });

    it('two builds from scratch are deterministic, and the cache returns independent copies', () => {
        expect(buildChatFixtures('medium')).toEqual(buildChatFixtures('medium'));
        const first = chatFixtures('medium');
        const second = chatFixtures('medium');
        expect(first).not.toBe(second);
        expect(first).toEqual(second);
    });
});

describe('chat fixtures for the other PRs', () => {
    for (const name of ['small', 'large', 'edge'] as const) {
        it(`${name}: no chat data`, () => {
            expect(buildChatFixtures(name)).toBeNull();
            expect(chatFixtures(name)).toBeNull();
        });
    }
});
