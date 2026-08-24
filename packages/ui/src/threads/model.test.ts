import { fixtureData } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { countThreadSources, flattenThread, groupThreads, placeThreadsOnVisibleLines, threadIsVisible } from './model.js';

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

    it('groups PR-level threads and unknown files separately', () => {
        const data = fixtureData('medium');
        const known = new Set(data.diff.files.slice(0, 2).map((file) => file.fileId));

        const grouped = groupThreads(data.threads, known);

        expect(grouped.outside.some((thread) => thread.anchor === null)).toBe(true);
        expect([...grouped.byFile.keys()].every((fileId) => known.has(fileId))).toBe(true);
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
