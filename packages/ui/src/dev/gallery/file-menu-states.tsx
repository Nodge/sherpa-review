import { fixtureIteration, GALLERY_HOSTS } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { ReviewHostProvider } from '../../app/review-host-context.tsx';
import type { ContextMenuAnchor } from '../../components/context-menu.tsx';
import { FileContextMenu } from '../../components/context-menu.tsx';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { FileCardActions } from '../../diff-view/file-card.tsx';
import { FileCard } from '../../diff-view/file-card.tsx';
import { buildFileFilters, selectFilter } from '../../filters/lens-filters.js';
import { useT } from '../../i18n/index.js';
import { ReadOnlyIterationProvider } from '../../iterations/read-only.tsx';
import { readStateOf } from '../../progress/read-state.js';
import { FilePanel } from '../../tree/file-panel.tsx';

/**
 * File context menu (docs/design/SPEC-elements.md §2.11) at both invocation points. The gallery menu is open
 * immediately. Its state is controlled, with no keyboard input or clicks: `useEscapeLayer` outside the registry
 * provider registers nothing, so the frame stays deterministic.
 */

const MEDIUM = fixtureIteration('medium');

const FILE: FileDiff = (() => {
    const file = MEDIUM.diff.files.find((candidate) => candidate.blameUrl !== null && candidate.hostFileUrl !== null);
    if (file === undefined) {
        throw new Error('fixture medium needs a file with both host links');
    }
    return file;
})();

/** Host without a file web link: "Copy link" stays in the menu but is disabled. */
const NO_LINK: FileDiff = { ...FILE, hostFileUrl: null, blameUrl: null };

const CARD_ANCHOR: ContextMenuAnchor = { x: 900, y: 190, align: 'right' };
const TREE_ANCHOR: ContextMenuAnchor = { x: 330, y: 230, align: 'left' };

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onToggleMarkdown: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

/** Menu from the header of a viewed file card: all 4 items are available. */
function CardMenu() {
    return (
        <ReviewHostProvider value={GALLERY_HOSTS.github}>
            <FileCard
                file={FILE}
                model={parseFileDiff(toParseRequest(FILE))}
                mode="unified"
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file: { ...FILE, viewed: true }, record: null })}
                opened
                showWhitespace={false}
                markdown={false}
                selection={null}
                actions={ACTIONS}
            />
            <FileContextMenu
                file={FILE}
                viewed
                onToggleViewed={() => undefined}
                anchor={CARD_ANCHOR}
                onClose={() => undefined}
            />
        </ReviewHostProvider>
    );
}

function Tree({ activeFileId }: { activeFileId: string }) {
    const t = useT();
    const files = MEDIUM.diff.files;
    const filters = buildFileFilters({ files, ownership: MEDIUM.ownership, extra: MEDIUM.extraLenses, t });
    return (
        <div className="gallery__viewport">
            <FilePanel
                files={files}
                filters={filters}
                activeFilter={selectFilter(filters, 'all')}
                onFilter={() => undefined}
                auditFilter={null}
                mineFileIds={new Set()}
                readState={new Map()}
                route={null}
                activeFileId={activeFileId}
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={null}
                onOpenHunk={() => undefined}
            />
        </div>
    );
}

/** Menu from a tree row for a file with no links from the host. */
function TreeMenu() {
    return (
        <ReviewHostProvider value={GALLERY_HOSTS.github}>
            <Tree activeFileId={NO_LINK.fileId} />
            <FileContextMenu
                file={NO_LINK}
                viewed={false}
                onToggleViewed={() => undefined}
                anchor={TREE_ANCHOR}
                onClose={() => undefined}
            />
        </ReviewHostProvider>
    );
}

/** Previous iteration: marking viewed is unavailable, the menu item is disabled with a reason. */
function ReadOnlyMenu() {
    return (
        <ReadOnlyIterationProvider readOnly>
            <Tree activeFileId={FILE.fileId} />
            <FileContextMenu
                file={FILE}
                viewed={false}
                onToggleViewed={() => undefined}
                anchor={TREE_ANCHOR}
                onClose={() => undefined}
            />
        </ReadOnlyIterationProvider>
    );
}

export const FILE_MENU_STATES: readonly {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}[] = [
    {
        id: 'file-menu-card',
        title: 'menu from the card header: all items available',
        render: () => <CardMenu />,
    },
    {
        id: 'file-menu-tree',
        title: 'menu from the tree: file without host links',
        render: () => <TreeMenu />,
    },
    {
        id: 'file-menu-read-only',
        title: 'menu in a previous iteration: viewed mark disabled',
        render: () => <ReadOnlyMenu />,
    },
];
