import type { ChatAnchor } from '@sherpa/protocol';

import { readFragmentParam, updateFragment } from './fragment.js';

export interface SelectionLinkTarget {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
}

/** `null` means the fragment contains no complete valid range anchor. */
export function readSelectionLink(hash: string): SelectionLinkTarget | null {
    const fileId = readFragmentParam(hash, 'file');
    const side = readFragmentParam(hash, 'side');
    const start = positiveInteger(readFragmentParam(hash, 'line'));
    const end = positiveInteger(readFragmentParam(hash, 'end'));
    if (fileId === null || (side !== 'old' && side !== 'new') || start === null || end === null || end < start) {
        return null;
    }
    return { fileId, side, start, end };
}

/** Adds a range, preserves the selected view and removes conflicting navigation targets. */
export function selectionLinkHash(hash: string, anchor: ChatAnchor): string {
    return updateFragment(hash, {
        file: anchor.fileId,
        side: anchor.side,
        line: String(anchor.start),
        end: String(anchor.end),
        thread: null,
        stop: null,
    });
}

function positiveInteger(value: string | null): number | null {
    if (value === null || !/^\d+$/.test(value)) {
        return null;
    }
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
