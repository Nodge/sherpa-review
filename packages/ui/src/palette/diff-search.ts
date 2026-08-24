import type { FileDiff } from '@sherpa/protocol';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';

export interface DiffSearchMatch {
    readonly fileId: string;
    readonly path: string;
    readonly side: 'old' | 'new';
    readonly line: number;
    readonly text: string;
    readonly matchStart: number;
    readonly matchEnd: number;
}

export interface DiffSearchResult {
    readonly matches: readonly DiffSearchMatch[];
    readonly truncated: boolean;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Searches raw unified patches without loading lazy file models. */
export function searchDiff(
    files: readonly FileDiff[],
    query: string,
    limit = 50,
): DiffSearchResult {
    const needle = query.trim().toLowerCase();
    if (needle === '' || limit <= 0) {
        return { matches: [], truncated: false };
    }

    const matches: DiffSearchMatch[] = [];
    for (const file of files) {
        if (file.patch === null) {
            continue;
        }

        let oldLine: number | null = null;
        let newLine: number | null = null;
        for (const raw of file.patch.split('\n')) {
            const header = HUNK_HEADER.exec(raw);
            if (header !== null) {
                oldLine = Number(header[1]);
                newLine = Number(header[2]);
                continue;
            }
            if (oldLine === null || newLine === null || raw.startsWith('\\ ')) {
                continue;
            }

            const marker = raw[0];
            let text: string;
            let target: { readonly side: 'old' | 'new'; readonly line: number };
            if (marker === '+') {
                text = raw.slice(1);
                target = { side: 'new', line: newLine };
                newLine += 1;
            } else if (marker === '-') {
                text = raw.slice(1);
                target = { side: 'old', line: oldLine };
                oldLine += 1;
            } else {
                // The canonical parser fails open. Ordinary context, a bare empty line and
                // an unknown prefix occupy a line on both sides.
                text = marker === ' ' || raw === '' ? raw.slice(1) : raw;
                target = { side: 'new', line: newLine };
                oldLine += 1;
                newLine += 1;
            }

            const matchStart = text.toLowerCase().indexOf(needle);
            if (matchStart < 0) {
                continue;
            }
            if (matches.length === limit) {
                return { matches, truncated: true };
            }
            matches.push({
                fileId: file.fileId,
                path: file.path,
                side: target.side,
                line: target.line,
                text,
                matchStart,
                matchEnd: matchStart + needle.length,
            });
        }
    }
    return { matches, truncated: false };
}

/** The side where the line number exists. Context lines prefer the new side. */
export function lineSideInDiff(file: FileDiff, line: number): 'old' | 'new' | null {
    const model = parseFileDiff(toParseRequest(file));
    if (model.content.kind !== 'text') {
        return null;
    }

    let oldExists = false;
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const candidate of block.lines) {
            if (candidate.newLine === line) {
                return 'new';
            }
            if (candidate.oldLine === line) {
                oldExists = true;
            }
        }
    }
    return oldExists ? 'old' : null;
}
