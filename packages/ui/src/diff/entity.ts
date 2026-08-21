import type { DiffLine, EntityHeader, EntityRange, LanguageId } from './model.js';

/**
 * Hunk entity heuristic for the card header (SPEC §2.13). Two sources, in order of trust:
 * (a) text after the second `@@`, where git writes the enclosing declaration,
 * (b) a declaration found among the hunk lines.
 *
 * Nothing found means `null`: the header slot stays empty and never says "unknown".
 */

/** A long section from the hunk header is a piece of code, no longer an entity name. */
const MAX_LABEL_LENGTH = 80;

interface DeclarationPattern {
    re: RegExp;
    /** Index of the group containing the name. */
    group: number;
}

const DECLARATIONS: Readonly<Record<LanguageId, readonly DeclarationPattern[]>> = {
    ts: [
        {
            re: /^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|interface|enum|namespace|type)\s+([A-Za-z_$][\w$]*)/,
            group: 1,
        },
        { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[:=]/, group: 1 },
        // Class method: distinguished from a call by the opening body brace at the end of the line.
        {
            re: /^\s+(?:(?:public|private|protected|static|async|get|set|readonly)\s+)*([A-Za-z_$][\w$]*)\s*\([^;]*\)\s*(?::[^;{]*)?\{\s*$/,
            group: 1,
        },
    ],
    py: [{ re: /^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/, group: 1 }],
    go: [
        { re: /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, group: 1 },
        { re: /^\s*type\s+([A-Za-z_]\w*)/, group: 1 },
    ],
    // Data has no declarations. Guessing an "entity" in json/yaml/css/md would be misleading.
    json: [],
    yaml: [],
    css: [],
    md: [],
};

export interface EntityInput {
    /** Text after the second `@@`, or null if absent from the header. */
    section: string | null;
    lines: readonly DiffLine[];
    /** The hunk has no new side, so the range uses the old side. */
    newSideEmpty: boolean;
    language: LanguageId | null;
}

export function detectEntity(input: EntityInput): EntityHeader | null {
    return fromSection(input) ?? fromLines(input);
}

/** The header section describes the enclosing entity but does not say where it starts. */
function fromSection({ section, language }: EntityInput): EntityHeader | null {
    const text = section?.trim() ?? '';
    if (text.length === 0) {
        return null;
    }

    const name = declarationName(text, language);
    if (name !== null) {
        return { label: name, range: null };
    }
    return text.length <= MAX_LABEL_LENGTH ? { label: text, range: null } : null;
}

/**
 * First declaration among the hunk lines. The range runs from it to the end of the hunk. The parser
 * does not know where the entity actually ends and does not pretend to.
 */
function fromLines({ lines, newSideEmpty, language }: EntityInput): EntityHeader | null {
    const side: EntityRange['side'] = newSideEmpty ? 'old' : 'new';
    const lineNumber = (line: DiffLine): number | null => (side === 'old' ? line.oldLine : line.newLine);

    for (const line of lines) {
        const from = lineNumber(line);
        if (from === null) {
            continue;
        }
        const name = declarationName(line.text, language);
        if (name === null) {
            continue;
        }

        let to = from;
        for (const tail of lines) {
            to = Math.max(to, lineNumber(tail) ?? to);
        }
        return { label: name, range: { side, from, to } };
    }
    return null;
}

/** Declaration name in a code line, or null if there is no declaration. */
function declarationName(text: string, language: LanguageId | null): string | null {
    if (language === null) {
        return null;
    }
    for (const pattern of DECLARATIONS[language]) {
        const match = pattern.re.exec(text);
        const name = match?.[pattern.group];
        if (name !== undefined) {
            return name;
        }
    }
    return null;
}
