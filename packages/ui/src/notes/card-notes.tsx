import type { AgentNote } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo, useState, useSyncExternalStore } from 'react';

import type { DiffFileModel } from '../diff/model.js';
import { READ_ONLY_REASON, useReadOnlyIteration } from '../iterations/read-only.tsx';
import { Markdown } from '../markdown/markdown.tsx';
import type { SessionStore } from '../session/session-store.js';
import { isNoteExpanded, isNoteStackExpanded } from '../session/session-store.js';
import { formatCount, plural } from '../text.js';
import type { NoteGroup } from './model.js';
import { noteStackKey, noteStackNeedsSummary, placeNotesOnVisibleLines } from './model.js';
import './notes.css';

export interface CardNoteActions {
    readonly onOpenInChat: (note: AgentNote) => void;
    /** New comment composer at the note anchor, prefilled with its quote (SPEC §2.16). */
    readonly onTurnIntoDraft: (note: AgentNote) => void;
    readonly onDelete: (noteId: number) => Promise<void>;
}

export interface CardNotesInput {
    readonly model: DiffFileModel | null;
    readonly rowsShown: boolean;
    readonly notes: readonly AgentNote[];
    readonly placement: 'nearest' | 'exact';
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}

export interface CardNotes {
    readonly notesUnderHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
}

/** Shared note layout for the full diff and route, differing only in line lookup mode. */
export function useCardNotes({
    model,
    rowsShown,
    notes,
    placement,
    session,
    actions,
}: CardNotesInput): CardNotes {
    const snapshot = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
    const layout = useMemo(
        () => placeNotesOnVisibleLines(model, rowsShown, notes, placement),
        [model, notes, placement, rowsShown],
    );
    const renderGroups = useCallback(
        (groups: readonly NoteGroup[]): ReactNode =>
            groups.map((group) => (
                <NoteGroupView
                    key={groupKey(group)}
                    group={group}
                    expanded={snapshot.notesExpanded}
                    stacksExpanded={snapshot.noteStacksExpanded}
                    session={session}
                    actions={actions}
                />
            )),
        [actions, session, snapshot.noteStacksExpanded, snapshot.notesExpanded],
    );
    const notesUnderHeader = useMemo(
        () =>
            layout.underHeader.length === 0 ? null : (
                <div className="agent-notes agent-notes--under-header">{renderGroups(layout.underHeader)}</div>
            ),
        [layout.underHeader, renderGroups],
    );
    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const groups = layout.byLine.get(`${side}:${String(line)}`);
            return groups === undefined ? null : (
                <div className="diff-row-extra agent-notes">{renderGroups(groups)}</div>
            );
        },
        [layout.byLine, renderGroups],
    );

    return { notesUnderHeader, renderAfterLine };
}

function NoteGroupView({
    group,
    expanded,
    stacksExpanded,
    session,
    actions,
}: {
    readonly group: NoteGroup;
    readonly expanded: ReadonlySet<string>;
    readonly stacksExpanded: ReadonlySet<string>;
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}) {
    const stackKey = noteStackKey(group);
    const summarized = noteStackNeedsSummary(group);
    const open =
        isNoteStackExpanded({ noteStacksExpanded: stacksExpanded }, stackKey) ||
        group.notes.some((note) => expanded.has(String(note.id)));

    if (summarized && !open) {
        return (
            <button
                type="button"
                className="agent-note-stack-summary"
                aria-expanded="false"
                onClick={() => {
                    session.setNoteStackExpanded(stackKey, true);
                }}
            >
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                {formatCount(group.notes.length)} {plural(group.notes.length, 'note', 'notes', 'notes')} here
            </button>
        );
    }

    return (
        <div className="agent-note-stack">
            {summarized ? (
                <button
                    type="button"
                    className="agent-note-stack__collapse"
                    aria-expanded="true"
                    onClick={() => {
                        session.collapseNoteStack(stackKey, group.notes.map((note) => note.id));
                    }}
                >
                    Collapse the list
                </button>
            ) : null}
            {group.notes.map((note) => (
                <AgentNoteView
                    key={note.id}
                    note={note}
                    expanded={isNoteExpanded({ notesExpanded: expanded }, note.id)}
                    session={session}
                    actions={actions}
                />
            ))}
        </div>
    );
}

function AgentNoteView({
    note,
    expanded,
    session,
    actions,
}: {
    readonly note: AgentNote;
    readonly expanded: boolean;
    readonly session: SessionStore;
    readonly actions: CardNoteActions;
}) {
    const [deleting, setDeleting] = useState(false);
    // A note is always readable. Creating a comment draft from it requires the active iteration.
    const readOnly = useReadOnlyIteration();
    const [error, setError] = useState<string | null>(null);

    if (!expanded) {
        return (
            <button
                type="button"
                className="agent-note agent-note--collapsed"
                data-note={note.id}
                aria-expanded="false"
                onClick={() => {
                    session.toggleNoteExpanded(note.id);
                }}
            >
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                <span className="agent-note__label">Agent note</span>
                <span className="agent-note__separator" aria-hidden="true">·</span>
                <span className="agent-note__preview">{firstTextLine(note.text)}</span>
                <span className="agent-note__separator" aria-hidden="true">·</span>
                <span className="agent-note__count">{lineCountLabel(note.text)}</span>
            </button>
        );
    }

    const range = note.anchor.start === note.anchor.end
        ? `asked at line ${String(note.anchor.start)}`
        : `asked at lines ${String(note.anchor.start)}–${String(note.anchor.end)}`;
    return (
        <article className="agent-note agent-note--expanded" data-note={note.id} tabIndex={-1}>
            <header className="agent-note__header">
                <span className="agent-note__diamond" aria-hidden="true">◆</span>
                <span>Agent note · {range}</span>
            </header>
            <div className="agent-note__provenance">model answer · never published to the PR</div>
            <div className="agent-note__body">
                <Markdown text={note.text} profile="comment" />
            </div>
            <div className="agent-note__actions">
                <button
                    type="button"
                    onClick={() => {
                        actions.onOpenInChat(note);
                    }}
                >
                    Open in the chat
                </button>
                <button
                    type="button"
                    disabled={readOnly}
                    title={readOnly ? READ_ONLY_REASON : undefined}
                    onClick={() => {
                        actions.onTurnIntoDraft(note);
                    }}
                >
                    Turn into a comment draft
                </button>
                <button
                    type="button"
                    onClick={() => {
                        session.toggleNoteExpanded(note.id);
                    }}
                >
                    Collapse
                </button>
                <button
                    type="button"
                    disabled={deleting}
                    onClick={() => {
                        setDeleting(true);
                        setError(null);
                        void actions.onDelete(note.id).catch((reason: unknown) => {
                            setDeleting(false);
                            setError(reason instanceof Error ? reason.message : String(reason));
                        });
                    }}
                >
                    {deleting ? 'Deleting' : 'Delete'}
                </button>
            </div>
            {error === null ? null : (
                <div className="agent-note__error" role="alert">
                    Could not delete the note: {error}
                </div>
            )}
        </article>
    );
}

function firstTextLine(text: string): string {
    return text.split(/\r?\n/u).find((line) => line.trim() !== '')?.trim() ?? text.trim();
}

function lineCountLabel(text: string): string {
    const count = text.split('\n').length;
    return `${formatCount(count)} ${plural(count, 'line', 'lines', 'lines')}`;
}

function groupKey(group: NoteGroup): string {
    return noteStackKey(group);
}
