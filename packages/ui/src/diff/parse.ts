import type { FileChangeType } from '@sherpa/protocol';

import { detectEntity } from './entity.js';
import type {
    DiffBlock,
    DiffFileContent,
    DiffFileModel,
    DiffGap,
    DiffHunk,
    DiffLine,
    DiffParseRequest,
    LanguageId,
    ModeChange,
} from './model.js';
import { languageOf, tokenizeLine } from './syntax.js';
import { diffWords } from './word-diff.js';

/**
 * Parses the host's raw unified diff into the rendering model. Runs in a worker (requirements §1/C3).
 *
 * Fail-open: the parser does not throw on a malformed patch. An unknown line enters the model
 * as context with the `malformed` flag. The UI should show an odd diff instead of a blank screen.
 */

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;
const OLD_MODE_RE = /^old mode (\d+)$/;
const NEW_MODE_RE = /^new mode (\d+)$/;
const BINARY_RE = /^(?:GIT )?[Bb]inary (?:files|patch)/;

export function parseFileDiff(file: DiffParseRequest): DiffFileModel {
    const language = languageOf(file.path);
    const patch = parsePatch(file.patch, language);
    const binary = file.binary || patch.binary;

    const additions = patch.hunks.reduce((sum, hunk) => sum + count(hunk, 'add'), 0);
    const deletions = patch.hunks.reduce((sum, hunk) => sum + count(hunk, 'del'), 0);
    const changed = additions + deletions;

    return {
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        language,
        modeChange: patch.modeChange,
        additions,
        deletions,
        onlyAdditions: additions > 0 && deletions === 0,
        onlyDeletions: deletions > 0 && additions === 0,
        whitespaceOnly: changed > 0 && patch.hunks.every((hunk) => hunk.whitespaceOnly),
        malformed: patch.malformed,
        content: content(binary, patch.hunks, file.changeType),
    };
}

function content(binary: boolean, hunks: readonly DiffHunk[], changeType: FileChangeType): DiffFileContent {
    if (binary) {
        return { kind: 'binary' };
    }
    if (hunks.length === 0) {
        return { kind: 'none' };
    }
    // Added and deleted files are entirely in the patch, with no hidden lines after the hunks.
    const wholeFile = changeType === 'add' || changeType === 'delete';
    return { kind: 'text', blocks: withGaps(hunks, wholeFile) };
}

interface ParsedPatch {
    hunks: DiffHunk[];
    modeChange: ModeChange | null;
    binary: boolean;
    malformed: boolean;
}

function parsePatch(patch: string | null, language: LanguageId | null): ParsedPatch {
    const result: ParsedPatch = { hunks: [], modeChange: null, binary: false, malformed: false };
    if (patch === null) {
        return result;
    }

    const lines = patch.split('\n');
    // The patch ends with a newline. The trailing empty split element is not part of the diff.
    if (lines.at(-1) === '') {
        lines.pop();
    }

    let oldMode: string | null = null;
    let newMode: string | null = null;
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? '';
        const header = HUNK_HEADER_RE.exec(line);
        if (header !== null) {
            const hunk = readHunk(lines, index, header, language);
            result.hunks.push(hunk.hunk);
            result.malformed ||= hunk.malformed;
            index = hunk.next;
            continue;
        }

        oldMode = OLD_MODE_RE.exec(line)?.[1] ?? oldMode;
        newMode = NEW_MODE_RE.exec(line)?.[1] ?? newMode;
        result.binary ||= BINARY_RE.test(line);
        index += 1;
    }

    if (oldMode !== null && newMode !== null && oldMode !== newMode) {
        result.modeChange = { from: oldMode, to: newMode };
    }
    return result;
}

interface ReadHunk {
    hunk: DiffHunk;
    malformed: boolean;
    /** Index of the first line after the hunk. */
    next: number;
}

