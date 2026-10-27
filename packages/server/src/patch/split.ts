/**
 * Splits a combined `diff --git` patch by file. The VCS prints the diff for all requested paths
 * as one text, while the contract's `FileDiff.patch` is per-file. The adapter splits the text at
 * `diff --git` headers and matches the pieces to its changed-file list by path.
 *
 * Not every VCS escapes paths in headers. Some backends print
 * `diff --git a/a b.md b/a b.md` without quotes, making a path with spaces impossible to parse in general. So
 * the header is first checked against the adapter's existing path list, and only then
 * parsed using git spaces and quotes.
 */

const FILE_HEADER = 'diff --git ';
const HUNK_HEADER = '@@ ';

export interface PatchStats {
    readonly additions: number;
    readonly deletions: number;
}

/**
 * File patches by path. A piece is stored under both header paths (`a/` and `b/`). For rename/copy,
 * the adapter's change list knows the new path, and for delete it knows the old one. There is no reason
 * to guess which one will be requested.
 *
 * The right side (`b/`) is the result path and always wins. The left takes a key only while it
 * is free. Otherwise, `a/X b/Y` (a copy) would overwrite X's own patch if X also changed.
 */
export function splitPatchByFile(patch: string, knownPaths: readonly string[] = []): Map<string, string> {
    const chunks = new Map<string, string>();
    // Build the set once per patch: each of the two sides of every header is checked against
    // the path list, and a large PR patch has thousands of headers.
    const known = new Set(knownPaths);
    let current: string[] | null = null;
    let header: HeaderPaths = { left: null, right: null };

    const flush = (): void => {
        if (current === null) {
            return;
        }
        // Trailing empty lines come from splitting the text and are not part of the file patch.
        while (current.at(-1) === '') {
            current.pop();
        }
        const text = `${current.join('\n')}\n`;
        if (header.left !== null && !chunks.has(header.left)) {
            chunks.set(header.left, text);
        }
        if (header.right !== null) {
            chunks.set(header.right, text);
        }
        current = null;
        header = { left: null, right: null };
    };

    for (const line of patch.split('\n')) {
        if (line.startsWith(FILE_HEADER)) {
            flush();
            current = [line];
            header = headerPaths(line, known);
            continue;
        }
        current?.push(line);
    }
    flush();

    return chunks;
}

/**
 * Patch line counts. Count only lines inside hunks. Otherwise, headers `---`/`+++` and content
 * such as `+++ foo` cannot be distinguished. Used by adapters whose hosts do not supply per-file counts.
 */
export function countPatchStats(patch: string): PatchStats {
    let additions = 0;
    let deletions = 0;
    let inHunk = false;

    for (const line of patch.split('\n')) {
        if (line.startsWith(HUNK_HEADER)) {
            inHunk = true;
            continue;
        }
        if (!inHunk) {
            continue;
        }

        const prefix = line.slice(0, 1);
        if (prefix === '+') {
            additions += 1;
        } else if (prefix === '-') {
            deletions += 1;
        } else if (prefix !== ' ' && prefix !== '\\' && line !== '') {
            // The line is outside the hunk body. Patch metadata follows again.
            inHunk = false;
        }
    }

    return { additions, deletions };
}

/** Sides of a `diff --git "a/old" "b/new"` header without prefixes. `/dev/null` is not a path. */
interface HeaderPaths {
    readonly left: string | null;
    readonly right: string | null;
}

function headerPaths(line: string, knownPaths: ReadonlySet<string>): HeaderPaths {
    const rest = line.slice(FILE_HEADER.length);
    const known = knownHeaderPaths(rest, knownPaths);
    if (known !== null) {
        return known;
    }

    const first = readPath(rest, 0);
    if (first === null) {
        return { left: null, right: null };
    }
    const second = readPath(rest, first.next);

    return { left: stripSidePrefix(first.value), right: stripSidePrefix(second?.value) };
}

