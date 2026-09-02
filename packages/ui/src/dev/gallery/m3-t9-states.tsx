import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiChatAskAnchor } from '@sherpa/protocol';

import type { DiffFileModel } from '../../diff/model.js';
import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import type { AnchorSpan } from '../../route/anchor-clip.js';
import type { MarginStripActions } from '../../route/route-margin.tsx';
import { useMarginStrips } from '../../route/route-margin.tsx';
import type { RouteOtherView } from '../../route/route-model.js';
import { buildRouteModel } from '../../route/route-model.js';
import { OtherCard } from '../../views/route/other-card.tsx';
import type { RouteGalleryState } from './m2-t6-states.tsx';

/**
 * Ask AI entry points (M3-T9): the "place" button in "Other" and the hatched Full diff strip,
 * both with and without a connected agent. Clickable empty chat examples live
 * in the `chat-empty` state (M3-T6): the panel renders them itself.
 */

const DATA = fixtureIteration('medium');

function readySnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
}

const MODELS = new Map<string, DiffFileModel>(
    DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]),
);

function otherView(): RouteOtherView {
    const model = buildRouteModel({ snapshot: readySnapshot(), files: DATA.diff.files, models: MODELS });
    const entry = model.entries.find((candidate) => candidate.kind === 'other');
    if (entry === undefined) {
        throw new Error('fixture completed route has no Other stop');
    }
    return entry.view;
}

function OtherAskState({ agentConnected }: { readonly agentConnected: boolean }) {
    return (
        <div className="gallery__viewport">
            <OtherCard
                view={otherView()}
                stopCount={7}
                opened={false}
                onOpen={() => undefined}
                diff={null}
                pending={false}
                agentConnected={agentConnected}
                onAskToPlace={() => undefined}
            />
        </div>
    );
}

const STRIP_FILE: { readonly fileId: string; readonly path: string } = (() => {
    const file = DATA.diff.files[0];
    if (file === undefined) {
        throw new Error('medium fixture needs at least one file');
    }
    return { fileId: file.fileId, path: file.path };
})();
const STRIP_MODEL = MODELS.get(STRIP_FILE.fileId) ?? null;
const STRIP_SPAN: AnchorSpan = (() => {
    const blocks = STRIP_MODEL?.content.kind === 'text' ? STRIP_MODEL.content.blocks : [];
    for (const block of blocks) {
        if (block.kind !== 'hunk') {
            continue;
        }
        for (const line of block.lines) {
            if (line.kind === 'add' && line.newLine !== null) {
                return { side: 'new', start: line.newLine, end: line.newLine };
            }
        }
    }
    throw new Error('fixture first file has no added lines');
})();

function StripState({ actions }: { readonly actions: MarginStripActions }) {
    const strips = useMarginStrips({
        model: STRIP_MODEL,
        rowsShown: true,
        ranges: [STRIP_SPAN],
        file: STRIP_FILE,
        actions,
    });

    return <div className="gallery__viewport">{strips.renderAfterLine(STRIP_SPAN.side, STRIP_SPAN.end)}</div>;
}

const NOT_PENDING = (_anchor: UiChatAskAnchor): boolean => false;
const PENDING = (_anchor: UiChatAskAnchor): boolean => true;

export const M3_T9_ROUTE_STATES: readonly RouteGalleryState[] = [
    {
        id: 'route-other-ask',
        title: 'Other: ask the agent to place the ranges',
        render: () => <OtherAskState agentConnected />,
    },
    {
        id: 'route-other-ask-offline',
        title: 'Other: agent disconnected, entry point is disabled',
        render: () => <OtherAskState agentConnected={false} />,
    },
];

export const M3_T9_DIFF_STATES: readonly RouteGalleryState[] = [
    {
        id: 'full-diff-strip-ask',
        title: 'hatched strip: ask the agent to place the ranges',
        render: () => (
            <StripState
                actions={{ agentConnected: true, isPending: NOT_PENDING, onAskToPlace: () => undefined }}
            />
        ),
    },
    {
        id: 'full-diff-strip-asked',
        title: 'hatched strip: question in flight',
        render: () => (
            <StripState actions={{ agentConnected: true, isPending: PENDING, onAskToPlace: () => undefined }} />
        ),
    },
    {
        id: 'full-diff-strip-offline',
        title: 'hatched strip: agent disconnected',
        render: () => (
            <StripState
                actions={{ agentConnected: false, isPending: NOT_PENDING, onAskToPlace: () => undefined }}
            />
        ),
    },
];
