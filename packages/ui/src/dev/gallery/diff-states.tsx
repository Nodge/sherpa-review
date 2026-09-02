import { fileContentOf, fixtureData, LONG_LINE_FILE_PATH } from '@sherpa/fixtures';
import type { FixtureName } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useMemo, useRef, useState, useSyncExternalStore } from 'react';

import type { DiffGap, DiffHunk } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { toParseRequest } from '../../diff/model.js';
import { lineKey } from '../../diff-view/selection.js';
import { readStateOf } from '../../progress/read-state.js';
import type { Feedback, FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createSessionStore } from '../../session/session-store.js';
import { DiffFileList } from '../../diff-view/file-list.tsx';
import type { ExpandDirection, FileExpansion } from '../../diff-view/expand.js';
import { gapKeyOf, hiddenLinesOf } from '../../diff-view/expand.js';
import type { DiffMode, DiffViewStore } from '../../diff-view/store.js';
import { createDiffViewStore, fileCollapseReason } from '../../diff-view/store.js';
import '../../diff-view/diff-view.css';

/**
 * Diff rendering states for the gallery (visual acceptance layer 2, CLAUDE.md). Everything is derived
 * from fixtures synchronously, without a server, worker or timers, so opening a state produces
 * the same frame on every run.
 */

type ExpansionPreset = 'step' | 'remainder' | 'all';

interface CardStateProps {
    readonly fixture: FixtureName;
    readonly path: string;
    readonly mode?: DiffMode;
    readonly expansion?: ExpansionPreset;
    readonly viewed?: boolean;
    /** Explicit manual choice: true collapses, false expands. */
    readonly collapsed?: boolean;
    /** Generated file: expand by hand → viewed → un-pin, ending up expanded again. */
    readonly restoreAfterUnmark?: boolean;
    /** Selected range: hunk number in the file and lines within it. */
    readonly selection?: { hunk: number; from: number; to: number };
    /** File opened despite the size-based collapse. */
    readonly opened?: boolean;
    /** Card kept on screen despite the filter (SPEC §2.7). */
    readonly keptInView?: boolean;
    /** Initial card hint: shows a write failure that cannot occur without a click. */
    readonly hint?: Feedback;
    readonly gapError?: boolean;
}

const EMPTY_EXPANSION: FileExpansion = new Map();