/**
 * A header built from known paths: `a/<L> b/<R>`, where each side is either a path
 * the adapter requested or `/dev/null`. This also parses paths with spaces printed
 * without quotes. No match means the header is not for our files, so use regular parsing.
 */
function knownHeaderPaths(rest: string, knownPaths: ReadonlySet<string>): HeaderPaths | null {
    const left = readKnownSide(rest, 'a/', knownPaths);
    if (left === null) {
        return null;
    }
    const right = readKnownSide(rest.slice(left.next), 'b/', knownPaths);
    if (right === null || left.next + right.next !== rest.length) {
        return null;
    }
    return { left: left.value, right: right.value };
}

interface KnownSide {
    readonly value: string | null;
    /** Index of the first character after the side, including the separating space. */
    readonly next: number;
}

function readKnownSide(source: string, prefix: string, knownPaths: ReadonlySet<string>): KnownSide | null {
    // A side either ends the header or is separated from the next by one space, so
    // find its boundary in the string itself: the end of the string and each space, instead of trying paths.
    // Try long candidates first, or `a/dir` would win for a header about `a/dir with space`.
    for (let end = source.length; end > 0; end = source.lastIndexOf(' ', end - 1)) {
        const candidate = source.slice(0, end);
        const known =
            candidate === '/dev/null' ||
            (candidate.startsWith(prefix) && knownPaths.has(candidate.slice(prefix.length)));
        if (!known) {
            continue;
        }
        return { value: stripSidePrefix(candidate), next: end === source.length ? end : end + 1 };
    }
    return null;
}

interface ReadPath {
    readonly value: string;
    /** Index of the first character after the parsed path. */
    readonly next: number;
}

function readPath(source: string, from: number): ReadPath | null {
    let index = from;
    while (index < source.length && source[index] === ' ') {
        index += 1;
    }
    if (index >= source.length) {
        return null;
    }

    if (source[index] === '"') {
        return readQuoted(source, index + 1);
    }
    const end = source.indexOf(' ', index);
    return end === -1
        ? { value: source.slice(index), next: source.length }
        : { value: source.slice(index, end), next: end };
}

/** Quoted path: git C escapes, `\"`, `\\`, control characters and octal UTF-8 bytes. */
function readQuoted(source: string, from: number): ReadPath {
    const bytes: number[] = [];
    let index = from;

    while (index < source.length && source[index] !== '"') {
        const char = source[index] ?? '';
        if (char !== '\\') {
            for (const byte of new TextEncoder().encode(char)) {
                bytes.push(byte);
            }
            index += 1;
            continue;
        }

        const next = source[index + 1] ?? '';
        const octal = /^[0-7]{3}$/.exec(source.slice(index + 1, index + 4));
        if (octal !== null) {
            bytes.push(Number.parseInt(octal[0], 8));
            index += 4;
            continue;
        }
        const escaped = ESCAPES.get(next);
        if (escaped === undefined) {
            for (const byte of new TextEncoder().encode(next)) {
                bytes.push(byte);
            }
        } else {
            bytes.push(escaped);
        }
        index += 2;
    }

    return { value: new TextDecoder().decode(new Uint8Array(bytes)), next: index + 1 };
}

const ESCAPES = new Map<string, number>([
    ['n', 0x0a],
    ['t', 0x09],
    ['r', 0x0d],
    ['a', 0x07],
    ['b', 0x08],
    ['f', 0x0c],
    ['v', 0x0b],
    ['"', 0x22],
    ['\\', 0x5c],
]);

/** Strips the patch side prefix: `a/path` → `path`. `/dev/null` is not a path. */
function stripSidePrefix(raw: string | undefined): string | null {
    if (raw === undefined || raw === '/dev/null') {
        return null;
    }
    const match = /^[ab]\/(.+)$/.exec(raw);
    return match?.[1] ?? raw;
}
