import type { AgentNote, ChatAnchor } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { createThreadStore } from '../threads/store.js';
import { openNewComposer } from '../threads/thread-list.tsx';
import { commentPosition } from '../views/full-diff.tsx';
import { noteCommentPosition, noteComposerAnchor, noteComposerKey, noteDraftText } from './note-draft.js';

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'app.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -100,4 +120,5 @@',
        ' context-before',
        '-old-101',
        '-old-102',
        '+new-121',
        '+new-122',
        '+new-123',
        ' context-after',
    ].join('\n'),
});

function note(text: string, start = 41, end = 43, side: 'old' | 'new' = 'new'): AgentNote {
    const anchor: ChatAnchor = { diffId: 'iter-1', fileId: 'f1', path: 'app.ts', side, start, end };
    return {
        id: 1,
        exchangeId: 1,
        anchor,
        text,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt: '2026-09-01T10:00:00.000Z',
    };
}

describe('draft text from a note', () => {
    it('quotes a single-line note on one line below the attribution', () => {
        expect(noteDraftText(note('The cache returns immediately.'))).toBe(
            ['Quoted from the agent’s answer:', '', '> The cache returns immediately.'].join('\n'),
        );
    });

    it('quotes blank lines inside the text as empty blockquote lines', () => {
        expect(noteDraftText(note('First line\n\nAfter a blank line\n- item'))).toBe(
            [
                'Quoted from the agent’s answer:',
                '',
                '> First line',
                '>',
                '> After a blank line',
                '> - item',
            ].join('\n'),
        );
    });

    it('trims trailing blank lines from a note', () => {
        expect(noteDraftText(note('The only line\n\n   \n\n'))).toBe(
            ['Quoted from the agent’s answer:', '', '> The only line'].join('\n'),
        );
    });
});

describe('draft position from the note anchor', () => {
    it('a multiline range on the new side matches a selection of the same lines', () => {
        const selection = { fileId: 'f1', anchor: 'a121', focus: 'a123' };

        expect(noteCommentPosition(note('t', 121, 123).anchor)).toEqual(
            commentPosition(selection, MODEL, 'f1', 'new', 121),
        );
    });

    it('a multiline range on the old side matches a selection of the same lines', () => {
        const selection = { fileId: 'f1', anchor: 'd101', focus: 'd102' };

        expect(noteCommentPosition(note('t', 101, 102, 'old').anchor)).toEqual(
            commentPosition(selection, MODEL, 'f1', 'old', 101),
        );
    });

    it('a single line gives size 1, like clicking the pencil without a selection', () => {
        expect(noteCommentPosition(note('t', 122, 122).anchor)).toEqual(
            commentPosition(null, MODEL, 'f1', 'new', 122),
        );
        expect(noteCommentPosition(note('t', 122, 122).anchor)).toEqual({ side: 'new', line: 122, size: 1 });
    });

    it('builds the composer key and anchor from the first line of the range', () => {
        expect(noteComposerKey(note('t', 121, 123).anchor)).toBe('new:f1:new:121');
        expect(noteComposerAnchor(note('t', 121, 123).anchor)).toEqual({
            fileId: 'f1',
            path: 'app.ts',
            position: { side: 'new', line: 121, size: 3 },
        });
    });
});

describe('seeding composer text', () => {
    const anchor = noteComposerAnchor(note('t', 121, 123).anchor);
    const key = noteComposerKey(note('t', 121, 123).anchor);

    it('opens a new composer with a quote', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(store, key, anchor, true, 'quote');

        expect(store.getComposer(key)?.text).toBe('quote');
        expect(store.getComposer(key)?.anchor).toEqual(anchor);
    });

    it('does not overwrite text the reviewer has typed', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(store, key, anchor, true);
        store.updateComposer(key, { text: 'my comment' });

        openNewComposer(store, key, anchor, true, 'quote');

        expect(store.getComposer(key)?.text).toBe('my comment');
    });

    it('seeds an open empty composer and moves it to the note range', () => {
        const store = createThreadStore([], new Set(['f1']));
        // The pencil on line 121 gives the same key as a note on 121–123.
        const pencilAnchor = { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 121, size: 1 } } as const;
        openNewComposer(store, key, pencilAnchor, true);

        openNewComposer(store, key, anchor, true, 'quote');

        expect(store.getComposer(key)?.text).toBe('quote');
        expect(store.getComposer(key)?.anchor).toEqual(anchor);
    });

    it('does not move the anchor of a composer with typed text', () => {
        const store = createThreadStore([], new Set(['f1']));
        const pencilAnchor = { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 121, size: 1 } } as const;
        openNewComposer(store, key, pencilAnchor, true);
        store.updateComposer(key, { text: 'my comment' });

        openNewComposer(store, key, anchor, true, 'quote');

        expect(store.getComposer(key)?.anchor).toEqual(pencilAnchor);
    });
});