function readHunk(
    lines: readonly string[],
    start: number,
    header: RegExpExecArray,
    language: LanguageId | null,
): ReadHunk {
    const oldStart = Number(header[1]);
    const oldCount = header[2] === undefined ? 1 : Number(header[2]);
    const newStart = Number(header[3]);
    const newCount = header[4] === undefined ? 1 : Number(header[4]);
    const section = header[5] ?? '';

    const body: DiffLine[] = [];
    let malformed = false;
    let oldLine = oldStart;
    let newLine = newStart;
    let restOld = oldCount;
    let restNew = newCount;
    let index = start + 1;

    while (index < lines.length && (restOld > 0 || restNew > 0)) {
        const raw = lines[index] ?? '';
        // Truncated hunk: the next header arrives before all declared lines have been read.
        if (HUNK_HEADER_RE.test(raw) || raw.startsWith('diff --git ')) {
            break;
        }
        index += 1;

        // The only patch marker is `\ ` (a slash followed by a space). Git localizes the text after it.
        if (raw.startsWith('\\ ')) {
            const last = body.at(-1);
            if (last !== undefined) {
                last.noNewline = true;
            }
            continue;
        }

        const prefix = raw.slice(0, 1);
        const text = raw.slice(1);
        if (prefix === '+') {
            body.push({ kind: 'add', oldLine: null, newLine, text });
            newLine += 1;
            restNew -= 1;
        } else if (prefix === '-') {
            body.push({ kind: 'del', oldLine, newLine: null, text });
            oldLine += 1;
            restOld -= 1;
        } else if (prefix === ' ' || raw === '') {
            // An empty line without a prefix is context: some hosts trim trailing whitespace.
            body.push({ kind: 'context', oldLine, newLine, text });
            oldLine += 1;
            newLine += 1;
            restOld -= 1;
            restNew -= 1;
        } else {
            // Unknown line: keep it as is and continue (must not crash).
            malformed = true;
            body.push({ kind: 'context', oldLine, newLine, text: raw, malformed: true });
            oldLine += 1;
            newLine += 1;
            restOld -= 1;
            restNew -= 1;
        }
    }

    // The `\ No newline at end of file` marker follows the last hunk line,
    // and is excluded from the declared counts. Otherwise the loop above would never reach it.
    const lastLine = body.at(-1);
    if (lastLine !== undefined && lines[index]?.startsWith('\\ ') === true) {
        lastLine.noNewline = true;
        index += 1;
    }

    // The header disagrees with the body: the next header or patch end truncated the hunk,
    // or there were more lines than declared. The model gets actual counts,
    // otherwise gaps would use incorrect header counts with no signal to the caller.
    const actualOldCount = oldLine - oldStart;
    const actualNewCount = newLine - newStart;
    if (actualOldCount !== oldCount || actualNewCount !== newCount) {
        malformed = true;
    }

    markWords(body);
    if (language !== null) {
        for (const line of body) {
            const tokens = tokenizeLine(line.text, language);
            if (tokens.length > 0) {
                line.tokens = tokens;
            }
        }
    }

    const hunkSection = section.length === 0 ? null : section;
    const hunk: DiffHunk = {
        kind: 'hunk',
        oldStart,
        oldCount: actualOldCount,
        newStart,
        newCount: actualNewCount,
        section: hunkSection,
        entity: detectEntity({
            section: hunkSection,
            lines: body,
            newSideEmpty: !body.some((line) => line.newLine !== null),
            language,
        }),
        whitespaceOnly: isWhitespaceOnly(body),
        lines: body,
    };

    return { hunk, malformed, next: index };
}

/**
 * Pairs for word-level highlighting: a block of deleted lines is paired with the following block
 * added lines by index within the block (the usual GitHub approach).
 */
