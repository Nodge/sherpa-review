import type { ReviewerVerdict } from '@sherpa/protocol';

import { Icon } from '../icons/icon.tsx';
import { relativeTime } from '../threads/relative-time.js';
import './ship-verdict-banner.css';

/**
 * "Someone else ships first" (M5-T15, SPEC §4.5): another reviewer's ship does not cancel the review, drafts
 * will still be published, but the reviewer needs to know before pressing their own button.
 *
 * Hosts do not provide verdict timestamps, so "when" is measured from the moment the tab
 * saw the verdict in a metadata snapshot. The first snapshot is the baseline. Anything before the tab
 * opened is not news.
 */

export interface ShipVerdictEvent {
    readonly login: string;
    readonly displayName: string | null;
    /** Time when the tab noticed the verdict. */
    readonly observedAt: number;
}

/**
 * New ship by another reviewer in a metadata snapshot. `previous: null` is the first snapshot of this tab session,
 * which produces no events.
 */
export function newShipVerdict(
    previous: readonly ReviewerVerdict[] | null,
    next: readonly ReviewerVerdict[],
    observedAt: number,
): ShipVerdictEvent | null {
    if (previous === null) {
        return null;
    }
    const shipped = new Set(previous.filter(isShip).map((verdict) => verdict.user.login));
    const fresh = next.filter(isShip).find((verdict) => !shipped.has(verdict.user.login));
    return fresh === undefined
        ? null
        : { login: fresh.user.login, displayName: fresh.user.displayName, observedAt };
}

/**
 * What the tab already knows about verdicts. `ownShipPending` means our publication awaits its own
 * verdict in a snapshot. The UI has no reviewer login, so it cannot distinguish our ship from someone else's.
 */
export interface ShipVerdictWatch {
    readonly seen: readonly ReviewerVerdict[] | null;
    readonly ownShipPending: boolean;
}

export const INITIAL_SHIP_VERDICT_WATCH: ShipVerdictWatch = { seen: null, ownShipPending: false };

/**
 * New verdict snapshot: what to remember and what to tell the reviewer. The first ship after our own
 * publication is ours, so it is not news. The cost is that someone else's ship arriving in the same
 * snapshot as ours goes unnoticed.
 */
export function observeShipVerdicts(
    watch: ShipVerdictWatch,
    verdicts: readonly ReviewerVerdict[],
    observedAt: number,
): { readonly watch: ShipVerdictWatch; readonly event: ShipVerdictEvent | null } {
    const event = newShipVerdict(watch.seen, verdicts, observedAt);
    if (event === null) {
        return { watch: { ...watch, seen: verdicts }, event: null };
    }
    if (watch.ownShipPending) {
        return { watch: { seen: verdicts, ownShipPending: false }, event: null };
    }
    return { watch: { ...watch, seen: verdicts }, event };
}

function isShip(verdict: ReviewerVerdict): boolean {
    return verdict.verdict === 'ship' || verdict.verdict === 'sticky_ship';
}

export function ShipVerdictBanner({
    event,
    now,
    onDismiss,
}: {
    readonly event: ShipVerdictEvent;
    readonly now: number;
    readonly onDismiss: () => void;
}) {
    const when = relativeTime(new Date(event.observedAt).toISOString(), now);
    return (
        <div className="ship-verdict-banner" role="status">
            <Icon name="thumb" size={14} className="ship-verdict-banner__icon" />
            <div className="ship-verdict-banner__body">
                {event.displayName ?? event.login} shipped this PR {when}. Your comments will still
                be published.
            </div>
            <button
                type="button"
                className="ship-verdict-banner__dismiss"
                aria-label="Dismiss the message about another reviewer's ship"
                title="Dismiss until the next verdict"
                onClick={onDismiss}
            >
                <Icon name="cross" size={14} />
            </button>
        </div>
    );
}
