import { fixtureIteration } from '@sherpa/fixtures';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import {
    countThreadSources,
    flattenThread,
    groupThreads,
    isPrLevelThread,
    placeThreadsOnVisibleLines,
    positionLastLine,
    prLevelHumanThreads,
    threadAtLines,
    threadFileId,
    threadIsVisible,
} from './model.js';

describe('thread model', () => {
    it('flattens a branching tree, counts the subtree and limits indentation', () => {
        const deep = fixtureIteration('medium').threads[0];
        if (deep === undefined) {
            throw new Error('fixture has no deep thread');
        }

        const rows = flattenThread(deep.root);

        expect(rows[0]?.subtreeReplies).toBe(rows.length - 1);
        expect(rows.some((row) => row.depth > 4 && row.indent === 45 && row.replyHint !== null)).toBe(true);
        expect(rows.filter((row) => row.parent?.id === '4820158')).toHaveLength(2);
    });

    it('keeps only PR-level bots and unknown files in outside', () => {
        const data = fixtureIteration('medium');
        const known = new Set(data.diff.files.slice(0, 2).map((file) => file.fileId));

        const grouped = groupThreads(data.threads, known);

        expect(grouped.outside.every((thread) => thread.anchor !== null || thread.root.author.bot)).toBe(true);
        expect([...grouped.byFile.keys()].every((fileId) => known.has(fileId))).toBe(true);
    });

    it('separates human PR-level comments from bots and missing files, including a draft', () => {
        const source = fixtureIteration('medium').threads[0];
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

    it('places a range thread under the last line using the line + size convention', () => {
        const data = fixtureIteration('medium');
        const source = data.threads.find((candidate) => candidate.anchor?.position !== null && candidate.anchor !== null);
        if (source?.anchor === null || source?.anchor === undefined) {
            throw new Error('fixture has no line-anchored thread');
        }
        const file = data.diff.files.find((candidate) => candidate.fileId === source.anchor?.fileId);
        if (file === undefined) {
            throw new Error('thread file not found');
        }
        const model = parseFileDiff(toParseRequest(file));
        const numbers =
            model.content.kind === 'text'
                ? model.content.blocks.flatMap((block) =>
                      block.kind === 'hunk' ? block.lines.flatMap((line) => (line.newLine === null ? [] : [line.newLine])) : [],
                  )
                : [];
        const first = numbers.find((line) => numbers.includes(line + 1));
        if (first === undefined) {
            throw new Error('fixture has no two adjacent new lines');
        }
        const position = { side: 'new' as const, line: first, size: 2 };
        const ranged = { ...source, anchor: { ...source.anchor, position } };

        const placed = placeThreadsOnVisibleLines(model, [ranged]);

        expect(positionLastLine(position)).toBe(first + 1);
        expect(placed.byLine.get(`new:${String(first + 1)}`)).toEqual([ranged]);
    });

    it('pulls an anchor in hidden context to the nearest visible line', () => {
        const data = fixtureIteration('medium');
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
        const data = fixtureIteration('medium');
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
        const threads = fixtureIteration('medium').threads;
        const counts = countThreadSources(threads);

        expect(counts).toEqual({ people: 4, bots: 2, resolved: 1 });
        expect(threads.filter((thread) => threadIsVisible(thread, { people: true, bots: false, resolved: false })))
            .toHaveLength(4);
    });
});

describe('thread layout in a previous iteration', () => {
    const V1 = fixtureIteration('medium', 0);
    const V2 = fixtureIteration('medium', 1);
    const LAYOUT = {
        diffId: V1.diff.diffId,
        fileIdByPath: new Map(V1.diff.files.map((file) => [file.path, file.fileId])),
    };

    it('finds a file by path because the active iteration fileId does not match the old diff', () => {
        const v1FileIds = new Set(V1.diff.files.map((file) => file.fileId));

        const handlers = V1.diff.files.find((file) => file.path === 'services/orders/src/api/handlers.ts');
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (handlers === undefined || outdated === undefined) {
            throw new Error('medium fixture needs an outdated thread on handlers.ts');
        }

        // Using `fileId`, a thread from the active iteration cannot find its file in the old diff.
        const byFileId = groupThreads(V2.threads, v1FileIds);
        const byPath = groupThreads(V2.threads, v1FileIds, LAYOUT);

        expect(byFileId.byFile.get(handlers.fileId)).toBeUndefined();
        expect(byFileId.outside.map((thread) => thread.id)).toContain(outdated.id);
        expect(byPath.byFile.get(handlers.fileId)?.map((thread) => thread.id)).toContain(outdated.id);
        expect([...byPath.byFile.keys()].every((fileId) => v1FileIds.has(fileId))).toBe(true);
    });

    it('uses the layout to find a thread file for scrolling instead of the active iteration anchor', () => {
        const handlers = V1.diff.files.find((file) => file.path === 'services/orders/src/api/handlers.ts');
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (handlers === undefined || outdated?.anchor == null) {
            throw new Error('medium fixture needs an outdated thread on handlers.ts');
        }

        // Scrolling to a thread in the old diff uses the same mapping to find the card: `anchor.fileId`
        // belongs to the active iteration and does not exist in the old diff.
        expect(V1.diff.files.some((file) => file.fileId === outdated.anchor?.fileId)).toBe(false);
        expect(threadFileId(outdated, LAYOUT)).toBe(handlers.fileId);
        expect(threadFileId(outdated, null)).toBe(outdated.anchor.fileId);
    });

    it('moves a thread outside the diff when the old iteration has no file with that path', () => {
        const v1FileIds = new Set(V1.diff.files.map((file) => file.fileId));
        const alien = V2.threads.find((thread) => thread.anchor !== null);
        if (alien?.anchor == null) {
            throw new Error('fixture has no anchored thread');
        }
        const moved = { ...alien, anchor: { ...alien.anchor, path: 'services/orders/src/gone.ts' } };

        const grouped = groupThreads([moved], v1FileIds, LAYOUT);

        expect(grouped.byFile.size).toBe(0);
        expect(grouped.outside.map((thread) => thread.id)).toEqual([moved.id]);
    });

    it('places only a thread pinned to this iteration at its lines, including an outdated thread', () => {
        const outdated = V2.threads.find((thread) => thread.outdated && thread.anchor?.position != null);
        if (outdated?.pinnedTo == null) {
            throw new Error('fixture has no outdated pinned thread');
        }
        const alien = { ...outdated, pinnedTo: { diffId: 'another-iteration', commit: 'deadbee' } };

        // An outdated anchor in the active iteration moves the thread under the file header.
        expect(threadAtLines(outdated, null)).toBe(false);
        // In the iteration it is pinned to, the thread sits beside the code it was written about.
        expect(threadAtLines(outdated, LAYOUT)).toBe(true);
        expect(threadAtLines(alien, LAYOUT)).toBe(false);
    });
});
