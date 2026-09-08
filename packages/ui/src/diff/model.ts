import type { FileChangeType, FileDiff } from '@sherpa/protocol';

/**
 * Single-file diff model for rendering: file → blocks (hunks and gaps) → lines.
 *
 * The model leaves the worker through structured clone (docs/architecture.md §1), so it contains only plain data:
 * no functions, classes, or `Map`. Validation is deliberately omitted: the patch already passed `fileDiffSchema`
 * at the server boundary, and the worker is built in the same bundle.
 */

/** Half-open interval `[from, to)` of character indexes in a line. */
export interface CharRange {
    from: number;
    to: number;
}

/**
 * Highlighting categories from docs/design/README.md §1 ("intentionally minimal"): the README colours numbers the same
 * as strings, so they have no separate category. Anything the lexer is unsure of gets no category
 * at all, to avoid misleading highlighting.
 */
export type SyntaxKind = 'keyword' | 'string' | 'comment' | 'decorator';

export interface SyntaxToken extends CharRange {
    kind: SyntaxKind;
}

export type DiffLineKind = 'context' | 'add' | 'del';

/** Diff line without the patch prefix. Line numbers are nullable by kind: add has no old number, del has no new one. */
export interface DiffLine {
    kind: DiffLineKind;
    oldLine: number | null;
    newLine: number | null;
    text: string;
    /** Changed spans within a del/add pair (docs/design/SPEC-elements.md §2.14). No key means nothing to highlight. */
    words?: CharRange[];
    tokens?: SyntaxToken[];
    /** The parser could not understand the patch line and kept it as is (fail-open: malformed diffs do not crash the UI). */
    malformed?: true;
    /** The patch line was followed by `\ No newline at end of file`. */
    noNewline?: true;
    /** Original gap from which this line was expanded. Post-processing needs it to preserve the result. */
    sourceGapKey?: string;
}

/** Lines the parser can confidently assign to the hunk entity. */
export interface EntityRange {
    side: 'old' | 'new';
    from: number;
    to: number;
}

/** Entity for the card header (docs/design/SPEC-elements.md §2.13): used to build "apply_edit · 142–164". */
export interface EntityHeader {
    label: string;
    /** null means the name is known (git put it in the hunk header), but its file bounds are not. */
    range: EntityRange | null;
}

export interface DiffHunk {
    kind: 'hunk';
    oldStart: number;
    /** Old-side lines in `lines`: for a malformed patch, uses the actual body count, not the false header (see `malformed`). */
    oldCount: number;
    newStart: number;
    newCount: number;
    /** Text after the second `@@`, as provided by the host, or null if absent. */
    section: string | null;
    /** null means the parser is unsure. The header slot stays empty and never says "unknown". */
    entity: EntityHeader | null;
    /**
     * Hunk changes consist only of spaces and line breaks
     * (docs/design/SPEC-elements.md §2.14, single-line notice).
     */
    whitespaceOnly: boolean;
    lines: DiffLine[];
}

/** Gap of unchanged lines: between hunks or at file edges. */
export interface DiffGap {
    kind: 'gap';
    edge: 'leading' | 'inner' | 'trailing';
    /**
     * Number of hidden lines. null means the end of the file: the patch does not give its length,
     * and inventing a count is not allowed.
     */
    hiddenLines: number | null;
    /**
     * Number of changed lines hidden along with unchanged ones. The parser does not set this field.
     * Trimming by stop anchors fills it: a gap there may hide changes from other stops,
     * so calling them "unchanged" would be false.
     */
    hiddenChanged?: number;
    /** Stable key of the original gap, added after the first partial expansion. */
    sourceKey?: string;
    /** First hidden line in each version, used as an anchor for loading more context. */
    oldStart: number;
    newStart: number;
}

export type DiffBlock = DiffHunk | DiffGap;

export type DiffFileContent =
    | { kind: 'text'; blocks: DiffBlock[] }
    /** «binary file not shown» (docs/design/SPEC-elements.md §2.14). */
    | { kind: 'binary' }
    /** No text diff: empty patch, rename/copy without edits, or mode-only change. */
    | { kind: 'none' };

/** Languages with a highlighting profile. `ts` covers the whole JS family (ts/tsx/js/jsx/mjs/cjs). */
export type LanguageId = 'ts' | 'py' | 'go' | 'json' | 'yaml' | 'css' | 'md';

export interface ModeChange {
    from: string;
    to: string;
}

export interface DiffFileModel {
    fileId: string;
    path: string;
    oldPath: string | null;
    changeType: FileChangeType;
    /** null means the extension has no highlighting profile. */
    language: LanguageId | null;
    /**
     * Permission change from the patch header (docs/design/SPEC-elements.md §2.14, single-line notice).
     * null means permissions did not change.
     */
    modeChange: ModeChange | null;
    /** Patch counts: must match `FileDiff.additions`/`deletions`. */
    additions: number;
    deletions: number;
    onlyAdditions: boolean;
    onlyDeletions: boolean;
    /** The file's entire text diff consists of whitespace changes (including CRLF-only). */
    whitespaceOnly: boolean;
    /** The patch contained lines the parser could not understand. */
    malformed: boolean;
    content: DiffFileContent;
}

/** Parser input: only the required `FileDiff` fields are sent to the worker. */
export interface DiffParseRequest {
    fileId: string;
    path: string;
    oldPath: string | null;
    changeType: FileChangeType;
    binary: boolean;
    patch: string | null;
}

export function toParseRequest(file: FileDiff): DiffParseRequest {
    return {
        fileId: file.fileId,
        path: file.path,
        oldPath: file.oldPath,
        changeType: file.changeType,
        binary: file.binary,
        patch: file.patch,
    };
}