function markWords(lines: DiffLine[]): void {
    let index = 0;
    while (index < lines.length) {
        const dels = run(lines, index, 'del');
        if (dels.length === 0) {
            index += 1;
            continue;
        }

        const adds = run(lines, index + dels.length, 'add');
        index += dels.length + adds.length;

        for (const [i, del] of dels.entries()) {
            const add = adds[i];
            if (add === undefined) {
                break;
            }
            const words = diffWords(del.text, add.text);
            if (words === null) {
                continue;
            }
            if (words.old.length > 0) {
                del.words = words.old;
            }
            if (words.new.length > 0) {
                add.words = words.new;
            }
        }
    }
}

/** Consecutive lines of the same kind, starting at `start`. */
function run(lines: readonly DiffLine[], start: number, kind: DiffLine['kind']): DiffLine[] {
    const found: DiffLine[] = [];
    for (let i = start; i < lines.length; i += 1) {
        const line = lines[i];
        if (line?.kind !== kind) {
            break;
        }
        found.push(line);
    }
    return found;
}

/**
 * Hunk changes are whitespace-only: deleted and added lines match
 * after removing all whitespace characters (including CRLF-only changes).
 */
function isWhitespaceOnly(lines: readonly DiffLine[]): boolean {
    const squeeze = (kind: DiffLine['kind']): string[] =>
        lines.filter((line) => line.kind === kind).map((line) => line.text.replace(/\s+/g, ''));

    const dels = squeeze('del');
    const adds = squeeze('add');
    if (dels.length === 0 || dels.length !== adds.length) {
        return false;
    }
    return dels.every((text, i) => text === adds[i]);
}

function count(hunk: DiffHunk, kind: DiffLine['kind']): number {
    return hunk.lines.filter((line) => line.kind === kind).length;
}

/**
 * Hunks interspersed with gaps: before the first, between adjacent hunks and after the last.
 * `wholeFile` means the entire file is already in the patch, so there can be no trailing gap.
 */
function withGaps(hunks: readonly DiffHunk[], wholeFile: boolean): DiffBlock[] {
    const blocks: DiffBlock[] = [];

    for (const [index, hunk] of hunks.entries()) {
        const previous = hunks[index - 1];
        const gap = previous === undefined ? leadingGap(hunk) : innerGap(previous, hunk);
        if (gap !== null) {
            blocks.push(gap);
        }
        blocks.push(hunk);
    }

    const last = hunks.at(-1);
    if (last !== undefined && !wholeFile && !endsFile(last)) {
        blocks.push({
            kind: 'gap',
            edge: 'trailing',
            hiddenLines: null,
            oldStart: last.oldStart + last.oldCount,
            newStart: last.newStart + last.newCount,
        });
    }
    return blocks;
}

function leadingGap(hunk: DiffHunk): DiffGap | null {
    const first = hunk.oldCount > 0 ? hunk.oldStart : hunk.newStart;
    const hidden = Math.max(first - 1, 0);
    return hidden === 0 ? null : { kind: 'gap', edge: 'leading', hiddenLines: hidden, oldStart: 1, newStart: 1 };
}

function innerGap(previous: DiffHunk, next: DiffHunk): DiffGap | null {
    const oldStart = previous.oldStart + previous.oldCount;
    const newStart = previous.newStart + previous.newCount;

    // Count sides independently: a hunk with no old side has `oldStart` of 0, which makes its count wrong.
    const sides: number[] = [];
    if (previous.oldStart > 0 && next.oldStart > 0) {
        sides.push(next.oldStart - oldStart);
    }
    if (previous.newStart > 0 && next.newStart > 0) {
        sides.push(next.newStart - newStart);
    }

    const hidden = Math.max(0, ...sides);
    return hidden === 0 ? null : { kind: 'gap', edge: 'inner', hiddenLines: hidden, oldStart, newStart };
}

/**
 * `\ No newline at end of file` anywhere in a hunk means one file version ended inside
 * the hunk, so there is no shared unchanged tail after it, and no gap either.
 */
function endsFile(hunk: DiffHunk): boolean {
    return hunk.lines.some((line) => line.noNewline === true);
}
