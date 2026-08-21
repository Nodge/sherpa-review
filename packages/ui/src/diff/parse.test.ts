import { FIXTURE_NAMES, fixtureData } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap, DiffHunk } from './model.js';
import { toParseRequest } from './model.js';
import { parseFileDiff } from './parse.js';

function parse(file: FileDiff): DiffFileModel {
    return parseFileDiff(toParseRequest(file));
}

function fileByPath(fixture: 'medium' | 'small' | 'large' | 'edge', path: string): FileDiff {
    const file = fixtureData(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`no file ${path} in fixture ${fixture}`);
    }
    return file;
}

/** Patch from lines, for tests of malformed and synthetic cases. */
function patchOf(lines: readonly string[]): string {
    return [...lines, ''].join('\n');
}

function modelOf(patch: string, path = 'services/orders/src/api/b.ts'): DiffFileModel {
    return parseFileDiff({ fileId: 'f1', path, oldPath: null, changeType: 'modify', binary: false, patch });
}

function hunks(model: DiffFileModel): DiffHunk[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk')
        : [];
}

function gaps(model: DiffFileModel): DiffGap[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
}

describe('diff parser on real fixture patches', () => {
    for (const name of FIXTURE_NAMES) {
        it(`${name}: model counts match FileDiff for every file`, () => {
            const files = fixtureData(name).diff.files;
            const counted = files.map((file) => {
                const model = parse(file);
                return { path: file.path, additions: model.additions, deletions: model.deletions };
            });

            expect(counted).toEqual(
                files.map((file) => ({ path: file.path, additions: file.additions, deletions: file.deletions })),
            );
        });

        it(`${name}: real patches parse without the malformed flag`, () => {
            const files = fixtureData(name).diff.files;

            expect(files.filter((file) => parse(file).malformed).map((file) => file.path)).toEqual([]);
        });

        it(`${name}: line numbers are consecutive and match the hunk header`, () => {
            for (const file of fixtureData(name).diff.files) {
                for (const hunk of hunks(parse(file))) {
                    let oldLine = hunk.oldStart;
                    let newLine = hunk.newStart;
                    for (const line of hunk.lines) {
                        if (line.kind !== 'add') {
                            expect(line.oldLine).toBe(oldLine);
                            oldLine += 1;
                        }
                        if (line.kind !== 'del') {
                            expect(line.newLine).toBe(newLine);
                            newLine += 1;
                        }
                    }
                    expect(oldLine - hunk.oldStart).toBe(hunk.oldCount);
                    expect(newLine - hunk.newStart).toBe(hunk.newCount);
                }
            }
        });
    }

    it('line text has no patch prefix', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(hunks(model)[0]?.lines[0]).toMatchObject({
            kind: 'add',
            oldLine: null,
            newLine: 1,
            text: '# Rollout',
        });
    });
});

describe('raw edge cases', () => {
    it('binary: no content, explicit model variant', () => {
        const model = parse(fileByPath('edge', 'services/orders/assets/edit-window-flow.png'));

        expect(model.content).toEqual({ kind: 'binary' });
        expect(model.additions).toBe(0);
        expect(model.deletions).toBe(0);
    });

    it('empty patch: no text diff', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/index.ts'));

        expect(model.content).toEqual({ kind: 'none' });
        expect(model.changeType).toBe('add');
    });

    it('mode change without edits: recognizes the mode, produces no hunks', () => {
        const model = parse(fileByPath('edge', 'services/orders/scripts/rollout.sh'));

        expect(model.modeChange).toEqual({ from: '100644', to: '100755' });
        expect(model.content).toEqual({ kind: 'none' });
    });

    it('rename with edits preserves the old path and hunks', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/clock.ts'));

        expect(model.changeType).toBe('move');
        expect(model.oldPath).toBe('services/orders/src/infra/clock.ts');
        expect(hunks(model)).toHaveLength(1);
    });

    it('file deletion contains only deletions', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/legacy/edit-window-v1.ts'));

        expect(model.onlyDeletions).toBe(true);
        expect(model.onlyAdditions).toBe(false);
    });

    it('file addition contains only additions', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(model.onlyAdditions).toBe(true);
        expect(model.onlyDeletions).toBe(false);
    });

    it('whitespace-only sets flags on the hunk and file', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        expect(model.whitespaceOnly).toBe(true);
        expect(hunks(model).map((hunk) => hunk.whitespaceOnly)).toEqual([true]);
    });

    it('CRLF-only counts as a whitespace change', () => {
        const model = modelOf(patchOf(['@@ -1,2 +1,2 @@', ' const a = 1;', '-const b = 2;\r', '+const b = 2;']));

        expect(model.whitespaceOnly).toBe(true);
    });

    it('a substantive edit does not count as whitespace', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/infra/time/clock.ts'));

        expect(model.whitespaceOnly).toBe(false);
    });

    it('conflict is passed through changeType while the content stays text', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/domain/order.ts'));

        expect(model.changeType).toBe('conflict');
        expect(model.content.kind).toBe('text');
        expect(hunks(model)[0]?.lines.map((line) => line.text)).toContain('<<<<<<< HEAD');
    });
});

