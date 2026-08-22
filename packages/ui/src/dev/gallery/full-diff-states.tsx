import { fileContentOf, fixtureData } from '@sherpa/fixtures';
import type { FixtureName } from '@sherpa/fixtures';
import type { FileDiff, Lens, UiFileProgress, UiReviewLensesResponse } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { createDiffViewStore } from '../../diff-view/store.js';
import { changedLinesOf } from '../../progress/read-state.js';
import { createSessionStore } from '../../session/session-store.js';
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
}

function WorkspaceState({
    fixture,
    filter = 'all',
    lenses,
    viewed = [],
    records = [],
    preloadModels = true,
    onlyPath,
}: WorkspaceStateProps) {
    const data = useMemo(() => {
        const source = fixtureData(fixture);
        if (onlyPath === undefined) {
            return source;
        }
        return { ...source, diff: { ...source.diff, files: source.diff.files.filter((file) => file.path === onlyPath) } };
    }, [fixture, onlyPath]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter } }), [filter]);

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
                lenses={lenses ?? { ownership: data.ownership, extra: data.extraLenses }}
                prKey={`fixture-${fixture}`}
                session={session}
                store={store}
                collapsedStorage={null}
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
];
