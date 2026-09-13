import type { UiChatAskAnchor } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { useCallback, useMemo } from 'react';

import { ASK_ANSWER_IN_CHAT_NOTE, ASK_RANGES_DISABLED_TITLE } from '../components/chat-prompts.js';
import type { DiffFileModel } from '../diff/model.js';
import { useT } from '../i18n/index.js';
import { modelHasPosition } from '../threads/card-threads.tsx';
import type { AnchorSpan } from './anchor-clip.js';
import type { RouteMarginFile } from './margin-model.js';
import {
    marginBadgeLabel,
    marginBadgeShown,
    marginBadgeTitle,
    marginStripSummary,
    marginStripText,
    marginTargetStopId,
    treeBadgeAria,
    treeBadgeLabel,
} from './margin-model.js';
import './route-margin.css';

/**
 * Route in full diff margins (docs/design/README.md §10, docs/product.md §3, principle 5): a stop badge in the tree row
 * and card header, a hatched strip below each uncovered range. The same AI layer that sets
 * the order in the route tab here only answers "which stop explains this", without changing the order.
 *
 * Shared components for the tree and cards: the same appearance in different sizes (docs/design/README.md §10).
 */

export interface RouteBadgeProps {
    readonly file: RouteMarginFile;
    /** Hatch click target: Other, where these lines are read. */
    readonly otherStopId: string | null;
    readonly variant: 'tree' | 'card';
    /** Without a handler, the badge stays a label. A button that goes nowhere would mislead. */
    readonly onJump?: ((stopId: string) => void) | undefined;
}

export function RouteBadge({ file, otherStopId, variant, onJump }: RouteBadgeProps) {
    const t = useT();
    if (!marginBadgeShown(file)) {
        return null;
    }
    const target = marginTargetStopId(file, otherStopId);
    const jump = target === null ? undefined : onJump;
    const title = marginBadgeTitle(file, jump !== undefined, t);
    const label = variant === 'tree' ? treeBadgeLabel(file) : marginBadgeLabel(file, t);
    // The hatch adds more than color. In a card header, the badge also spells out its meaning,
    // while the tree's 17×13 marker has no room for text and relies on the hatch and tooltip.
    const className = `route-badge route-badge--${variant}${file.stops.length === 0 ? ' route-badge--hatched' : ''}`;

    if (jump === undefined || target === null) {
        return (
            <span className={className} title={title}>
                {label}
            </span>
        );
    }
    return (
        <button
            type="button"
            className={className}
            title={title}
            // The tree marker's accessible label is deliberately short. It is the row's first child,
            // so a long stop title would be read before the filename.
            aria-label={variant === 'tree' ? treeBadgeAria(file, true, t) : title}
            // The tree badge adds no tab stop. Rows use the tree's roving cursor
            // (docs/design/SPEC-elements.md §2.20), which an extra tab stop would disrupt.
            tabIndex={variant === 'tree' ? -1 : undefined}
            onClick={(event) => {
                // Clicking the badge navigates to the stop instead of opening the file through the tree row.
                event.stopPropagation();
                jump(target);
            }}
        >
            {label}
        </button>
    );
}

export interface MarginStrips {
    /** Ranges whose last line is absent from the card: one summary strip below the header. */
    readonly underHeader: ReactNode;
    readonly renderAfterLine: (side: 'old' | 'new', line: number) => ReactNode;
}

/**
 * "Ask the agent to place the range" action on a hatched strip (docs/design/README.md §10).
 * This sends a chat question without regenerating or changing the route.
 */
export interface MarginStripActions {
    /** A disconnected agent disables the action, as in the popover (docs/design/SPEC-elements.md §2.15). */
    readonly agentConnected: boolean;
    /** A question about this range is queued or running. An "asked" chip replaces the button. */
    readonly isPending: (anchor: UiChatAskAnchor) => boolean;
    readonly onAskToPlace: (anchor: UiChatAskAnchor) => void;
}

export interface MarginStripsInput {
    /** The model actually rendered in the card. */
    readonly model: DiffFileModel | null;
    /** Diff lines are rendered. A collapsed card cannot place a strip below a line. */
    readonly rowsShown: boolean;
    readonly ranges: readonly AnchorSpan[];
    /** The file containing the ranges. Without it, the question has no anchor and the strip remains a label. */
    readonly file?: { readonly fileId: string; readonly path: string } | null;
    readonly actions?: MarginStripActions | null;
}

/**
 * "No route stop" strips below uncovered ranges. A range whose last line
 * is not rendered (card collapsed by size, "whitespace only", patch failed to parse) does not disappear
 * silently. These ranges share a summary below the header (docs/product.md §3, principle 3).
 */
export function useMarginStrips({
    model,
    rowsShown,
    ranges,
    file = null,
    actions = null,
}: MarginStripsInput): MarginStrips {
    const t = useT();
    const layout = useMemo(() => {
        const byLine = new Map<string, AnchorSpan>();
        const orphans: AnchorSpan[] = [];
        for (const span of ranges) {
            if (rowsShown && modelHasPosition(model, span.side, span.end)) {
                byLine.set(lineKey(span.side, span.end), span);
            } else {
                orphans.push(span);
            }
        }
        return { byLine, orphans };
    }, [model, ranges, rowsShown]);

    const renderAfterLine = useCallback(
        (side: 'old' | 'new', line: number): ReactNode => {
            const span = layout.byLine.get(lineKey(side, line));
            if (span === undefined) {
                return null;
            }
            const anchor = file === null ? null : { fileId: file.fileId, path: file.path, ...span };
            return (
                <RouteStrip
                    text={marginStripText(span, t)}
                    {...(anchor === null || actions === null ? {} : { anchor, actions })}
                />
            );
        },
        [actions, file, layout.byLine, t],
    );

    // The header summary combines multiple ranges, but a question has one anchor, so there is no button here.
    // References stay stable. The card is memoized, and a new node on each render would defeat memo.
    const underHeader = useMemo(
        () => (layout.orphans.length === 0 ? null : <RouteStrip text={marginStripSummary(layout.orphans, t)} />),
        [layout.orphans, t],
    );

    return useMemo(() => ({ underHeader, renderAfterLine }), [renderAfterLine, underHeader]);
}

function RouteStrip({
    text,
    anchor,
    actions,
}: {
    readonly text: string;
    readonly anchor?: UiChatAskAnchor;
    readonly actions?: MarginStripActions;
}) {
    const t = useT();
    return (
        <div className="route-strip">
            <span className="route-strip__text">{text}</span>
            {anchor === undefined || actions === undefined ? null : actions.isPending(anchor) ? (
                <span className="route-strip__chip" role="status">
                    {t('margin.ask.asked')}
                </span>
            ) : (
                <button
                    type="button"
                    className="route-strip__action"
                    disabled={!actions.agentConnected}
                    title={t(actions.agentConnected ? ASK_ANSWER_IN_CHAT_NOTE : ASK_RANGES_DISABLED_TITLE)}
                    onClick={() => {
                        actions.onAskToPlace(anchor);
                    }}
                >
                    {t('margin.ask.place')}
                </button>
            )}
        </div>
    );
}

function lineKey(side: 'old' | 'new', line: number): string {
    return `${side}:${String(line)}`;
}
