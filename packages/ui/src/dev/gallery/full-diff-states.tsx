import { fileContentOf, fixtureIteration } from '@sherpa/fixtures';
import type { FixtureIterationView, FixtureName } from '@sherpa/fixtures';
import type { Comment, FileDiff, Lens, Thread, UiFileProgress, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { changedLinesOf } from '../../progress/read-state.js';
import { createSessionStore } from '../../session/session-store.js';
import { createThreadStore } from '../../threads/store.js';
import type { ThreadStore } from '../../threads/store.js';
import { DiffWorkspace } from '../../views/full-diff.tsx';
import { asFetched } from './fetched.js';

/**
 * Full diff view states: the left panel with filters and the tree, plus cards.
 * Everything is computed from fixtures synchronously, without a server, worker, timers or `localStorage`:
 * opening a state produces the same frame.
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
    /** Limit the diff to the listed files to build a tree shape missing from the fixtures. */
    readonly paths?: readonly string[];
    /**
     * Rename files on top of the fixture: the fixtures lack names of the required length, and adding them there
     * for one frame costs more. Lens membership moves with the path, so tags remain.
     */
    readonly renameTo?: Readonly<Record<string, string>>;
    readonly showThreads?: boolean;
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
    paths,
    renameTo,
    showThreads = false,
    threads,
    prepareThreads,
}: WorkspaceStateProps) {
    const data = useMemo(() => {
        const source = asFetched(fixtureIteration(fixture));
        const keep =
            onlyPath === undefined
                ? paths
                : [onlyPath];
        const narrowed =
            keep === undefined
                ? source
                : {
                      ...source,
                      diff: { ...source.diff, files: source.diff.files.filter((file) => keep.includes(file.path)) },
                  };
        return renameTo === undefined ? narrowed : renamePaths(narrowed, renameTo);
    }, [fixture, onlyPath, paths, renameTo]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter } }), [filter]);

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
        const created = createDiffViewStore({ files: data.diff.files });
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
                threadNow={GALLERY_NOW}
                // The parser is synchronous: the gallery needs no worker and the frame does not depend on one.
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                // The gallery has no progress endpoint: the record stays in the store, as does the diff mode choice.
                onSetViewed={() => Promise.resolve(0)}
            />
        </div>
    );
}

const GALLERY_NOW = Date.parse('2026-08-24T12:00:00.000Z');
const DRAFT_SAVED_AT = Date.parse('2026-08-24T10:00:00.000Z');

/**
 * Directory `generated` with a single file next to regular `payments` files: the directory has
 * its own row, and the file below carries only its name (SPEC-theming-2026-09-12 §6a). This is the
 * case that collapsed into `/psp-schema.…` before T7.
 */
const SINGLE_FILE_DIR_PATHS = [
    'services/orders/src/payments/card-token.ts',
    'services/orders/src/payments/pci-audit.ts',
    'services/orders/src/payments/generated/psp-schema.ts',
];

/**
 * Name longer than the fixture name: in the narrow panel (320px at 1440px) it does not fit with 2 tags,
 * showing that the name itself is truncated at the end, without a stray slash from the directory.
 */
const SINGLE_FILE_DIR_RENAME = {
    'services/orders/src/payments/generated/psp-schema.ts':
        'services/orders/src/payments/generated/psp-settlement-authorize-schema.ts',
};

/** Paths up to 3 levels deep from the panel root: checks that filenames fit in full. */
const DEEP_PATHS = [
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/__tests__/edit-policy.test.ts',
    'services/orders/src/domain/__tests__/edit-window.test.ts',
    'services/orders/src/domain/policies/edit-policy.ts',
    'services/orders/src/domain/order.ts',
];

const MEDIUM_VIEWED = [
    'services/orders/src/api/handlers.ts',
    'services/orders/src/api/schemas.ts',
    'services/orders/src/api/__tests__/handlers.test.ts',
    'services/orders/src/domain/order.ts',
];

/**
 * Partial file coverage: ranges come from the file's own changed lines, so "N of M"
 * in the tooltip is the actual model count, not a made-up number.
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

/** Explicitly cleared generated file mark (un-pin, docs/architecture.md §7.7): the record exists with an "unread" value. */
function unpinnedRecord(fixture: FixtureName, path: string): UiFileProgress {
    return { fileId: fileOf(fixture, path).fileId, viewed: false, seenRanges: [] };
}

function fileOf(fixture: FixtureName, path: string): FileDiff {
    const file = fixtureIteration(fixture).diff.files.find((candidate) => candidate.path === path);
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
    zones: null,
};

/** Fixture with new filenames: lens membership moves along with the path. */
function renamePaths(
    view: FixtureIterationView,
    renameTo: Readonly<Record<string, string>>,
): FixtureIterationView {
    const rename = (path: string): string => renameTo[path] ?? path;
    const renameLens = (value: Lens): Lens => ({
        ...value,
        paths: value.paths.map(rename),
        zones: value.zones?.map((zone) => ({ ...zone, paths: zone.paths.map(rename) })) ?? null,
    });
    return {
        ...view,
        diff: { ...view.diff, files: view.diff.files.map((file) => ({ ...file, path: rename(file.path) })) },
        ownership: view.ownership === null ? null : renameLens(view.ownership),
        extraLenses: view.extraLenses.map(renameLens),
    };
}

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
        issue: null,
        resolved: null,
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
        savedAt: DRAFT_SAVED_AT,
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
        issue: true,
        text: 'The remainingMs field misleads the client here.',
        commentId: null,
        status: 'error',
        slow: false,
        confirmDiscard: false,
        resolvedAtOpen: false,
    });
}

