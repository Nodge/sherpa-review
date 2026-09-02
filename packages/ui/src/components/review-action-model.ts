import type { HostId, PublishResult, Verdict } from '@sherpa/protocol';

import { READ_ONLY_REASON } from '../iterations/read-only.tsx';
import type { ConnectionState } from '../store.js';
import { formatCount, plural } from '../text.js';

export type ShipMode = Extract<Verdict, 'ship' | 'sticky_ship'>;

export interface PublishGuardInput {
    readonly connection: ConnectionState;
    readonly pendingComposer: boolean;
    readonly publishing: boolean;
    /** After failure, only an explicit retry of the same verdict is allowed. */
    readonly failure?: boolean;
    /** The tab is viewing a previous iteration. Only the active one can be shipped (M4 boundaries). */
    readonly readOnlyIteration?: boolean;
    /** Read-only reason from context. Defaults to the active-iteration message. */
    readonly readOnlyReason?: string;
}

export interface FailedPublicationComment {
    readonly commentId: HostId;
    readonly message: string;
    readonly body: string | null;
}

export interface PublicationFailure {
    readonly verdict: Verdict;
    readonly failedCount: number;
    readonly comments: readonly FailedPublicationComment[];
    readonly message: string | null;
}

/** The disabled-verdict reason is shared by buttons, shortcuts and the palette. */
export function publishDisabledReason(input: PublishGuardInput): string | null {
    if (input.readOnlyIteration === true) {
        return input.readOnlyReason ?? READ_ONLY_REASON;
    }
    if (input.publishing) {
        return 'publishing…';
    }
    if (input.connection === 'reconnecting' || input.connection === 'fatal') {
        return 'no connection to the server';
    }
    if (input.pendingComposer) {
        return 'there is unsaved text';
    }
    if (input.failure === true) {
        return 'retry the previous publication first';
    }
    return null;
}

/** The last mode lives in global settings. Unavailable sticky always falls back to ship. */
export function availableShipMode(mode: ShipMode, stickyAvailable: boolean): ShipMode {
    return mode === 'sticky_ship' && !stickyAvailable ? 'ship' : mode;
}

/** The command's consequence is visible before it runs, in the palette and the button tooltip. */
export function publishConsequence(verdict: Verdict, drafts: number): string {
    const batch = `${formatCount(drafts)} ${plural(drafts, 'draft', 'drafts', 'drafts')}`;
    return verdict === 'request_changes'
        ? `Publishes ${batch} and requests changes`
        : `Publishes ${batch} and approves the snapshot`;
}

export function partialPublicationFailure(
    verdict: Verdict,
    result: PublishResult,
    bodies: ReadonlyMap<HostId, string>,
): PublicationFailure | null {
    if (result.verdictApplied) {
        return null;
    }
    return {
        verdict,
        failedCount: result.failed.length,
        comments: result.failed.map((failure) => ({
            ...failure,
            body: bodies.get(failure.commentId) ?? null,
        })),
        message: result.failed.length === 0 ? 'The host did not apply the verdict.' : null,
    };
}

export function requestPublicationFailure(verdict: Verdict, drafts: number, error: unknown): PublicationFailure {
    return {
        verdict,
        failedCount: drafts,
        comments: [],
        message: error instanceof Error ? error.message : String(error),
    };
}
