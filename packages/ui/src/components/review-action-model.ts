import type { HostId, PublishResult, Verdict } from '@sherpa/protocol';

import type { ConnectionState } from '../store.js';
import { formatCount, plural } from '../text.js';

export type ShipMode = Extract<Verdict, 'ship' | 'sticky_ship'>;

const SHIP_MODE_KEY = 'sherpa.shipMode';

export interface PublishGuardInput {
    readonly connection: ConnectionState;
    readonly pendingComposer: boolean;
    readonly publishing: boolean;
    /** After failure, only an explicit retry of the same verdict is allowed. */
    readonly failure?: boolean;
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
    if (input.publishing) {
        return 'publishing…';
    }
    if (input.connection === 'reconnecting' || input.connection === 'fatal') {
        return 'no connection to the server';
    }
    if (input.pendingComposer) {
        return 'a draft is still being saved';
    }
    if (input.failure === true) {
        return 'retry the previous publication first';
    }
    return null;
}

/** The last mode is stored in the local browser profile. Unavailable sticky always falls back to ship. */
export function loadShipMode(
    stickyAvailable: boolean,
    storage: Pick<Storage, 'getItem'> | null = browserStorage(),
): ShipMode {
    try {
        return availableShipMode(storage?.getItem(SHIP_MODE_KEY) === 'sticky_ship' ? 'sticky_ship' : 'ship', stickyAvailable);
    } catch {
        return 'ship';
    }
}

export function saveShipMode(
    mode: ShipMode,
    storage: Pick<Storage, 'setItem'> | null = browserStorage(),
): void {
    try {
        storage?.setItem(SHIP_MODE_KEY, mode);
    } catch {
        // Blocked localStorage does not prevent applying the mode in the current tab.
    }
}

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

function browserStorage(): Storage | null {
    try {
        const storage: unknown = globalThis.localStorage;
        return storage == null ? null : (storage as Storage);
    } catch {
        return null;
    }
}