function sourceThreadsOnHandlers(): Thread[] {
    const data = fixtureIteration('medium');
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
    const source = fixtureIteration('medium').threads.find((thread) => thread.root.author.bot);
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
                issue: null,
                resolved: null,
                createdAt: `2026-08-19T08:${String(index).padStart(2, '0')}:00.000Z`,
                editedAt: null,
                replies,
            },
        ];
    }
    return [{ ...source, root: { ...source.root, replies } }];
}

/**
 * Markdown display: one thread whose body contains the entire `comment` profile,
 * including content that must not render: raw HTML, a `javascript:` link and an unmatched backtick
 * must remain text.
 */
const MARKDOWN_SHOWCASE = [
    '# Level 1 heading',
    '## Level 2, same font size',
    '### Level 3, one size smaller',
    '#### Level 4, body font size',
    '##### Level 5',
    '###### And level 6',
    '',
    'An ordinary paragraph with **bold**, *italic*, ~~strikethrough~~ and inline code `EditPolicy.decide()`.',
    'A single line break stays a line break. People write plain text.',
    '',
    'Nested list:',
    '',
    '- first item with a link [to the issue](https://github.com/quillmart/quillmart/issues/2281)',
    '  - nested item with `code`',
    '- second item',
    '',
    '1. numbered',
    '2. and second',
    '',
    '- [x] checklist: checked item',
    '- [ ] and unchecked',
    '',
    '> Quote: contents are parsed by the same parser.',
    '>',
    '> - and a list inside a quote too',
    '> > Nested quote, the second and final level.',
    '',
    'Table with alignment and a long cell:',
    '',
    '| File | Lines | Comment |',
    '| :--- | ---: | :---: |',
    '| `services/orders/src/domain/edit-window.ts` | 128 | centered |',
    '| `handlers.ts` | 42 | pipe \\| inside a cell |',
    '| the unbroken token services_orders_domain_edit_window_policy_decision_remaining_ms stretches the table to the right | 7 | and enables scrolling |',
    '',
    'A long bare URL wraps instead of stretching the column:',
    'https://wiki.example.internal/checkout/security/incident-response/historical-records-scrubbing/#retention',
    'A bare long token without a link does too: services_orders_domain_edit_window_policy_decision_remaining_ms_threshold_constant',
    '',
    '```ts',
    'const decision = policy.decide(order, clock.now());',
    'if (!decision.allowed) throw new EditWindowClosed(decision.reason, decision.remainingMs);',
    '```',
    '',
    'An unknown fenced code language gets no highlighting, only `data-lang`:',
    '',
    '```rust',
    'fn main() { println!("{}", 42); }',
    '```',
    '',
    'Raw HTML stays text: <img src=x onerror="alert(1)"> and <b>bold</b>.',
    'A link with another scheme stays text too: [click](javascript:alert(1)).',
    'An unmatched backtick is literal: field `slot became required.',
].join('\n');

function markdownShowcaseThread(): Thread[] {
    const source = fixtureIteration('medium').threads.find((thread) => thread.root.author.bot);
    const file = fileOf('medium', 'services/orders/src/api/handlers.ts');
    if (source === undefined) {
        return [];
    }
    return [
        {
            ...source,
            anchor: { fileId: file.fileId, path: file.path, position: { side: 'new' as const, line: 48, size: 1 } },
            root: { ...source.root, body: MARKDOWN_SHOWCASE, replies: [] },
        },
    ];
}

export interface FullDiffGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const FULL_DIFF_STATES: readonly FullDiffGalleryState[] = [
    {
        id: 'full-diff-tree',
        title: 'tree and filters, 21 files',
        render: () => <WorkspaceState fixture="medium" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-large',
        title: '64 files: 8 generated files collapsed throughout, virtualized list',
        render: () => <WorkspaceState fixture="large" preloadModels={false} />,
    },
    {
        id: 'full-diff-pci',
        title: 'PCI DSS filter: chip active',
        render: () => <WorkspaceState fixture="medium" filter="pci" viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-single-file-dir',
        title: 'folder with one file: directory on its own row, long name with tags truncated at the end',
        render: () => (
            <WorkspaceState fixture="medium" paths={SINGLE_FILE_DIR_PATHS} renameTo={SINGLE_FILE_DIR_RENAME} />
        ),
    },
    {
        id: 'full-diff-tree-deep',
        title: 'paths 3 levels deep: filenames are not truncated',
        render: () => <WorkspaceState fixture="medium" paths={DEEP_PATHS} viewed={MEDIUM_VIEWED} />,
    },
    {
        id: 'full-diff-tree-filtered-chains',
        title: 'filter over chains: collapse is calculated from visible children',
        render: () => <WorkspaceState fixture="large" filter="generated" preloadModels={false} />,
    },
    {
        id: 'full-diff-zero',
        title: 'hidden lens from URL falls back to "All"',
        render: () => (
            <WorkspaceState
                fixture="medium"
                filter="pci"
                lenses={{ ownership: fixtureIteration('medium').ownership, extra: [EMPTY_PCI] }}
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
        title: 'human, bot and resolved threads on the same line',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                threads={sourceThreadsOnHandlers()}
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
        title: 'bot thread with 40 replies: all visible at once',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/payments/card-token.ts"
                threads={botThreadWithFortyReplies()}
            />
        ),
    },
    {
        id: 'threads-markdown',
        title: 'markdown display: the entire comment profile at once',
        render: () => (
            <WorkspaceState
                fixture="medium"
                showThreads
                onlyPath="services/orders/src/api/handlers.ts"
                threads={markdownShowcaseThread()}
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
                threads={fixtureIteration('medium').threads.filter((thread) => thread.anchor === null)}
            />
        ),
    },
];
