import type { HostId, PublishResult, Verdict } from '@sherpa/protocol';

import type { DraftDestination } from '../app/review-state.js';
import type { MessageKey, Translate } from '../i18n/index.js';
import { READ_ONLY_REASON } from '../iterations/read-only.tsx';
import type { ConnectionState } from '../store.js';

/** Ship split-button mode. Request changes is a separate button. */
export type ShipMode = Extract<Verdict, 'ship' | 'sticky_ship' | 'comment'>;

/** Ship menu rows in display order. */
export const SHIP_MENU_MODES: readonly ShipMode[] = ['ship', 'sticky_ship', 'comment'];

/** Publishing consequence keys, all parameterized by draft count. */
export type PublishConsequenceKey = Extract<
    MessageKey,
    | 'ship.consequence.comment'
    | 'ship.consequence.commentAgent'
    | 'ship.consequence.ship'
    | 'ship.consequence.requestChanges'
    | 'ship.consequence.shipAgent'
    | 'ship.consequence.requestChangesAgent'
>;

export interface PublishGuardInput {
    /** Disabled-button reasons are text, not keys. They form the tooltip directly where used. */
    readonly t: Translate;
    readonly connection: ConnectionState;
    readonly pendingComposer: boolean;
    /**
     * Drafts in the server buffer: the host has not accepted them yet, so there is nothing to publish.
     * Ship waits until they arrive (docs/design/SPEC-elements.md §4.5).
     */
    readonly bufferedDrafts?: number;
    readonly publishing: boolean;
    /** After failure, only an explicit retry of the same verdict is allowed. */
    readonly failure?: boolean;
    /** The tab is viewing a previous iteration. Only the active one can be approved. */
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
        return input.readOnlyReason ?? input.t(READ_ONLY_REASON);
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
    const buffered = input.bufferedDrafts ?? 0;
    if (buffered > 0) {
        return input.t('ship.disabled.buffered', buffered);
    }
    if (input.failure === true) {
        return input.t('ship.disabled.retry');
    }
    return null;
}

/** Split-button modes the host accepts on this PR. The button has a menu when there is more than one. */
export function shipModesOf(publishVerdicts: readonly Verdict[]): ShipMode[] {
    return SHIP_MENU_MODES.filter((mode) => publishVerdicts.includes(mode));
}

/**
 * Effective split-button mode: the saved mode if the PR supports it, otherwise ship, then comment,
 * then the first available mode. null means the host accepts none of the button modes on this PR.
 */
export function availableShipMode(saved: ShipMode, modes: readonly ShipMode[]): ShipMode | null {
    if (modes.includes(saved)) {
        return saved;
    }
    if (modes.includes('ship')) {
        return 'ship';
    }
    return modes.includes('comment') ? 'comment' : (modes[0] ?? null);
}

/** Split-button mode used to publish the verdict, saved by settings. */
export function shipModeOf(verdict: Verdict): ShipMode | null {
    switch (verdict) {
        case 'ship':
        case 'sticky_ship':
        case 'comment':
            return verdict;
        case 'request_changes':
            return null;
        default:
            return unreachableVerdict(verdict);
    }
}

/** Whether the verdict approves the PR. Own ship dismisses the banner about another reviewer's ship. */
export function isShipVerdict(verdict: Verdict): boolean {
    switch (verdict) {
        case 'ship':
        case 'sticky_ship':
            return true;
        case 'comment':
        case 'request_changes':
            return false;
        default:
            return unreachableVerdict(verdict);
    }
}

/** Mode label on the primary part and menu row. */
export function shipModeLabelKey(mode: ShipMode): 'ship.mode.ship' | 'ship.mode.sticky' | 'ship.mode.comment' {
    switch (mode) {
        case 'ship':
            return 'ship.mode.ship';
        case 'sticky_ship':
            return 'ship.mode.sticky';
        case 'comment':
            return 'ship.mode.comment';
        default:
            return unreachableVerdict(mode);
    }
}

/** Why the menu row cannot be selected. Publishing without a verdict also needs drafts to publish. */
export function shipOptionDisabledKey(
    mode: ShipMode,
    modes: readonly ShipMode[],
    drafts: number,
    destination: DraftDestination,
):
    | 'ship.mode.ship.unavailable'
    | 'ship.mode.sticky.unavailable'
    | 'ship.mode.comment.unavailable'
    | NoDraftsKey
    | null {
    switch (mode) {
        case 'ship':
            return modes.includes(mode) ? null : 'ship.mode.ship.unavailable';
        case 'sticky_ship':
            return modes.includes(mode) ? null : 'ship.mode.sticky.unavailable';
        case 'comment':
            if (!modes.includes(mode)) {
                return 'ship.mode.comment.unavailable';
            }
            return drafts === 0 ? noDraftsKey(destination) : null;
        default:
            return unreachableVerdict(mode);
    }
}

type NoDraftsKey = 'ship.noDrafts' | 'ship.noDraftsForAgent';

/** No-drafts text based on where drafts would go. */
export function noDraftsKey(destination: DraftDestination): NoDraftsKey {
    switch (destination) {
        case 'pr':
            return 'ship.noDrafts';
        case 'agent':
            return 'ship.noDraftsForAgent';
        default:
            return unreachableDestination(destination);
    }
}

/** Draft counter text in the bar based on where drafts will go. */
export function draftsCounterKey(destination: DraftDestination): 'ship.drafts' | 'ship.draftsToAgent' {
    switch (destination) {
        case 'pr':
            return 'ship.drafts';
        case 'agent':
            return 'ship.draftsToAgent';
        default:
            return unreachableDestination(destination);
    }
}

/**
 * The command consequence appears before execution in the palette and button tooltip. The shortcut registry stores
 * the key, and the draft count is a separate argument. The palette translates the key itself.
 */
export function publishConsequenceKey(verdict: Verdict, destination: DraftDestination): PublishConsequenceKey {
    switch (verdict) {
        case 'comment':
            return destination === 'agent' ? 'ship.consequence.commentAgent' : 'ship.consequence.comment';
        case 'ship':
        case 'sticky_ship':
            return destination === 'agent' ? 'ship.consequence.shipAgent' : 'ship.consequence.ship';
        case 'request_changes':
            return destination === 'agent' ? 'ship.consequence.requestChangesAgent' : 'ship.consequence.requestChanges';
        default:
            return unreachableVerdict(verdict);
    }
}

export function unreachableVerdict(verdict: never): never {
    throw new Error(`unknown verdict ${String(verdict)}`);
}

function unreachableDestination(destination: never): never {
    throw new Error(`unknown draft destination ${String(destination)}`);
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
