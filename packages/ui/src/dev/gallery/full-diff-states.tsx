import { fileContentOf, fixtureData } from '@sherpa/fixtures';
import type { FixtureName } from '@sherpa/fixtures';
import type { Comment, FileDiff, Lens, Thread, UiFileProgress, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { changedLinesOf } from '../../progress/read-state.js';
import type { ThreadsShow } from '../../session/session-store.js';
import { createSessionStore, DEFAULT_THREADS_SHOW } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';

/**
 * Full "Full diff" view states: left panel with filters and tree, plus file cards
 * (visual acceptance layer 2, CLAUDE.md). Everything is computed synchronously from fixtures, without a server,
 * worker, timers or `localStorage`. Opening a state gives the same frame every time.
 */

interface WorkspaceStateProps {
    readonly fixture: FixtureName;
    readonly filter?: string;
    /** Override fixture lenses to build configurations missing from the fixtures. */
    readonly lenses?: UiReviewLensesResponse;
    /** Paths of files marked viewed: these show the directory read summary. */
    readonly viewed?: readonly string[];
    /** Prebuilt progress records for states that cannot be produced with manual marks. */
    readonly records?: readonly UiFileProgress[];
    /** The large fixture is parsed lazily: 64 synchronous parses would block the frame. */
    readonly preloadModels?: boolean;
    /** Keep one file in the diff to build any kind of single-file PR. */
    readonly onlyPath?: string;
    readonly showThreads?: boolean;
    readonly threadsShow?: ThreadsShow;
    readonly threads?: readonly Thread[];
    readonly prepareThreads?: (store: ThreadStore, threads: readonly Thread[]) => void;
}

function WorkspaceState({
    fixture,
    filter = 'all',
    lenses,
    viewed = [],
    records = [],
    preloadModels = true,
    onlyPath,
    showThreads = false,
    threadsShow = DEFAULT_THREADS_SHOW,
    threads,
    prepareThreads,
}: WorkspaceStateProps) {
    const data = useMemo(() => {
        const source = fixtureData(fixture);
        if (onlyPath === undefined) {
            return source;
        }
        return { ...source, diff: { ...source.diff, files: source.diff.files.filter((file) => file.path === onlyPath) } };
    }, [fixture, onlyPath]);
    const session = useMemo(
        () => createSessionStore({ initial: { view: 'diff', filter, threadsShow } }),
        [filter, threadsShow],
    );

    const shownThreads = useMemo(
        () => (showThreads ? (threads ?? data.threads) : []),
        [data.threads, showThreads, threads],
    );
    const threadStore = useMemo(() => {
        const created = createThreadStore(shownThreads, new Set(data.diff.files.map((file) => file.fileId)));
        prepareThreads?.(created, shownThreads);
        return created;
    }, [data.diff.files, prepareThreads, shownThreads]);

    const store = useMemo(() => {
        const created = createDiffViewStore({ files: data.diff.files, storage: null });
        if (preloadModels) {
            for (const file of data.diff.files) {
                created.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
            }
        }
        const marked = new Set(viewed);
        created.setProgress([
            ...data.diff.files
                .filter((file) => marked.has(file.path))
                .map((file) => ({ fileId: file.fileId, viewed: true, seenRanges: [] })),
            ...records,
        ]);
        return created;
    }, [data, preloadModels, records, viewed]);

    return (
        <div className="gallery__viewport">
            <DiffWorkspace
                pr={data.pr}
                diff={data.diff}
                threads={shownThreads}
                threadStore={threadStore}
                lenses={lenses ?? { ownership: data.ownership, extra: data.extraLenses }}
                prKey={`fixture-${fixture}`}
                session={session}
                store={store}
                collapsedStorage={null}
                threadNow={GALLERY_NOW}
                // The parser is synchronous: the gallery needs no worker and the frame does not depend on one.
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                onOpenInEditor={() => Promise.resolve('the gallery does not open an editor')}
                // The gallery has no progress endpoint: the record stays in the store, as does the diff mode choice.
                onSetViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');

const MEDIUM_VIEWED = [
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/schemas.ts',
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/order.ts',
];

/**
 * Partial file coverage: ranges come from the file's own changed lines, so "N of M"
 * the tooltip uses the actual model count. In M1 only the gallery writes ranges:
 * the endpoint will arrive with M2 stops.
 */
function partialRecord(fixture: FixtureName, path: string, share: number): UiFileProgress {
    const file = fileOf(fixture, path);
    const changed = changedLinesOf(parseFileDiff(toParseRequest(file)));
    const covered = [...(changed?.new ?? [])].sort((a, b) => a - b).slice(0, Math.ceil(share * (changed?.new.size ?? 0)));
    return {
        fileId: file.fileId,
        viewed: false,
        seenRanges: covered.map((line) => ({ side: 'new' as const, start: line, end: line })),
    };
}

/** Explicitly cleared generated-file mark (unpin, requirements §3.7): a record exists with the value "unread". */
function unpinnedRecord(fixture: FixtureName, path: string): UiFileProgress {
    return { fileId: fileOf(fixture, path).fileId, viewed: false, seenRanges: [] };
}

function fileOf(fixture: FixtureName, path: string): FileDiff {
    const file = fixtureData(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture ${fixture} has no file ${path}`);
    }
    return file;
}

/** Published audit scope with no files in this PR: the fixtures lack this configuration. */
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: true,
    note: 'This PR has no files in the PCI DSS audit scope.',
};

const ALL_THREADS: ThreadsShow = { people: true, bots: true, resolved: true };

function prepareDraftComposer(store: ThreadStore, threads: readonly Thread[]): void {
    const thread = threads.find((candidate) => !candidate.resolved && !candidate.root.author.bot);
    if (thread === undefined) {
        return;
    }
    const draft: Comment = {
        id: 'gallery-draft',
        author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
        body: 'I will add a check at the window boundary and update the test.',
        draft: true,
        createdAt: '2026-08-24T10:00:00.000Z',
        editedAt: null,
        replies: [],
    };
    store.addDraft({ body: draft.body, parentId: thread.root.id, anchor: null }, draft);
    store.openComposer({
        key: `reply:${thread.id}`,
        threadId: thread.id,
        parentId: thread.root.id,
        anchor: null,
        text: draft.body,
        commentId: draft.id,
        status: 'saved',
        saveUncertain: false,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

function prepareFailedComposer(store: ThreadStore): void {
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    const anchor = { fileId: file.fileId, path: file.path, position: { side: 'new' as const, line: 48, size: 1 } };
    store.openComposer({
        key: `new:${file.fileId}:new:48`,
        threadId: null,
        parentId: null,
        anchor,
        text: 'The remainingMs field misleads the client here.',
        commentId: null,
        status: 'error',
        saveUncertain: true,
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

function sourceThreadsOnHandlers(): Thread[] {
    const data = fixtureData('medium');
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    const position = { side: 'new' as const, line: 48, size: 1 };
    const openPerson = data.threads.find(
        (thread) => thread.anchor?.path === file.path && !thread.resolved && !thread.root.author.bot,
    );
    const bot = data.threads.find((thread) => thread.root.author.bot);
    const resolved = data.threads.find((thread) => thread.resolved);
    return [openPerson, bot, resolved]
        .filter((thread): thread is Thread => thread !== undefined)
        .map((thread) => ({ ...thread, anchor: { fileId: file.fileId, path: file.path, position } }));
}

function botThreadWithFortyReplies(): Thread[] {
    const source = fixtureData('medium').threads.find((thread) => thread.root.author.bot);
    if (source === undefined) {
        return [];
    }
    let replies: Comment[] = [];
    for (let index = 40; index >= 1; index -= 1) {
        replies = [
            {
                id: `bot-reply-${String(index)}`,
                author: source.root.author,
                body: `Automatic reply ${String(index)}: the check still sees this path.`,
                draft: false,
                createdAt: `2026-08-19T08:${String(index).padStart(2, '0')}:00.000Z`,
                editedAt: null,
                replies,
            },
        ];
    }
    return [{ ...source, root: { ...source.root, replies } }];
}

export interface FullDiffGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const FULL_DIFF_STATES: readonly FullDiffGalleryState[] = [
    {
        id: 'full-diff-tree',
        title: 'tree and filters, 18 files',
        render: () => <WorkspaceState fixture="medium" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-large',
        title: 'large tree, 64 files (virtualization)',
        render: () => <WorkspaceState fixture="large" preloadModels={false} />,
    },
    {
        id: 'full-diff-pci',
        title: 'PCI DSS filter: active chip, audit-scope banner',
        render: () => <WorkspaceState fixture="medium" filter="pci" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-zero',
        title: 'a filter with no files explains why',
        render: () => (
            <WorkspaceState
                fixture="medium"
                filter="pci"
                lenses={{ ownership: fixtureData('medium').ownership, extra: [EMPTY_PCI] }}
            />
        ),
    },
    {
        id: 'full-diff-mine-disabled',
        title: 'no CODEOWNERS zone: My files is disabled with a reason',
        render: () => <WorkspaceState fixture="edge" />,
    },
    {
        id: 'full-diff-outline',
        title: 'single-file PR: hunk outline replaces the tree',
        render: () => <WorkspaceState fixture="small" />,
    },
    {
        id: 'full-diff-read-tri-state',
        title: 'reading progress: read, partial, not started',
        render: () => (
            <WorkspaceState
                fixture="medium"
                viewed={MEDIUM_VIEWED}
                records={[partialRecord('medium', 'services/orders/src/domain/edit-window.ts', 0.4)]}
            />
        ),
    },
    {
        id: 'full-diff-read-generated',
        title: 'generated files read by default, one mark cleared by hand',
        render: () => (
            <WorkspaceState
                fixture="medium"
                filter="generated"
                records={[unpinnedRecord('medium', 'pnpm-lock.yaml')]}
            />
        ),
    },
    {
        id: 'full-diff-outline-binary',
        title: 'single-image PR: nothing for an outline',
        render: () => <WorkspaceState fixture="edge" onlyPath="services/orders/assets/edit-window-flow.png" />,
    },
    {
        id: 'threads-sources',
        title: 'human, bot and resolved threads with filters',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                threads={sourceThreadsOnHandlers()}
                threadsShow={ALL_THREADS}
            />
        ),
    },
    {
        id: 'threads-deep',
        title: 'deep nesting with capped indentation',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/domain/edit-window.ts"
                threadsShow={ALL_THREADS}
            />
        ),
    },
    {
        id: 'threads-composer-draft',
        title: 'composer and saved draft',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/domain/edit-window.ts"
                prepareThreads={prepareDraftComposer}
            />
        ),
    },
    {
        id: 'threads-composer-error',
        title: 'draft not saved, text preserved',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                prepareThreads={prepareFailedComposer}
            />
        ),
    },
    {
        id: 'threads-bot-collapsed',
        title: 'bot thread: first, last two and "37 more"',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/payments/card-token.ts"
                threads={botThreadWithFortyReplies()}
                threadsShow={ALL_THREADS}
            />
        ),
    },
    {
        id: 'threads-outside',
        title: 'collapsed group of threads outside the diff',
        render: () => (
            <WorkspaceState
                fixture="edge"
                showThreads
                onlyPath="services/orders/assets/edit-window-flow.png"
                threads={fixtureData('medium').threads.filter((thread) => thread.anchor === null)}
            />
        ),
    },
];
