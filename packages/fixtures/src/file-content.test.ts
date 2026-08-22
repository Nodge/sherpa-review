import { describe, expect, it } from 'vitest';

import { FIXTURE_NAMES, fixtureData } from './data/index.js';
import { fileContentOf } from './file-content.js';

/**
 * Reconstructing full file text from a patch. Checks what the UI relies on:
 * hunk context lines appear in the text at their exact line numbers, unchanged parts match
 * in both versions, and one-sided changes return null for the missing side.
 */

const HUNK_HEADER = /^@@ -(\d+),(\d+) \+(\d+),(\d+) @@/;

interface ContextLine {
    oldLine: number;
    newLine: number;
    text: string;
}

/** Patch context lines with line numbers on both sides. */
function contextLines(patch: string): ContextLine[] {
    const found: ContextLine[] = [];
    let oldLine = 0;
    let newLine = 0;

    for (const raw of patch.split('\n')) {
        const header = HUNK_HEADER.exec(raw);
        if (header !== null) {
            oldLine = Number(header[1]);
            newLine = Number(header[3]);
            continue;
        }
        if (oldLine === 0) {
            continue;
        }

        const prefix = raw.slice(0, 1);
        if (prefix === '+') {
            newLine += 1;
        } else if (prefix === '-') {
            oldLine += 1;
        } else if (prefix === ' ') {
            found.push({ oldLine, newLine, text: raw.slice(1) });
            oldLine += 1;
            newLine += 1;
        }
    }
    return found;
}

function lineAt(text: string, line: number): string | undefined {
    return text.split('\n')[line - 1];
}

describe('file content from a patch', () => {
    for (const name of FIXTURE_NAMES) {
        const data = fixtureData(name);

        it(`${name}: patch context lines have their correct numbers in both versions`, () => {
            for (const file of data.diff.files) {
                const content = fileContentOf(file);
                if (content === null || file.patch === null) {
                    continue;
                }
                for (const context of contextLines(file.patch)) {
                    if (content.oldText !== null) {
                        expect(lineAt(content.oldText, context.oldLine), `${file.path}:${String(context.oldLine)}`).toBe(
                            context.text,
                        );
                    }
                    if (content.newText !== null) {
                        expect(lineAt(content.newText, context.newLine), `${file.path}:${String(context.newLine)}`).toBe(
                            context.text,
                        );
                    }
                }
            }
        });

        it(`${name}: sides match the change type, binary files have no content`, () => {
            for (const file of data.diff.files) {
                const content = fileContentOf(file);
                if (file.binary) {
                    expect(content, file.path).toBeNull();
                    continue;
                }
                if (content === null) {
                    throw new Error(`text file ${file.path} has no content`);
                }
                expect(content.oldText === null, file.path).toBe(file.changeType === 'add');
                expect(content.newText === null, file.path).toBe(file.changeType === 'delete');
            }
        });

        it(`${name}: the result is deterministic`, () => {
            const again = fixtureData(name);
            expect(data.diff.files.map((file) => fileContentOf(file))).toEqual(
                again.diff.files.map((file) => fileContentOf(file)),
            );
        });
    }

    it('modification: the tail after the last hunk exists and matches in both versions', () => {
        const file = fixtureData('medium').diff.files.find(
            (candidate) => candidate.path === 'services/orders/src/domain/order.ts',
        );
        if (file === undefined) {
            throw new Error('order.ts not found in the medium fixture');
        }

        const content = fileContentOf(file);
        const oldLines = content?.oldText?.split('\n') ?? [];
        const newLines = content?.newText?.split('\n') ?? [];
        expect(newLines.length).toBeGreaterThan(0);
        // The tail has the same unchanged lines, just with different line-number offsets.
        expect(newLines.slice(-5)).toEqual(oldLines.slice(-5));
        expect(newLines.length - oldLines.length).toBe(file.additions - file.deletions);
    });

    it('added file: text comes entirely from the patch, with no appended tail', () => {
        const file = fixtureData('medium').diff.files.find(
            (candidate) => candidate.path === 'services/orders/src/domain/edit-window.ts',
        );
        if (file === undefined) {
            throw new Error('edit-window.ts not found in the medium fixture');
        }

        const content = fileContentOf(file);
        expect(content?.oldText).toBeNull();
        expect(content?.newText?.split('\n')).toHaveLength(file.additions);
    });
});
