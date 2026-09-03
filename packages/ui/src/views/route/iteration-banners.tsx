import type { HostId, RouteCarried, RouteSnapshot, RouteStop, UiRouteStale, UiRouteState } from '@sherpa/protocol';

import type { Translate } from '../../i18n/index.js';
import { relativeTime, shortCommit, useLocale, useT } from '../../i18n/index.js';
import { Icon } from '../../icons/icon.tsx';
import type { ViewingLabel } from '../../iterations/viewing.js';
import { planLabel } from '../../route/route-model.js';
import type { ViewId } from '../../session/views.js';
import './iteration-banners.css';

/**
 * Iteration banners (README §9): "Route is stale" and "Route rebuilt". Both render through
 * the shared banner slot. The source registry in App owns their activity conditions and priorities,
 * and the components only display what they receive.
 *
 * Stale describes a condition and stays while it holds (SPEC §2.21), so it has no close
 * button. The second pass banner describes a filter and can be dismissed.
 */

/** "02, 03 and 07" lists stop numbers in the banner text. */
function enumerate(items: readonly string[], t: Translate): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return t('iteration.stops.enumerate', items.slice(0, -1).join(', '), items[items.length - 1] ?? '');
}

/**
 * A stale route concerns the entire PR, so its banner appears on every tab: "Rebuild the
 * route" works everywhere. Rebuild phases are excluded because generation is already running, the button
 * is blocked by the guard, and the route tab slot holds the rebuild and filling banners.
 */
export function staleBannerVisible(
    phase: UiRouteState['phase'] | null,
    stale: UiRouteStale | null,
    snapshot: RouteSnapshot | null,
    /** The tab shows a previous snapshot or iteration. Stale concerns the current route. */
    readingOld = false,
): boolean {
    return !readingOld && stale !== null && snapshot !== null && phase !== 'reading' && phase !== 'filling';
}

/**
 * The second pass banner appears on a ready snapshot with a predecessor, until it is
 * dismissed for that specific snapshot. A stale route hides it: once the PR has moved ahead, news
 * about carried-over progress takes lower priority. It appears only on the route tab because its action filters
 * the route, so the button has nothing to act on in other tabs.
 */
export function secondPassBannerVisible(
    view: ViewId,
    snapshot: RouteSnapshot | null,
    stale: UiRouteStale | null,
    dismissedSnapshotId: string | null,
    /** The tab shows a previous snapshot or iteration. Second pass concerns the current route. */
    readingOld = false,
): boolean {
    return (
        !readingOld &&
        view === 'route' &&
        snapshot !== null &&
        snapshot.previousSnapshotId !== null &&
        stale === null &&
        dismissedSnapshotId !== snapshot.snapshotId
    );
}

/**
 * Dismissal key for the lost notes banner: the set of notes with lost anchors. A newly lost note
 * brings news, so the dismissed banner returns. Dismissal survives one of the notes disappearing.
 */
export function notesLostKey(noteIds: readonly number[]): string {
    return [...noteIds].sort((left, right) => left - right).join(',');
}

/**
 * Notes with lost anchors concern the entire PR, so the banner appears on every tab, like stale.
 * It is absent when reading a previous iteration, where the note still sits beside its code.
 * It is also absent during route rebuild phases, when higher-priority news occupies the slot.
 */
export function notesLostBannerVisible(
    phase: UiRouteState['phase'] | null,
    lostNoteIds: readonly number[],
    dismissedKey: string | null,
    /** The tab shows a previous snapshot or iteration. */
    readingOld = false,
): boolean {
    return (
        !readingOld &&
        lostNoteIds.length > 0 &&
        phase !== 'reading' &&
        phase !== 'filling' &&
        dismissedKey !== notesLostKey(lostNoteIds)
    );
}

export interface NotesLostBannerProps {
    readonly count: number;
    /** Open the chat at the first note that lost its anchor. */
    readonly onShow: () => void;
    readonly onDismiss: () => void;
}

/**
 * "2 notes lost their anchor after the new push · view" (SPEC §2.16). A filter banner
 * has a dismiss button because this is a one-time notice the reviewer may close (SPEC §2.21).
 */
