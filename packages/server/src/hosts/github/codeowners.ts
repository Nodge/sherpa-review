/**
 * CODEOWNERS parsing and matching as pure functions without IO (network calls live in `github-host.ts`).
 *
 * Semantics (`docs/research/github-api.md` §CODEOWNERS):
 * - a line is `<pattern> <owner>…`. `#` starts a comment at the start of a line or after a space.
 * - a file gets the owners of the **last** matching rule, rather than all matching rules
 *   (matching rules do not accumulate).
 * - a pattern without owners clears ownership assigned by preceding rules.
 * - supports a gitignore subset without GitHub extensions: `!` negation, `[a-z]` classes
 *   and escaped hashes are unsupported. Sherpa ignores these lines entirely, just as
 *   GitHub ignores them and reports an error. `{a,b}` is literal, GitHub has no alternatives.
 *
 * A Java NIO glob dialect does not work here because its anchoring rules
 * and `**` behaviour differ.
 */

/** One file rule: pattern, owners (empty means unowned) and line number for diagnostics. */
export interface CodeownersRule {
    readonly pattern: string;
    readonly owners: readonly string[];
    readonly line: number;
}

/**
 * Compiled rule pattern. Stored alongside the rule, so the public rule contains exactly
 * what the file says. Only matching needs the regex.
 */
const matchers = new WeakMap<CodeownersRule, RegExp>();

/** Glob metacharacters. Excludes `[`/`]`, since parsing drops lines with classes. */
const GLOB_META = new Set(['*', '?']);

/** Leading byte order mark. It is not part of the first line's pattern. */
const BOM = '\uFEFF';

/**
 * File rules in declaration order, with unsupported syntax and comments removed.
 *
 * Accepts `\r\n` line endings and strips the BOM, since files may be created on
 * Windows. A trailing `\r` would stick to the owner login and silently break the entire rule.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
    const rules: CodeownersRule[] = [];
    const lines = (text.startsWith(BOM) ? text.slice(BOM.length) : text).split(/\r?\n/);

    for (let index = 0; index < lines.length; index += 1) {
        const raw = lines[index] ?? '';
        const tokens = splitTokens(stripComment(raw));
        const pattern = tokens[0];
        if (pattern === undefined) {
            continue;
        }
        const matcher = compilePattern(pattern);
        if (matcher === null) {
            continue;
        }
        const rule: CodeownersRule = { pattern, owners: tokens.slice(1), line: index + 1 };
        matchers.set(rule, matcher);
        rules.push(rule);
    }

    return rules;
}

/**
 * The last matching rule determines path ownership. `null` means no rule covers the path.
 * Returns ownerless rules as they are, since unowned is also an answer.
 */
export function ownersOf(rules: readonly CodeownersRule[], path: string): CodeownersRule | null {
    for (let index = rules.length - 1; index >= 0; index -= 1) {
        const rule = rules[index];
        if (rule !== undefined && matcherOf(rule).test(path)) {
            return rule;
        }
    }
    return null;
}

/**
 * The zone boundary of a rule for a covered file is the static pattern prefix
 * (`src/pci/**` → `src/pci`, `/apps/` → `apps`, `docs/*.md` → `docs`).
 *
 * A pattern without a leading `/` matches at any depth, so its static prefix is located
 * within the path itself: `apps/` on `deep/apps/x.ts` gives the zone `deep/apps`, not `apps`.
 * Without a static prefix (`*.js`, a double-star pattern), the zone is the top-level
 * directory or the file itself at the root. The protocol forbids an empty zone `path`.
 */
export function zonePathOf(rule: CodeownersRule, path: string): string {
    const prefix = staticPrefix(rule.pattern);
    if (prefix.length === 0) {
        return topDirOf(path);
    }

    const zone = prefix.join('/');
    if (path === zone || path.startsWith(`${zone}/`)) {
        return zone;
    }
    return locatePrefix(path, prefix) ?? topDirOf(path);
}

function matcherOf(rule: CodeownersRule): RegExp {
    const known = matchers.get(rule);
    if (known !== undefined) {
        return known;
    }
    // The rule bypassed `parseCodeowners` (as tests do), so compile it here.
    const compiled = compilePattern(rule.pattern) ?? /(?!)/;
    matchers.set(rule, compiled);
    return compiled;
}

/**
 * Drops the rest of the line after `#`. A hash starts a comment at the start of a line
 * or after a space. An escaped hash (`\#`) does not start a comment, but Sherpa still
 * rejects such patterns (`compilePattern`).
 */
