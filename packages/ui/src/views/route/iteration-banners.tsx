import type { HostId, RouteCarried, RouteSnapshot, RouteStop, UiRouteStale, UiRouteState } from '@sherpa/protocol';

import { Icon } from '../../icons/icon.tsx';
import type { ViewingLabel } from '../../iterations/viewing.js';
import { planLabel } from '../../route/route-model.js';
import type { ViewId } from '../../session/views.js';
import { formatCount, plural } from '../../text.js';
import { relativeTime } from '../../threads/relative-time.js';
import './iteration-banners.css';

/**
 * Iteration banners (README §9): "Route is stale" and "Route rebuilt". Both render through
 * the shared banner slot. The source registry in App owns their activity conditions and priorities,
 * and the components only display what they receive.
 *
 * Stale describes a condition and stays while it holds (SPEC §2.21), so it has no close
 * button. The second pass banner describes a filter and can be dismissed.
 */

/** First 7 hex digits of the commit. `title` holds the full hash so the reviewer can compare it with the host. */
function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

/** "02, 03 and 07" lists stop numbers in the banner text. */
function enumerate(items: readonly string[]): string {
    if (items.length <= 1) {
        return items.join('');
    }
    return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
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
    return (
        <div className="iteration-banner" role="status" aria-label="Notes lost their anchor">
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    {formatCount(count)} {plural(count, 'note lost its', 'notes lost their', 'notes lost their')}{' '}
                    anchor after the new push
                </div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onShow}>
                View
            </button>
            <button
                type="button"
                className="iteration-banner__dismiss"
                aria-label="Hide the lost-notes banner"
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
    const byId = new Map(stops.map((stop) => [stop.id, stop]));
    const affected = stale.affectedStopIds
        .map((stopId) => byId.get(stopId))
        .filter((stop) => stop !== undefined)
        .map((stop) => planLabel(stop.planIndex));
    const prCommit = shortCommit(stale.prCommit);

    return (
        <div className="iteration-banner" role="status" aria-label="Route is stale">
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    The route was built for{' '}
                    <code className="iteration-banner__commit" title={stale.routeCommit}>
                        {shortCommit(stale.routeCommit)}
                    </code>
                    , the PR is already at{' '}
                    <code className="iteration-banner__commit" title={stale.prCommit}>
                        {prCommit}
                    </code>{' '}
                    — {formatCount(stale.newIterations)}{' '}
                    {plural(stale.newIterations, 'new iteration', 'new iterations', 'new iterations')}
                    {affected.length === 0 ? '' : `; stops ${enumerate(affected)} are affected`}
                </div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onRegenerate}>
                Rebuild the route
            </button>
            {onOpenDiffWithoutRoute === undefined ? null : (
                <button
                    type="button"
                    className="iteration-banner__secondary"
                    onClick={() => {
                        onOpenDiffWithoutRoute(stale.prDiffId);
                    }}
                >
                    Open the {prCommit} diff without a route
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
    const what = label.kind === 'snapshot' ? 'snapshot' : 'the previous iteration';
    return (
        <div className="iteration-banner" role="status" aria-label="Read-only">
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    You are looking at {what}{' '}
                    <code className="iteration-banner__commit" title={label.commit}>
                        {shortCommit(label.commit)}
                    </code>
                    {createdAt === null ? '' : ` from ${relativeTime(createdAt, now)}`} · read-only
                    {gone ? ' · the commit is no longer in the PR' : ''}
                </div>
            </div>
            <button type="button" className="iteration-banner__action" onClick={onCurrent}>
                To the current one
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
    return (
        <div className="iteration-banner" role="status" aria-label="Route rebuilt">
            <div className="iteration-banner__body">
                <div className="iteration-banner__line">
                    The route was rebuilt for{' '}
                    <code className="iteration-banner__commit" title={commit}>
                        {shortCommit(commit)}
                    </code>
                    .
                </div>
                <div className="iteration-banner__note">
                    {/* The noun agrees with the denominator, the verb with the numerator. */}
                    {carried === null
                        ? ''
                        : `Progress carried over: ${formatCount(carried.kept)} of ${formatCount(carried.total)} ${plural(
                              carried.total,
                              'stop',
                              'stops',
                              'stops',
                          )} ${plural(
                              carried.kept,
                              'has not changed and remains viewed',
                              'have not changed and remain viewed',
                              'have not changed and remain viewed',
                          )}. `}
                    {hasChanges
                        ? 'Comments on changed ranges are pinned to the old commit'
                        : 'No changes in the stops'}
                </div>
            </div>
            {hasChanges ? (
                <button type="button" className="iteration-banner__action" onClick={onShowNew}>
                    What is new since the last pass
                </button>
            ) : null}
            <button
                type="button"
                className="iteration-banner__dismiss"
                aria-label="Hide the second-pass banner"
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
