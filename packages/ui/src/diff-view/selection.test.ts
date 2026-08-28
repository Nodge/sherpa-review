import type { FileContent } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { expandAllGaps, expandFileContext } from './expand.js';
import type { LineKey, LineSelection } from './selection.js';
import { lineKey, selectedLines } from './selection.js';

/**
 * Range selection: a line's key is its file line numbers, so context expansion
 * reindexes the model while selection stays on the same lines.
 */

const LINES = Array.from({ length: 120 }, (_, index) => `line-${String(index + 1)}`);
const CONTENT: FileContent = { oldText: `${LINES.join('\n')}\n`, newText: `${LINES.join('\n')}\n` };

/** Two hunks: edits on lines 21 and 41, with gaps between and around them. */
function twoHunks(): DiffFileModel {
    return parseFileDiff({
        fileId: 'f1',
        path: 'app.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        patch: [
            '@@ -21,1 +21,1 @@',
            '-line-21',
            '+line-21 changed',
            '@@ -41,1 +41,1 @@',
            '-line-41',
            '+line-41 changed',
            '',
        ].join('\n'),
    });
}

/** Selected line text shows whether the right lines are selected, regardless of indexes. */
function selectedTexts(model: DiffFileModel, selection: LineSelection): string[] {
    const keys = selectedLines(model, selection);
    const texts: string[] = [];
    if (model.content.kind !== 'text') {
        return texts;
    }
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            const key = lineKey(line);
            if (key !== null && keys.has(key)) {
                texts.push(line.text);
            }
        }
    }
    return texts;
}

function selection(anchor: LineKey, focus: LineKey): LineSelection {
    return { fileId: 'f1', anchor, focus };
}

describe('line selection', () => {
    it('a line key uses its file line numbers, one per side', () => {
        expect(lineKey({ kind: 'context', oldLine: 21, newLine: 23, text: 'x' })).toBe('c21:23');
        expect(lineKey({ kind: 'add', oldLine: null, newLine: 23, text: 'x' })).toBe('a23');
        expect(lineKey({ kind: 'del', oldLine: 21, newLine: null, text: 'x' })).toBe('d21');
        // A malformed line without numbers has no address, so it cannot be selected.
        expect(lineKey({ kind: 'del', oldLine: null, newLine: null, text: 'x' })).toBeNull();
    });

    it('takes the range in model order and extends it equally in either direction', () => {
        const model = twoHunks();

        expect(selectedTexts(model, selection('d21', 'a21'))).toEqual(['line-21', 'line-21 changed']);
        expect(selectedTexts(model, selection('a21', 'd21'))).toEqual(['line-21', 'line-21 changed']);
    });

    it('context expansion does not shift selection to neighboring lines', () => {
        const model = twoHunks();
        const range = selection('d21', 'a21');
        const before = selectedTexts(model, range);

        const expanded = expandFileContext(model, CONTENT, expandAllGaps(model, new Map()));
        expect(selectedTexts(expanded, range)).toEqual(before);
    });

    it('shrinks selection to the remaining boundary when the other disappears, without spreading over the file', () => {
        const model = twoHunks();

        expect(selectedTexts(model, selection('a21', 'a999'))).toEqual(['line-21 changed']);
        expect(selectedLines(model, selection('a998', 'a999')).size).toBe(0);
    });

    it('has no selected lines without selection or for a binary file', () => {
        const model = twoHunks();

        expect(selectedLines(model, null).size).toBe(0);
        expect(selectedLines({ ...model, content: { kind: 'binary' } }, selection('a21', 'a21')).size).toBe(0);
    });
});