export function NotesLostBanner({ count, onShow, onDismiss }: NotesLostBannerProps) {
    const t = useT();
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.notesLost.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">{t('iteration.notesLost.text', count)}</div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onShow}>
                {t('iteration.notesLost.show')}
            </button>
            <button
                type="button"
                className="iteration-banner__dismiss"
                aria-label={t('iteration.notesLost.dismiss')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}

export interface RouteStaleBannerProps {
    readonly stale: UiRouteStale;
    /** Current snapshot stops supply the plan numbers of affected stops. */
    readonly stops: readonly RouteStop[];
    /** The same regeneration as the other route buttons. */
    readonly onRegenerate: () => void;
    /** Switch to the active iteration without a route (M4-T9). Without this, there is no button. */
    readonly onOpenDiffWithoutRoute?: (diffId: HostId) => void;
}

export function RouteStaleBanner({ stale, stops, onRegenerate, onOpenDiffWithoutRoute }: RouteStaleBannerProps) {
    const t = useT();
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    const affected = stale.affectedStopIds
        .map((stopId) => byId.get(stopId))
        .filter((stop) => stop !== undefined)
        .map((stop) => planLabel(stop.planIndex));
    const prCommit = shortCommit(stale.prCommit);

    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.stale.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {t('iteration.stale.builtFor')}
                    <code className="iteration-banner__commit" title={stale.routeCommit}>
                        {shortCommit(stale.routeCommit)}
                    </code>
                    {t('iteration.stale.prAt')}
                    <code className="iteration-banner__commit" title={stale.prCommit}>
                        {prCommit}
                    </code>
                    {t('iteration.stale.newIterations', stale.newIterations)}
                    {affected.length === 0 ? '' : t('iteration.stale.affected', enumerate(affected, t))}
                </div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onRegenerate}>
                {t('iteration.stale.regenerate')}
            </button>
            {onOpenDiffWithoutRoute === undefined ? null : (
                <button
                    type="button"
                    className="iteration-banner__secondary"
                    onClick={() => {
                        onOpenDiffWithoutRoute(stale.prDiffId);
                    }}
                >
                    {t('iteration.stale.openDiff', prCommit)}
                </button>
            )}
        </div>
    );
}

export interface ReadOnlyIterationBannerProps {
    readonly label: ViewingLabel;
    /** Snapshot timestamp. null for an iteration without a route. */
    readonly createdAt: string | null;
    /** Reference time for relative timestamps, injected to keep the gallery deterministic. */
    readonly now: number;
    readonly gone: boolean;
    readonly onCurrent: () => void;
}

/**
 * Reading a previous iteration (M4 scope) is a condition, not news, so there is no dismiss button (SPEC §2.21).
 * The date uses the same relative time format as other timestamps in the UI.
 */
export function ReadOnlyIterationBanner({ label, createdAt, now, gone, onCurrent }: ReadOnlyIterationBannerProps) {
    const t = useT();
    const locale = useLocale();
    if (label.kind === 'slice') {
        return (
            <div className="iteration-banner" role="status" aria-label={t('iteration.readOnly.aria')}>
                <div className="iteration-banner__body">
                    <div className="iteration-banner__line">
                        {t('iteration.slice.lead')}
                        <code className="iteration-banner__commit" title={label.baseCommit}>
                            {shortCommit(label.baseCommit)}
                        </code>{' '}
                        →{' '}
                        <code className="iteration-banner__commit" title={label.commit}>
                            {shortCommit(label.commit)}
                        </code>
                        {t('iteration.readOnly.tail')}
                    </div>
                </div>
                <button type="button" className="iteration-banner__action" onClick={onCurrent}>
                    {t('iteration.toActive')}
                </button>
            </div>
        );
    }
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.readOnly.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {label.kind === 'snapshot' ? t('iteration.snapshot.lead') : t('iteration.previous.lead')}
                    <code className="iteration-banner__commit" title={label.commit}>
                        {shortCommit(label.commit)}
                    </code>
                    {/* Time is a separate segment after "·": the formatter can return "yesterday", which does not fit a preposition. */}
                    {createdAt === null ? '' : ` · ${relativeTime(createdAt, now, locale)}`}
                    {t('iteration.readOnly.tail')}
                    {gone ? t('iteration.gone.tail') : ''}
                </div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onCurrent}>
                {t('iteration.toCurrent')}
            </button>
        </div>
    );
}

export interface RouteSecondPassBannerProps {
    readonly commit: string;
    /** Progress carryover result. null means there was nothing to carry over from, so the sentence is omitted. */
    readonly carried: RouteCarried | null;
    /** The snapshot has classified stops. Without them, the filter has nothing to show. */
    readonly hasChanges: boolean;
    readonly onShowNew: () => void;
    readonly onDismiss: () => void;
}

export function RouteSecondPassBanner({
    commit,
    carried,
    hasChanges,
    onShowNew,
    onDismiss,
}: RouteSecondPassBannerProps) {
    const t = useT();
    return (
        <div className="iteration-banner" role="status" aria-label={t('iteration.secondPass.aria')}>
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {t('iteration.secondPass.lead')}
                    <code className="iteration-banner__commit" title={commit}>
                        {shortCommit(commit)}
                    </code>
                    .
                </div>
                <div className="iteration-banner__note">
                    {carried === null ? '' : t('iteration.secondPass.carried', carried.kept, carried.total)}
                    {hasChanges
                        ? t('iteration.secondPass.hasChanges')
                        : t('iteration.secondPass.noChanges')}
                </div>
            </div>
            {hasChanges ? (
                <button type="button" className="iteration-banner__action" onClick={onShowNew}>
                    {t('iteration.secondPass.showNew')}
                </button>
            ) : null}
            <button
                type="button"
                className="iteration-banner__dismiss"
                aria-label={t('iteration.secondPass.dismiss')}
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
