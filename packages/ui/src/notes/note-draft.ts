import type { AgentNote, AnchorPosition, ChatAnchor, FileAnchor } from '@sherpa/protocol';

/**
 * Comment draft from an agent note (SPEC §2.16): quote text and composer address.
 * This pure module is shared by both views and the route model.
 */

/** Quote heading: attribution stays in the draft text and is visible to the reviewer. */
const ATTRIBUTION = 'Quoted from the agent’s answer:';

/** Draft text: attribution, a blank line and the full note as a Markdown quote. */
export function noteDraftText(note: AgentNote): string {
    const lines = note.text.split(/\r?\n/u);
    while (lines.at(-1)?.trim() === '') {
        lines.pop();
    }
    return [ATTRIBUTION, '', ...lines.map((line) => (line.trim() === '' ? '>' : `> ${line}`))].join('\n');
}

/**
 * Comment position for a note range. `line` is the first line of the range, `size` is the number of
 * lines it spans, exactly what `commentPosition` gives for a selection of the same lines, so
 * a draft from a note is indistinguishable from one made with the pencil on a selection.
 */
export function noteCommentPosition(anchor: ChatAnchor): AnchorPosition {
    return { side: anchor.side, line: anchor.start, size: anchor.end - anchor.start + 1 };
}

/** Composer key, as with the line pencil: file, side and the first line of the range. */
export function noteComposerKey(anchor: ChatAnchor): string {
    return `new:${anchor.fileId}:${anchor.side}:${String(anchor.start)}`;
}

export function noteComposerAnchor(anchor: ChatAnchor): FileAnchor {
    return { fileId: anchor.fileId, path: anchor.path, position: noteCommentPosition(anchor) };
}
