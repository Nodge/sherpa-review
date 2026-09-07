import type { ReactNode } from 'react';
import { useMemo } from 'react';

import type { QuestionRange } from '../../components/chat-prompts.js';
import { placeRangesQuestion } from '../../components/chat-prompts.js';
import { useT } from '../../i18n/index.js';
import type { RouteFileGroup, RouteOtherView } from '../../route/route-model.js';
import { filterOtherView, uncoveredAsGroup } from '../../route/route-model.js';
import { OtherCard } from './other-card.tsx';

/**
 * "Other" entry: ranges outside the route, collapsed into one expandable card (README §2).
 * Counts and the question to the agent use the same set that expands under the filter.
 */

export function OtherSection({
    view,
    stopCount,
    pending,
    parseFailed,
    filling,
    failedFiles,
    onRetryFailed,
    agentConnected,
    onComposeQuestion,
    opened,
    fileIds,
    keptInView,
    viewed,
    marked,
    failedViewed,
    flash,
    onViewed,
    onOpen,
    renderCard,
}: {
    view: RouteOtherView;
    stopCount: number;
    pending: boolean;
    /** Some diff files failed to parse, so their uncovered ranges have not been counted. */
    parseFailed: boolean;
    /** The route is still filling: Other counts vacant plan slots, not what the model left over. */
    filling: boolean;
    failedFiles: number;
    onRetryFailed: () => void;
    agentConnected: boolean;
    /** Without it, the card has no chat entry point. A button leading nowhere would mislead. */
    onComposeQuestion?: (text: string) => void;
    opened: boolean;
    /** null means show all uncovered ranges (no filter or the card is kept in view). */
    fileIds: ReadonlySet<string> | null;
    keptInView: boolean;
    viewed: boolean;
    marked: boolean;
    failedViewed: boolean | null;
    flash: boolean;
    onViewed: (viewed: boolean) => void;
    onOpen: () => void;
    renderCard: (stopId: string, group: RouteFileGroup) => ReactNode;
}) {
    const t = useT();
    // The card counts the same set that expands. Otherwise the button would promise all lines
    // and show only the subset that passes the filter.
    const filtered = useMemo(() => filterOtherView(view, fileIds), [fileIds, view]);
    const groups = useMemo(() => filtered.files.map((file) => uncoveredAsGroup(file)), [filtered.files]);
    // The question lists exactly what the reviewer sees: the filter narrows the card, so it must not
    // promise the agent ranges that are absent from the screen.
    const askToPlace = useMemo(
        () =>
            onComposeQuestion === undefined
                ? undefined
                : () => {
                      onComposeQuestion(placeRangesQuestion(otherQuestionRanges(filtered), t));
                  },
        [filtered, onComposeQuestion, t],
    );

    return (
        <div data-stop={view.stop.id}>
            <OtherCard
                view={filtered}
                stopCount={stopCount}
                pending={pending}
                parseFailed={parseFailed}
                filling={filling}
                failedFiles={failedFiles}
                onRetryFailed={onRetryFailed}
                agentConnected={agentConnected}
                {...(askToPlace === undefined ? {} : { onAskToPlace: askToPlace })}
                keptInView={keptInView}
                viewed={viewed}
                marked={marked}
                failedViewed={failedViewed}
                flash={flash}
                onViewed={onViewed}
                opened={opened}
                onOpen={onOpen}
                diff={groups.map((group) => renderCard(view.stop.id, group))}
            />
        </div>
    );
}

/** Other's uncovered ranges for the question text, in the view's file and anchor order. */
function otherQuestionRanges(view: RouteOtherView): readonly QuestionRange[] {
    return view.files.flatMap((file) =>
        file.anchors.map((anchor) => ({
            path: file.path,
            side: anchor.side,
            start: anchor.start,
            end: anchor.end,
        })),
    );
}
