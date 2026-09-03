import type { HostId, PublishResult, Verdict } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';
import { READ_ONLY_REASON } from '../iterations/read-only.tsx';
import type { ConnectionState } from '../store.js';

export type ShipMode = Extract<Verdict, 'ship' | 'sticky_ship'>;

/** Publication consequence keys, both parameterized by the draft count. */
export type PublishConsequenceKey = Extract<MessageKey, 'ship.consequence.ship' | 'ship.consequence.requestChanges'>;

export interface PublishGuardInput {
    /** Disabled-button reasons are text, not keys. They form the tooltip directly where used. */
    readonly t: Translate;
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
        return input.t('ship.disabled.publishing');
    }
    if (input.connection === 'reconnecting' || input.connection === 'fatal') {
        return input.t('ship.disabled.offline');
    }
    if (input.pendingComposer) {
        return input.t('ship.disabled.pending');
    }
    if (input.failure === true) {
        return input.t('ship.disabled.retry');
    }
    return null;
}

/** The last mode lives in global settings. Unavailable sticky always falls back to ship. */
export function availableShipMode(mode: ShipMode, stickyAvailable: boolean): ShipMode {
    return mode === 'sticky_ship' && !stickyAvailable ? 'ship' : mode;
}

/**
 * The command consequence appears before execution in the palette and button tooltip. The shortcut registry stores
 * the key, and the draft count is a separate argument. The palette translates the key itself.
 */
export function publishConsequenceKey(verdict: Verdict): PublishConsequenceKey {
    return verdict === 'request_changes' ? 'ship.consequence.requestChanges' : 'ship.consequence.ship';
}

export function partialPublicationFailure(
    verdict: Verdict,
    result: PublishResult,
    bodies: ReadonlyMap<HostId, string>,
    t: Translate,
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
        message: result.failed.length === 0 ? t('ship.error.verdict') : null,
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
