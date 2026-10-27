import type { ReactNode } from 'react';

import type { Translate } from '../../i18n/index.js';
import { useT } from '../../i18n/index.js';
import { stripInlineCode } from '@sherpa/protocol/markdown';
import { Markdown } from '../../markdown/markdown.tsx';
import type { RouteOtherView } from '../../route/route-model.js';
import { StopViewedToggle } from './stop-card.tsx';

/**
 * "Other: the model did not place these lines" (docs/design/README.md §2): a hatched card with accurate
 * copy and a single action to expand uncovered ranges as a raw diff.
 *
 * The UI calculates its contents: all changed lines minus the union of all stop
 * anchors. The snapshot does not and cannot contain it (route contract invariant).
 */

export interface OtherCardProps {
    /** The view is already narrowed by the current filter. Counts must match what expands. */
    readonly view: RouteOtherView;
    readonly stopCount: number;
    readonly opened: boolean;
    readonly onOpen: () => void;
    /** Expanded cards for uncovered ranges, assembled by the view. */
    readonly diff: ReactNode;
    /** Uncovered ranges are still being counted because some diff files have not been parsed. */
    readonly pending: boolean;
    /** Some files failed to parse, so their uncovered ranges are missing and Other cannot be marked. */
    readonly parseFailed?: boolean;
    /**
     * The route is still filling (docs/design/README.md §8): uncovered ranges currently represent vacant plan slots,
     * rather than the model's decision. Counts become accurate once the stops arrive.
     */
    readonly filling?: boolean;
    /** Files that failed to parse. Their uncovered lines are absent from the count. */
    readonly failedFiles?: number;
    readonly onRetryFailed?: () => void;
    /**
     * "Ask the agent to place them" (docs/design/README.md §2) inserts a question listing the ranges
     * into the chat. The button leaves the route unchanged. Regeneration is separate (docs/design/SPEC-elements.md §4.3).
     * undefined means no entry point (chat is unavailable).
     */
    readonly onAskToPlace?: () => void;
    /** Disconnected agent: disable the chat entry point as in the popover (docs/design/SPEC-elements.md §2.15). */
    readonly agentConnected?: boolean;
    /** Card kept on screen despite the filter (docs/design/SPEC-elements.md §2.7). */
    readonly keptInView?: boolean;
    /**
     * Other is a route stop too: marking it writes uncovered ranges into progress
     * (docs/design/README.md §13 «Other read as raw diff»).
     */
    readonly viewed?: boolean;
    readonly onViewed?: (viewed: boolean) => void;
    readonly failedViewed?: boolean | null;
    /** Accent line flash after navigating to Other. */
    readonly flash?: boolean;
    /** Highlight on hover over the coverage strip's hatched segment (docs/design/SPEC-elements.md §2.4). */
    readonly marked?: boolean;
}

