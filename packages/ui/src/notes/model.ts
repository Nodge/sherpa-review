import type { AgentNote, ChatAnchor } from '@sherpa/protocol';

import type { DiffFileModel } from '../diff/model.js';
import type { MessageKey } from '../i18n/index.js';

/** Why a note without an anchor cannot become a comment draft. */
export const NOTE_LOST_DRAFT_REASON: MessageKey = 'thread.note.lostDraft';

/** Why chat cannot navigate to code: the note is absent from this iteration. */
export const NOTE_LOST_ANCHOR_REASON: MessageKey = 'thread.note.lostAnchor';

/**
 * A note anchor as seen in the viewed iteration (M4-T11). In the iteration where the note
 * was pinned, it stays at its original lines. In any other iteration, it uses the carried-over lines.
 */
export function noteAnchorForIteration(note: AgentNote, viewDiffId: string | null): ChatAnchor {
    return viewDiffId !== null && viewDiffId === note.origin.anchor.diffId ? note.origin.anchor : note.anchor;
}

/**
 * The note appears beside code in this iteration. A note with a lost anchor leaves code everywhere except its
 * original iteration, where the lines it was asked about still exist (SPEC §2.16).
 */
export function noteVisibleInIteration(note: AgentNote, viewDiffId: string | null): boolean {
    return !note.lostAnchor || (viewDiffId !== null && viewDiffId === note.origin.anchor.diffId);
}

/** Notes to place beside code in the selected iteration, using its anchors and excluding lost anchors. */
export function notesForIteration(
    notes: readonly AgentNote[],
    viewDiffId: string | null,
): readonly AgentNote[] {
    return notes
        .filter((note) => noteVisibleInIteration(note, viewDiffId))
        .map((note) => {
            const anchor = noteAnchorForIteration(note, viewDiffId);
            return anchor === note.anchor ? note : { ...note, anchor };
        });
}

export interface NoteGroup {
    readonly fileId: string;
    readonly side: 'old' | 'new';
    readonly start: number;
    readonly end: number;
    readonly notes: readonly AgentNote[];
}

export interface NotePlacement {
    readonly byLine: ReadonlyMap<string, readonly NoteGroup[]>;
    readonly underHeader: readonly NoteGroup[];
    /** In exact mode, the group falls outside this clipped card and is not rendered. */
    readonly hidden: readonly NoteGroup[];
}

export const NOTE_STACK_SUMMARY_THRESHOLD = 3;

/** The session key of a stack does not depend on which notes it contains. */
export function noteStackKey(group: Pick<NoteGroup, 'fileId' | 'side' | 'start' | 'end'>): string {
    return `${group.fileId}:${group.side}:${String(group.start)}:${String(group.end)}`;
}

/** Ranges connected by overlaps form a stack, with newer notes first. */
export function groupOverlappingNotes(notes: readonly AgentNote[]): readonly NoteGroup[] {
    const ordered = [...notes].sort(
        (left, right) =>
            left.anchor.fileId.localeCompare(right.anchor.fileId) ||
            left.anchor.side.localeCompare(right.anchor.side) ||
            left.anchor.start - right.anchor.start ||
            left.anchor.end - right.anchor.end ||
            left.id - right.id,
    );
    const groups: NoteGroup[] = [];

    for (const note of ordered) {
        const previous = groups.at(-1);
        if (
            previous?.fileId !== note.anchor.fileId ||
            previous.side !== note.anchor.side ||
            note.anchor.start > previous.end
        ) {
            groups.push({
                fileId: note.anchor.fileId,
                side: note.anchor.side,
                start: note.anchor.start,
                end: note.anchor.end,
                notes: [note],
            });
            continue;
        }

        groups[groups.length - 1] = {
            ...previous,
            start: Math.min(previous.start, note.anchor.start),
            end: Math.max(previous.end, note.anchor.end),
            notes: [...previous.notes, note],
        };
    }

    return groups.map((group) => ({
        ...group,
        notes: [...group.notes].sort(
            (left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt) || right.id - left.id,
        ),
    }));
}

/** Place stacks below the last line of their combined range. */
export function placeNotesOnVisibleLines(
    model: DiffFileModel | null,
    rowsShown: boolean,
    notes: readonly AgentNote[],
    placement: 'nearest' | 'exact',
): NotePlacement {
    const byLine = new Map<string, NoteGroup[]>();
    const groups = groupOverlappingNotes(notes);
    if (!rowsShown || model?.content.kind !== 'text') {
        return { byLine, underHeader: groups, hidden: [] };
    }

    const visible = { old: new Set<number>(), new: new Set<number>() };
    for (const block of model.content.blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.oldLine !== null) {
                visible.old.add(line.oldLine);
            }
            if (line.newLine !== null) {
                visible.new.add(line.newLine);
            }
        }
    }

    const underHeader: NoteGroup[] = [];
    const hidden: NoteGroup[] = [];
    for (const group of groups) {
        const candidates = [...visible[group.side]];
        if (candidates.length === 0) {
            underHeader.push(group);
            continue;
        }
        if (placement === 'exact' && !groupIntersectsVisibleLines(group, visible[group.side])) {
            hidden.push(group);
            continue;
        }
        if (placement === 'exact' && !visible[group.side].has(group.end)) {
            underHeader.push(group);
            continue;
        }
        const line = visible[group.side].has(group.end)
            ? group.end
            : candidates.reduce((nearest, candidate) =>
                  Math.abs(candidate - group.end) < Math.abs(nearest - group.end) ? candidate : nearest,
              );
        const key = `${group.side}:${String(line)}`;
        const bucket = byLine.get(key);
        if (bucket === undefined) {
            byLine.set(key, [group]);
        } else {
            bucket.push(group);
        }
    }

    return { byLine, underHeader, hidden };
}

function groupIntersectsVisibleLines(group: NoteGroup, visible: ReadonlySet<number>): boolean {
    for (const line of visible) {
        if (line >= group.start && line <= group.end) {
            return true;
        }
    }
    return false;
}

export function noteStackNeedsSummary(group: NoteGroup): boolean {
    return group.notes.length > NOTE_STACK_SUMMARY_THRESHOLD;
}
