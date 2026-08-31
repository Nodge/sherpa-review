import { fixtureData } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import {
    countThreadSources,
    flattenThread,
    groupThreads,
    isPrLevelThread,
    placeThreadsOnVisibleLines,
    prLevelHumanThreads,
    threadIsVisible,
} from './model.js';

describe('thread model', () => {
    it('flattens a branching tree, counts the subtree and limits indentation', () => {
        const deep = fixtureData('medium').threads[0];
        if (deep === undefined) {
            throw new Error('fixture has no deep thread');
        }

        const rows = flattenThread(deep.root);

        expect(rows[0]?.subtreeReplies).toBe(rows.length - 1);
        expect(rows.some((row) => row.depth > 4 && row.indent === 45 && row.replyHint !== null)).toBe(true);
        expect(rows.filter((row) => row.parent?.id === '4820158')).toHaveLength(2);
    });

    it('keeps only PR-level bots and unknown files in outside', () => {
        const data = fixtureData('medium');
        const known = new Set(data.diff.files.slice(0, 2).map((file) => file.fileId));

        const grouped = groupThreads(data.threads, known);

        expect(grouped.outside.every((thread) => thread.anchor !== null || thread.root.author.bot)).toBe(true);
        expect([...grouped.byFile.keys()].every((fileId) => known.has(fileId))).toBe(true);
    });

    it('separates human PR-level comments from bots and missing files, including a draft', () => {
        const source = fixtureData('medium').threads[0];
        if (source === undefined) {
            throw new Error('fixture has no thread');
        }
        const published = {
            ...source,
            id: 'pr-published',
            anchor: null,
            root: { ...source.root, id: 'pr-published-root', draft: false, author: { ...source.root.author, bot: false } },
        };
        const draft = {
            ...published,
            id: 'pr-draft',
            root: { ...published.root, id: 'pr-draft-root', draft: true },
        };
        const bot = {
            ...published,
            id: 'pr-bot',
            root: { ...published.root, id: 'pr-bot-root', author: { ...published.root.author, bot: true } },
        };
        const disappeared = {
            ...published,
            id: 'disappeared-file',
            anchor: { fileId: 'missing-file', path: 'removed.ts', position: null },
            root: { ...published.root, id: 'disappeared-file-root' },
        };

        expect(isPrLevelThread(published)).toBe(true);
        expect(isPrLevelThread(disappeared)).toBe(false);
        expect(prLevelHumanThreads([published, draft, bot, disappeared]).map((thread) => thread.id)).toEqual([
            'pr-published',
            'pr-draft',
        ]);
        expect(prLevelHumanThreads([draft])[0]?.root.draft).toBe(true);
        expect(groupThreads([published, draft, bot, disappeared], new Set()).outside.map((thread) => thread.id)).toEqual([
            'pr-bot',
            'disappeared-file',
        ]);
    });

    it('pulls an anchor in hidden context to the nearest visible line', () => {
        const data = fixtureData('medium');
        const thread = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (thread?.anchor === null || thread?.anchor === undefined) {
            throw new Error('fixture has no line-anchored thread');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === thread.anchor?.fileId);
        if (file === undefined) {
            throw new Error('thread file not found');
        }
        const model = parseFileDiff(toParseRequest(file));
        const hidden = { ...thread, anchor: { ...thread.anchor, position: { side: 'new' as const, line: 9999, size: 1 } } };

        const placed = placeThreadsOnVisibleLines(model, [hidden]);

        expect([...placed.byLine.values()].flat()).toEqual([hidden]);
        expect(placed.unplaced).toEqual([]);
    });

    it('returns fallback when the required side is missing from the model', () => {
        const data = fixtureData('medium');
        const thread = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (thread?.anchor === null || thread?.anchor === undefined) {
            throw new Error('fixture has no line-anchored thread');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === thread.anchor?.fileId);
        if (file === undefined) {
            throw new Error('thread file not found');
        }
        const model = parseFileDiff(toParseRequest(file));
        const missingSide = {
            ...thread,
            anchor: { ...thread.anchor, position: { side: 'old' as const, line: 1, size: 1 } },
        };
        const onlyNew = {
            ...model,
            content:
                model.content.kind === 'text'
                    ? {
                          ...model.content,
                          blocks: model.content.blocks.map((block) =>
                              block.kind === 'hunk'
                                  ? {
                                        ...block,
                                        lines: block.lines.map((line) => ({ ...line, oldLine: null })),
                                    }
                                  : block,
                          ),
                      }
                    : model.content,
        };

        const placed = placeThreadsOnVisibleLines(onlyNew, [missingSide]);

        expect([...placed.byLine.values()]).toEqual([]);
        expect(placed.unplaced).toEqual([missingSide]);
    });

    it('counts three non-overlapping sources and filters them', () => {
        const threads = fixtureData('medium').threads;
        const counts = countThreadSources(threads);

        expect(counts).toEqual({ people: 4, bots: 2, resolved: 1 });
        expect(threads.filter((thread) => threadIsVisible(thread, { people: true, bots: false, resolved: false })))
            .toHaveLength(4);
    });
});
