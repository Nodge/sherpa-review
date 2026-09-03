import type { AgentNote, ChatAnchor, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { useCardNotes } from '../../notes/card-notes.tsx';
import { groupOverlappingNotes, noteStackKey } from '../../notes/model.js';
import { readStateOf } from '../../progress/read-state.js';
import { createSessionStore } from '../../session/session-store.js';

const FILE: FileDiff = {
    fileId: 'gallery-agent-note-file',
    path: 'src/review/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    patch: [
        '@@ -40,3 +40,5 @@',
        ' const cached = readCache(key);',
        '-return cached;',
        '+if (cached !== null) {',
        '+    return cached;',
        '+}',
        ' return load(key);',
        '',
    ].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const MARKDOWN_NOTE = [
    'The check separates cache hits from data loading.',
    '',
    'This keeps the fast path and leaves cache miss behaviour unchanged:',
    '',
    '- a cached value returns immediately.',
    '- loading is called only on a cache miss.',
].join('\n');

function note(id: number, start: number, end: number, createdAt: string, text = MARKDOWN_NOTE): AgentNote {
    const anchor: ChatAnchor = { diffId: 'gallery-iteration', fileId: FILE.fileId, path: FILE.path, side: 'new', start, end };
    return {
        id,
        exchangeId: 100 + id,
        anchor,
        text,
        lostAnchor: false,
        origin: { commit: 'abcdef1', anchor },
        createdAt,
    };
}

const PRIMARY_NOTE = note(31, 41, 43, '2026-09-01T10:04:00.000Z');
const NOTES = [
    PRIMARY_NOTE,
    note(32, 42, 43, '2026-09-01T10:03:00.000Z', 'Cache misses still follow the same path.\nThe check has a test.'),
    note(33, 43, 43, '2026-09-01T10:02:00.000Z', 'Returning from cache does not call the loader.'),
    note(34, 42, 44, '2026-09-01T10:01:00.000Z', 'The range includes the shared return after the condition.'),
];

export interface M3T7GalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M3_T7_STATES: readonly M3T7GalleryState[] = [
    {
        id: 'agent-note-collapsed',
        title: 'collapsed note beside a range',
        render: () => <NoteCardState notes={[PRIMARY_NOTE]} />,
    },
    {
        id: 'agent-note-expanded',
        title: 'expanded note with markdown and actions',
        render: () => <NoteCardState notes={[PRIMARY_NOTE]} expanded={[31]} />,
    },
    {
        id: 'agent-note-stack',
        title: 'stack of three overlapping notes',
        render: () => <NoteCardState notes={NOTES.slice(0, 3)} />,
    },
    {
        id: 'agent-note-stack-summary',
        title: 'summary row of four notes',
        render: () => <NoteCardState notes={NOTES} />,
    },
    {
        id: 'agent-note-stack-open',
        title: 'expanded list of four notes',
        render: () => <NoteCardState notes={NOTES} initialStackExpanded />,
    },
];

function NoteCardState({
    notes,
    expanded = [],
    initialStackExpanded = false,
}: {
    readonly notes: readonly AgentNote[];
    readonly expanded?: readonly number[];
    readonly initialStackExpanded?: boolean;
}) {
    const expandedKey = expanded.join(',');
    const initialExpanded = useMemo(
        () => new Set(expandedKey === '' ? [] : expandedKey.split(',')),
        [expandedKey],
    );
    const initialStacksExpanded = useMemo(
        () =>
            initialStackExpanded
                ? new Set(groupOverlappingNotes(notes).map((group) => noteStackKey(group)))
                : new Set<string>(),
        [initialStackExpanded, notes],
    );
    const session = useMemo(
        () =>
            createSessionStore({
                initial: {
                    view: 'diff',
                    filter: 'all',
                    notesExpanded: initialExpanded,
                    noteStacksExpanded: initialStacksExpanded,
                },
            }),
        [initialExpanded, initialStacksExpanded],
    );
    const { notesUnderHeader, renderAfterLine } = useCardNotes({
        model: MODEL,
        rowsShown: true,
        notes,
        placement: 'nearest',
        session,
        actions: {
            onOpenInChat: () => undefined,
            onTurnIntoDraft: () => undefined,
            onDelete: () => Promise.reject(new Error('gallery does not delete notes')),
        },
    });

    return (
        <div className="gallery__viewport">
            <div style={{ padding: 24 }}>
                <FileCard
                    file={FILE}
                    model={MODEL}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file: FILE, record: null })}
                    opened
                    showWhitespace={false}
                    selection={null}
                    threadsUnderHeader={notesUnderHeader}
                    renderAfterLine={renderAfterLine}
                    actions={ACTIONS}
                />
            </div>
        </div>
    );
}

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: (_fileId, _request) => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};