function fileOf(fixture: FixtureName, path: string): FileDiff {
    const file = fixtureData(fixture).diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture ${fixture} has no file ${path}`);
    }
    return file;
}

function applyExpansionPreset(
    store: DiffViewStore,
    fileId: string,
    model: ReturnType<typeof parseFileDiff>,
    content: FileContent,
    preset: Exclude<ExpansionPreset, 'all'>,
): void {
    const gaps = model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
    const gap = gaps.find((candidate) => {
        const hidden = hiddenLinesOf(candidate, content);
        return preset === 'step' ? hidden === null || hidden >= 20 : hidden !== null && hidden > 7;
    });
    if (gap === undefined) {
        return;
    }
    const direction: ExpandDirection = gap.edge === 'trailing' ? 'down' : 'up';
    const hidden = hiddenLinesOf(gap, content);
    const amount = preset === 'remainder' && hidden !== null ? hidden - 7 : undefined;
    store.expandGap(fileId, gapKeyOf(gap), direction, amount);
}

/** Fixture-backed card: the store is populated immediately, so the first frame is already final. */
function CardState({
    fixture,
    path,
    mode = 'unified',
    expansion,
    viewed,
    collapsed,
    restoreAfterUnmark = false,
    selection,
    opened,
    keptInView = false,
    hint,
    gapError = false,
}: CardStateProps) {
    const data = useMemo(() => fixtureData(fixture), [fixture]);
    const file = useMemo(() => fileOf(fixture, path), [fixture, path]);
    const contentAvailable = data.pr.capabilities.fileContent;

    const store = useMemo(() => {
        const created = createDiffViewStore({
            files: [file],
            ...(collapsed === undefined ? {} : { collapsed: new Map([[file.fileId, collapsed]]) }),
        });
        const model = parseFileDiff(toParseRequest(file));
        const content = contentAvailable ? fileContentOf(file) : null;
        created.setModel(file.fileId, model);
        if (contentAvailable) {
            created.setContent(file.fileId, content);
        }
        created.setDiffMode(mode);
        if (expansion === 'all') {
            created.expandFile(file.fileId);
        } else if (expansion !== undefined && content !== null) {
            applyExpansionPreset(created, file.fileId, model, content, expansion);
        }
        if (restoreAfterUnmark) {
            created.revealFile(file.fileId);
            created.markViewed(file.fileId, true);
            created.revealFile(file.fileId);
            created.markViewed(file.fileId, false);
        } else if (viewed === true) {
            created.markViewed(file.fileId, true);
        }
        if (opened === true) {
            created.openFile(file.fileId);
        }
        if (selection !== undefined) {
            // Lines are addressed by their file line numbers, so the keys come from the model.
            const model = created.getSnapshot().models.get(file.fileId);
            const blocks = model?.content.kind === 'text' ? model.content.blocks : [];
            const hunk = blocks.filter((block): block is DiffHunk => block.kind === 'hunk')[selection.hunk];
            const from = hunk?.lines[selection.from];
            const to = hunk?.lines[selection.to];
            const fromKey = from === undefined ? null : lineKey(from);
            const toKey = to === undefined ? null : lineKey(to);
            if (fromKey === null || toKey === null) {
                throw new Error(`file ${file.path} has no selection lines`);
            }
            created.startSelection(file.fileId, fromKey);
            created.extendSelection(file.fileId, toKey);
        }
        return created;
    }, [collapsed, contentAvailable, expansion, file, mode, opened, restoreAfterUnmark, selection, viewed]);

    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot);
    const actions = useMemo(() => galleryActions(store), [store]);

    return (
        <FileCard
            file={file}
            model={snapshot.models.get(file.fileId) ?? null}
            mode={snapshot.effectiveMode}
            content={snapshot.content.get(file.fileId)}
            contentAvailable={contentAvailable}
            expansion={snapshot.expansion.get(file.fileId) ?? EMPTY_EXPANSION}
            read={snapshot.readState.get(file.fileId) ?? readStateOf({ file, record: null })}
            collapseReason={fileCollapseReason(snapshot, file)}
            onToggleCollapse={() => {
                store.toggleFileCollapse(file.fileId);
            }}
            opened={snapshot.opened.has(file.fileId)}
            showWhitespace={snapshot.whitespaceShown.has(file.fileId)}
            keptInView={keptInView}
            initialHint={hint ?? null}
            initialGapError={gapError}
            selection={snapshot.selection}
            actions={actions}
        />
    );
}

/** Virtualized list on the large fixture: 64 files, parsed as you scroll. */
function ListState({ fixture }: { fixture: FixtureName }) {
    const data = useMemo(() => fixtureData(fixture), [fixture]);
    const store = useMemo(() => createDiffViewStore({ files: data.diff.files }), [data]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

    // The list takes its height from the outer scroller, so the state stage acts as that scroller in the gallery.
    return (
        <div className="gallery__viewport" ref={setScrollElement}>
            <DiffFileList
                scrollElement={scrollElement}
                scrollPaddingStart={0}
                files={data.diff.files}
                store={store}
                contentAvailable={data.pr.capabilities.fileContent}
                // The parser is synchronous: the gallery needs no worker and the frame does not depend on one.
                parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
                loadContent={(fileId) => {
                    const file = data.diff.files.find((candidate) => candidate.fileId === fileId);
                    return Promise.resolve(file === undefined ? null : fileContentOf(file));
                }}
                session={session}
                onViewed={(fileId, viewed) => {
                    store.markViewed(fileId, viewed);
                    return Promise.resolve(null);
                }}
            />
        </div>
    );
}

/** Parse failure: the first "worker" attempt fails, retrying with the button succeeds. */
function ParseErrorState({ fixture, path }: { fixture: FixtureName; path: string }) {
    const file = useMemo(() => fileOf(fixture, path), [fixture, path]);
    const store = useMemo(() => createDiffViewStore({ files: [file] }), [file]);
    const session = useMemo(() => createSessionStore({ initial: { view: 'diff', filter: 'all' } }), []);
    const failed = useRef(new Set<string>());
    const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null);

    return (
        <div className="gallery__viewport" ref={setScrollElement}>
            <DiffFileList
                scrollElement={scrollElement}
                scrollPaddingStart={0}
                files={[file]}
                store={store}
                contentAvailable={false}
                parse={(candidate) => {
                    if (failed.current.has(candidate.fileId)) {
                        return Promise.resolve(parseFileDiff(toParseRequest(candidate)));
                    }
                    failed.current.add(candidate.fileId);
                    return Promise.reject(new Error('worker did not respond'));
                }}
                loadContent={() => Promise.resolve(null)}
                session={session}
                onViewed={(fileId, viewed) => {
                    store.markViewed(fileId, viewed);
                    return Promise.resolve(null);
                }}
            />
        </div>
    );
}

function galleryActions(store: DiffViewStore): FileCardActions {
    return {
        onViewed: (fileId, viewed) => {
            store.markViewed(fileId, viewed);
            return Promise.resolve(null);
        },
        onExpand: (fileId, request) => {
            if (request.kind === 'file') {
                store.expandFile(fileId, request.gapKeys);
            } else {
                store.expandGap(fileId, request.gapKey, request.direction, request.amount);
            }
            const snapshot = store.getSnapshot();
            return Promise.resolve({
                feedback: null,
                content: snapshot.content.get(fileId) ?? null,
                expansion: snapshot.expansion.get(fileId) ?? new Map(),
            });
        },
        onRetryParse: () => {
            // Gallery parsing is synchronous and does not fail, so there is nothing to retry.
        },
        onOpenFile: store.openFile,
        onShowWhitespace: store.showWhitespace,
        onSelectStart: (fileId, key, side, extend) => {
            if (extend) {
                store.extendSelection(fileId, key, side);
            } else {
                store.startSelection(fileId, key, side);
            }
        },
        onSelectExtend: store.extendSelection,
    };
}

const EDIT_WINDOW = 'services/orders/src/domain/edit-window.ts';
const ORDER = 'services/orders/src/domain/order.ts';
const HANDLERS = 'services/orders/src/api/handlers.ts';
const CARD_TOKEN = 'services/orders/src/payments/card-token.ts';

export interface DiffGalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const DIFF_STATES: readonly DiffGalleryState[] = [
    {
        id: 'diff-unified',
        title: 'card, unified',
        render: () => <CardState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-split',
        title: 'card, side by side',
        render: () => <CardState fixture="medium" path={ORDER} mode="split" />,
    },
    {
        id: 'diff-long-lines',
        title: 'long URLs, minified code and tabs wrap',
        render: () => <CardState fixture="large" path={LONG_LINE_FILE_PATH} />,
    },
    {
        id: 'diff-long-lines-split',
        title: 'long lines side by side, paired halves have equal height',
        render: () => <CardState fixture="large" path={LONG_LINE_FILE_PATH} mode="split" />,
    },
    {
        id: 'diff-split-one-sided',
        title: 'side by side: one-sided file at full width',
        render: () => <CardState fixture="medium" path={EDIT_WINDOW} mode="split" />,
    },
    {
        id: 'diff-selection',
        title: 'selected range',
        render: () => (
            <CardState fixture="medium" path={HANDLERS} selection={{ hunk: 1, from: 2, to: 6 }} />
        ),
    },
    {
        id: 'diff-selection-split',
        title: 'selected range, side by side',
        render: () => (
            <CardState
                fixture="medium"
                path={HANDLERS}
                mode="split"
                selection={{ hunk: 1, from: 2, to: 6 }}
            />
        ),
    },
    {
        id: 'diff-viewed',
        title: 'collapsed by the "Viewed" mark',
        render: () => <CardState fixture="medium" path={ORDER} viewed />,
    },
    {
        id: 'diff-collapsed-manual',
        title: 'collapsed by hand with a click on the header',
        render: () => <CardState fixture="medium" path={ORDER} collapsed />,
    },
    {
        id: 'diff-collapsed-generated',
        title: 'generated file collapsed by default',
        render: () => <CardState fixture="medium" path="services/orders/src/payments/generated/psp-schema.ts" />,
    },
    {
        id: 'diff-unmark-restores-expansion',
        title: 'clearing the mark restored the previous expanded state of the generated file',
        render: () => (
            <CardState
                fixture="medium"
                path="services/orders/src/payments/generated/psp-schema.ts"
                restoreAfterUnmark
            />
        ),
    },
    {
        id: 'diff-expand',
        title: 'context expanded by 20 lines',
        render: () => <CardState fixture="medium" path={ORDER} expansion="step" />,
    },
    {
        id: 'diff-expand-all',
        title: 'context fully expanded',
        render: () => <CardState fixture="medium" path={ORDER} expansion="all" />,
    },
    {
        id: 'diff-gap-idle',
        title: 'context gap: rest',
        render: () => <CardState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-gap-remainder',
        title: 'context gap: fewer than 20 lines remain',
        render: () => <CardState fixture="medium" path={ORDER} expansion="remainder" />,
    },
    {
        id: 'diff-gap-error',
        title: 'context gap: loading error',
        render: () => <CardState fixture="medium" path={ORDER} gapError />,
    },
    {
        id: 'diff-gap-directional',
        // handlers.ts gaps: an internal 34-line gap gives ↑ and ↓, a 16-line gap gives one ↕, a trailing 30-line gap gives ↓.
        title: 'context gap: directional targets ↑/↓ for gaps of at least 20 lines',
        render: () => <CardState fixture="medium" path={HANDLERS} />,
    },
    {
        id: 'diff-gap-leading',
        // The first card-token.ts hunk starts at line 44: expansion is only possible upwards.
        title: 'context gap: leading gap of at least 20 lines, only ↑',
        render: () => <CardState fixture="medium" path={CARD_TOKEN} />,
    },
    {
        id: 'diff-expand-unavailable',
        title: 'context unavailable: host does not provide content',
        render: () => <CardState fixture="edge" path="services/orders/src/domain/order.ts" />,
    },
    {
        id: 'diff-rename',
        title: 'rename',
        render: () => <CardState fixture="edge" path="services/orders/src/infra/time/clock.ts" />,
    },
    {
        id: 'diff-delete',
        title: 'deleted file',
        render: () => <CardState fixture="edge" path="services/orders/src/legacy/edit-window-v1.ts" />,
    },
    {
        id: 'diff-binary',
        title: 'binary file',
        render: () => <CardState fixture="edge" path="services/orders/assets/edit-window-flow.png" />,
    },
    {
        id: 'diff-whitespace',
        title: 'whitespace only',
        render: () => <CardState fixture="edge" path="services/orders/src/api/schemas.ts" />,
    },
    {
        id: 'diff-mode-change',
        title: 'file mode change',
        render: () => <CardState fixture="edge" path="services/orders/scripts/rollout.sh" />,
    },
    {
        id: 'diff-collapsed',
        title: 'file above the collapse threshold',
        render: () => (
            <CardState fixture="edge" path="services/orders/src/payments/generated/psp-client.ts" collapsed={false} />
        ),
    },
    {
        id: 'diff-collapsed-open',
        title: 'file above the collapse threshold, opened by hand',
        render: () => (
            <CardState
                fixture="edge"
                path="services/orders/src/payments/generated/psp-client.ts"
                collapsed={false}
                opened
            />
        ),
    },
    {
        id: 'diff-parse-error',
        title: 'diff parsing failed, retry available',
        render: () => <ParseErrorState fixture="medium" path={ORDER} />,
    },
    {
        id: 'diff-kept-in-view',
        title: 'kept on screen: card outside the current filter',
        render: () => <CardState fixture="medium" path={ORDER} keptInView />,
    },
    {
        id: 'diff-viewed-not-saved',
        title: 'viewed mark not saved: control rolls back and offers retry',
        render: () => (
            // A write failure cannot occur without a click, so the card receives the hint as its initial state.
            <CardState
                fixture="medium"
                path={ORDER}
                hint={{ text: 'not saved', retry: () => Promise.resolve(null) }}
            />
        ),
    },
    {
        id: 'diff-list-large',
        title: 'virtualized list, 64 files, generated files collapsed',
        render: () => <ListState fixture="large" />,
    },
];