describe('gaps between hunks and at the edges', () => {
    it('the leading gap is counted from the start of the file', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        // The hunk starts at line 12, so 11 lines before it are hidden.
        expect(gaps(model).find((gap) => gap.edge === 'leading')).toEqual({
            kind: 'gap',
            edge: 'leading',
            hiddenLines: 11,
            oldStart: 1,
            newStart: 1,
        });
    });

    it('a hunk starting at line 1 has no leading gap', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(gaps(model).some((gap) => gap.edge === 'leading')).toBe(false);
    });

    it('an internal gap is counted from adjacent hunk headers', () => {
        const model = modelOf(
            patchOf([
                '@@ -10,2 +10,3 @@',
                ' const a = 1;',
                '+const b = 2;',
                ' const c = 3;',
                '@@ -40,1 +41,1 @@',
                '-const d = 4;',
                '+const d = 40;',
            ]),
        );

        expect(gaps(model).find((gap) => gap.edge === 'inner')).toEqual({
            kind: 'gap',
            edge: 'inner',
            hiddenLines: 28,
            oldStart: 12,
            newStart: 13,
        });
    });

    it('the gap after the last hunk has no known count', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/api/schemas.ts'));

        expect(gaps(model).find((gap) => gap.edge === 'trailing')?.hiddenLines).toBeNull();
    });

    it('`\\ No newline at end of file` ends the file with no trailing gap', () => {
        const model = modelOf(
            patchOf(['@@ -1,1 +1,1 @@', '-const a = 1;', '+const a = 2;', '\\ No newline at end of file']),
        );

        expect(gaps(model)).toEqual([]);
        expect(hunks(model)[0]?.lines.at(-1)?.noNewline).toBe(true);
    });

    it('`\\ No newline` in the middle of a hunk also ends the file', () => {
        const model = modelOf(
            patchOf([
                '@@ -1,2 +1,3 @@',
                ' const a = 1;',
                '-const b = 2;',
                '\\ No newline at end of file',
                '+const b = 20;',
                '+const c = 3;',
            ]),
        );

        expect(gaps(model)).toEqual([]);
        expect(hunks(model)[0]?.lines[1]?.noNewline).toBe(true);
    });

    it('an added file is entirely in the patch with no trailing gap', () => {
        const model = parse(fileByPath('edge', 'services/orders/docs/rollout.md'));

        expect(gaps(model)).toEqual([]);
    });

    it('a deleted file is entirely in the patch with no trailing gap', () => {
        const model = parse(fileByPath('edge', 'services/orders/src/legacy/edit-window-v1.ts'));

        expect(gaps(model)).toEqual([]);
    });

    it('gap anchors use actual line numbers instead of zeros', () => {
        for (const name of FIXTURE_NAMES) {
            for (const file of fixtureData(name).diff.files) {
                for (const gap of gaps(parse(file))) {
                    expect(gap.oldStart).toBeGreaterThan(0);
                    expect(gap.newStart).toBeGreaterThan(0);
                }
            }
        }
    });
});

describe('malformed patches do not crash the parser', () => {
    it('an unknown line enters the model as context with the malformed flag', () => {
        const model = modelOf(patchOf(['@@ -1,3 +1,3 @@', ' const a = 1;', '???garbage', ' const c = 3;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]?.lines[1]).toMatchObject({
            kind: 'context',
            text: '???garbage',
            malformed: true,
        });
    });

    it('a truncated hunk preserves the next hunk and is marked malformed', () => {
        const model = modelOf(
            patchOf(['@@ -1,9 +1,9 @@', ' const a = 1;', '@@ -40,1 +40,1 @@', '-const d = 4;', '+const d = 40;']),
        );

        expect(hunks(model)).toHaveLength(2);
        expect(hunks(model)[1]?.lines).toHaveLength(2);
        expect(model.malformed).toBe(true);
        // Truncated hunk counts follow the body (1/1), not the incorrect header (9/9).
        expect(hunks(model)[0]).toMatchObject({ oldCount: 1, newCount: 1 });
    });

    it('a patch ending in the middle of a hunk is marked malformed', () => {
        const model = modelOf(patchOf(['@@ -1,4 +1,4 @@', ' const a = 1;', '-const b = 2;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]).toMatchObject({ oldCount: 2, newCount: 1 });
    });

    it('a line starting with a slash that is not a marker is an ordinary unknown line', () => {
        const model = modelOf(patchOf(['@@ -1,3 +1,3 @@', ' const a = 1;', '\\garbage', ' const c = 3;']));

        expect(model.malformed).toBe(true);
        expect(hunks(model)[0]?.lines[1]).toMatchObject({ kind: 'context', text: '\\garbage', malformed: true });
        expect(hunks(model)[0]?.lines[0]?.noNewline).toBeUndefined();
    });

    it('a patch without a hunk header produces the no-text-diff variant', () => {
        const model = modelOf('diff --git a/b.ts b/b.ts\nindex 1111111..2222222 100644\n');

        expect(model.content).toEqual({ kind: 'none' });
        expect(model.malformed).toBe(false);
    });

    it('"Binary files … differ" in the patch text produces binary', () => {
        const model = modelOf(
            'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n',
            'services/orders/assets/logo.png',
        );

        expect(model.content).toEqual({ kind: 'binary' });
    });
});

describe('model serializability', () => {
    it('every fixture file model survives structuredClone without loss', () => {
        for (const name of FIXTURE_NAMES) {
            for (const file of fixtureData(name).diff.files) {
                const model = parse(file);
                expect(structuredClone(model)).toEqual(model);
            }
        }
    });
});