export function OtherCard({
    view,
    stopCount,
    opened,
    onOpen,
    diff,
    pending,
    parseFailed = false,
    filling = false,
    failedFiles = 0,
    onRetryFailed,
    onAskToPlace,
    agentConnected = false,
    keptInView = false,
    viewed = false,
    onViewed,
    failedViewed = null,
    flash = false,
    marked = false,
}: OtherCardProps) {
    const t = useT();
    const { lines } = view;
    const files = view.files.length;
    // Only conflicts occupy the slot: there are no uncovered ranges to read or place. The card
    // describes only conflicts, without "0 lines in 0 files" or enabled buttons acting on nothing.
    const conflictsOnly = !filling && !pending && files === 0 && view.conflictFiles > 0;

    return (
        <section
            className={`route-stop route-stop--other${viewed ? ' is-viewed' : ''}${marked ? ' is-marked' : ''}`}
            id={`stop-${view.stop.id}`}
            role="region"
            aria-label={t('route.stop.aria', view.planLabel, stopCount, stripInlineCode(view.stop.title))}
        >
            <div className="route-stop__side">
                <div className="route-stop__head">
                    <span className="route-stop__rule route-stop__rule--other" aria-hidden="true" />
                    <span className="route-stop__number">
                        {view.planLabel} / {String(stopCount)}
                    </span>
                    <span className="route-stop__spacer" />
                    {onViewed === undefined ? null : (
                        <StopViewedToggle
                            viewed={viewed}
                            pending={pending}
                            parseFailed={parseFailed}
                            unfilled={filling}
                            failedViewed={failedViewed}
                            onViewed={onViewed}
                        />
                    )}
                </div>
                <h2 className="route-stop__title">
                    <Markdown text={view.stop.title} profile="route" />
                </h2>
                {filling ? (
                    <p className="route-stop__paragraph">{t('route.other.filling')}</p>
                ) : pending ? (
                    <p className="route-stop__paragraph">{t('route.other.pending')}</p>
                ) : conflictsOnly ? (
                    <p className="route-stop__paragraph">{t('route.other.none')}</p>
                ) : (
                    <p className="route-stop__paragraph">{t('route.other.counted', lines, files)}</p>
                )}
                {keptInView ? <p className="route-stop__kept">{t('route.stop.kept')}</p> : null}
            </div>

            <div className="route-stop__diff">
                {flash ? <div className="route-stop__flash" aria-hidden="true" /> : null}
                <div className="route-other">
                    <p className="route-other__text">
                        {filling ? (
                            t('route.other.fillingNote')
                        ) : conflictsOnly ? (
                            t('route.other.conflictsOnly')
                        ) : (
                            <>
                                {t('route.other.text.lead')}
                                <strong>{t('route.other.text.notExplained')}</strong>
                                {t('route.other.text.between')}
                                <strong>{t('route.other.text.notImportant')}</strong>
                                {t('route.other.text.tail')}
                            </>
                        )}
                    </p>
                    {conflictsOnly ? null : (
                        <div className="route-other__actions">
                            <button
                                type="button"
                                className="ctl ctl--secondary route-other__action"
                                disabled={pending || filling}
                                onClick={onOpen}
                            >
                                {filling
                                    ? t('route.other.waitFilling')
                                    : pending
                                      ? t('route.other.counting')
                                      : opened
                                        ? t('route.other.collapse')
                                        : t('route.other.open', lines)}
                            </button>
                            {onAskToPlace === undefined ? null : (
                                <button
                                    type="button"
                                    className="ctl ctl--ghost ctl--topbar route-other__action route-other__action--secondary"
                                    disabled={pending || filling || !agentConnected}
                                    title={askToPlaceTitle(t, { pending, filling, agentConnected })}
                                    onClick={onAskToPlace}
                                >
                                    {t('route.other.ask')}
                                </button>
                            )}
                        </div>
                    )}
                    {conflictsOnly || onAskToPlace === undefined ? null : (
                        <p className="route-other__honest">{t('chat.ask.answerInChat')}</p>
                    )}
                    {/* Conflicts are outside coverage (docs/design/SPEC-elements.md §4.1): they cannot be explained or read
                        here. The reviewer's only valid action is in the host. */}
                    {view.conflictFiles === 0 ? null : (
                        <p className="route-other__conflicts" role="status">
                            {t('route.other.conflicts', view.conflictFiles)}
                        </p>
                    )}
                    {failedFiles === 0 ? null : (
                        <p className="route-other__failed" role="status">
                            {t('route.other.failedFiles', failedFiles)}
                            {onRetryFailed === undefined ? null : (
                                <button type="button" className="ctl ctl--link-muted" onClick={onRetryFailed}>
                                    {t('route.other.retryParse')}
                                </button>
                            )}
                        </p>
                    )}
                </div>
                {opened ? diff : null}
            </div>
        </section>
    );
}

/**
 * Why the "place" button is unavailable. An unfinished range count takes priority over agent status:
 * until the counts are final, there is nothing to list in the question.
 */
function askToPlaceTitle(
    t: Translate,
    {
        pending,
        filling,
        agentConnected,
    }: {
        pending: boolean;
        filling: boolean;
        agentConnected: boolean;
    },
): string {
    if (filling) {
        return t('route.other.waitFilling');
    }
    if (pending) {
        return t('route.other.counting');
    }
    return agentConnected ? t('chat.ask.answerInChat') : t('chat.ask.rangesDisabled');
}

/** Banner from docs/design/SPEC-elements.md §4.3: the plan explains less than half the diff. */
export function RegenerateBanner({ onGenerate }: { readonly onGenerate?: () => void }) {
    const t = useT();
    return (
        <div className="route-regenerate" role="status">
            <span className="route-regenerate__dot" aria-hidden="true" />
            <span className="route-regenerate__text">{t('route.regenerate.hint')}</span>
            {onGenerate === undefined ? null : (
                <button type="button" className="ctl ctl--secondary route-regenerate__action" onClick={onGenerate}>
                    {t('route.regenerate.action')}
                </button>
            )}
        </div>
    );
}