function stripComment(line: string): string {
    let escaped = false;
    let previousIsSpace = true;

    for (let index = 0; index < line.length; index += 1) {
        const char = line.charAt(index);
        if (escaped) {
            escaped = false;
            previousIsSpace = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            previousIsSpace = false;
            continue;
        }
        if (char === '#' && previousIsSpace) {
            return line.slice(0, index);
        }
        previousIsSpace = char === ' ' || char === '\t';
    }
    return line;
}

/** Line words, split on unescaped spaces. `\ ` remains part of the pattern. */
function splitTokens(line: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let escaped = false;

    for (const char of line) {
        if (escaped) {
            current += `\\${char}`;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === ' ' || char === '\t') {
            if (current !== '') {
                tokens.push(current);
                current = '';
            }
            continue;
        }
        current += char;
    }
    if (escaped) {
        current += '\\';
    }
    if (current !== '') {
        tokens.push(current);
    }
    return tokens;
}

/**
 * Converts a pattern to a regex for the whole path from the repository root. `null` means
 * unsupported syntax, so the line must be dropped.
 *
 * Anchoring: a leading or internal `/` anchors the pattern at the root, otherwise it matches at any
 * depth. A trailing `/` matches only a directory and everything under it. A pattern whose last segment is
 * an exact name matches a file or a directory and its contents (`/apps/github`). A glob segment matches
 * only what it directly hits (`docs/*` matches direct children only).
 */
function compilePattern(pattern: string): RegExp | null {
    if (pattern.startsWith('!') || pattern.includes('[') || pattern.includes(']') || pattern.includes('\\#')) {
        return null;
    }

    const dirOnly = pattern.endsWith('/');
    const body = (dirOnly ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '');
    const segments = body.split('/').filter((segment) => segment !== '');
    const last = segments[segments.length - 1];
    if (last === undefined) {
        return null;
    }

    const anchored = pattern.startsWith('/') || body.includes('/');
    let source = anchored ? '^' : '^(?:[^/]+/)*';
    let needSlash = false;

    segments.forEach((segment, index) => {
        if (segment === '**') {
            if (index === segments.length - 1) {
                source += needSlash ? '/.*' : '.*';
                return;
            }
            source += needSlash ? '/(?:[^/]+/)*' : '(?:[^/]+/)*';
            needSlash = false;
            return;
        }
        source += (needSlash ? '/' : '') + compileSegment(segment);
        needSlash = true;
    });

    // A pattern ending in double star already got its suffix in the loop. `foo/**/` means everything
    // under `foo`, not at least two levels of nesting.
    if (last !== '**') {
        if (dirOnly) {
            source += '/.*';
        } else if (!hasGlobMeta(last)) {
            source += '(?:/.*)?';
        }
    }

    return new RegExp(`${source}$`);
}

/** One segment: `*` stays within `/`, `?` matches one character except `/`, everything else is literal. */
function compileSegment(segment: string): string {
    let source = '';
    let escaped = false;

    for (const char of segment) {
        if (escaped) {
            source += escapeLiteral(char);
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            continue;
        }
        if (char === '*') {
            source += '[^/]*';
            continue;
        }
        if (char === '?') {
            source += '[^/]';
            continue;
        }
        source += escapeLiteral(char);
    }
    return escaped ? `${source}\\\\` : source;
}

function escapeLiteral(char: string): string {
    return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Pattern segments before the first glob segment, unescaped because this is now a path. */
function staticPrefix(pattern: string): string[] {
    const body = (pattern.endsWith('/') ? pattern.slice(0, -1) : pattern).replace(/^\/+/, '');
    const fixed: string[] = [];

    for (const segment of body.split('/')) {
        if (segment === '' || segment === '**' || hasGlobMeta(segment)) {
            break;
        }
        fixed.push(segment.replace(/\\(.)/g, '$1'));
    }
    return fixed;
}

function hasGlobMeta(segment: string): boolean {
    let escaped = false;
    for (const char of segment) {
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = true;
        } else if (GLOB_META.has(char)) {
            return true;
        }
    }
    return false;
}

/** Path through the prefix segments, inclusive. `null` means no such occurrence. */
function locatePrefix(path: string, prefix: readonly string[]): string | null {
    const segments = path.split('/');
    for (let start = 0; start + prefix.length <= segments.length; start += 1) {
        if (prefix.every((segment, offset) => segments[start + offset] === segment)) {
            return segments.slice(0, start + prefix.length).join('/');
        }
    }
    return null;
}

/** Top-level directory, or the file itself at the root. The protocol forbids an empty zone `path`. */
function topDirOf(path: string): string {
    return path.split('/')[0] ?? path;
}
