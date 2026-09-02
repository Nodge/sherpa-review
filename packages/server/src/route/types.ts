import type { RouteAnchor, RouteStop, RouteStopChange, RouteTestClaim } from '@sherpa/protocol';

/**
 * Shared types for route result acceptance (M2-T3).
 *
 * Two languages per the logged decision: `errors` are for the model ("fix it and call complete again",
 * rpc-design §3), in actionable English. A stop's `validationNotes` are for the reviewer in the UI,
 * in Russian.
 */

/** Acceptance result: a normalized result or a list of errors for the model. */
export type RouteValidation<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly errors: string[] };

/**
 * Accepted skeleton. `stops` is the full plan, including the synthetic "Other" stop (unknown
 * to the model). `intents` stay out of the snapshot. The section scheduler consumes them (T5).
 */
export interface AcceptedSkeleton {
    readonly summary: string;
    readonly stops: RouteStop[];
    /** Full tour order: stop IDs, with "Other" last. */
    readonly tourOrder: string[];
    /** Draft intent for a stop, indexed by its planned number. */
    readonly intents: Map<number, string>;
}

/** Accepted content for one stop: what the section adds to its planned slot. */
export interface RouteStopFilling {
    readonly planIndex: number;
    readonly paragraph: string;
    readonly bridge: string | null;
    readonly anchors: RouteAnchor[];
    readonly tests: RouteTestClaim[];
    readonly droppedClaims: number;
    readonly validationNotes: string[];
    /** Classification against the previous pass. null means the stop is unchanged or this is the first pass. */
    readonly change: RouteStopChange | null;
}

/** Planned slot + content = complete snapshot stop. */
export function applyFilling(stop: RouteStop, filling: RouteStopFilling): RouteStop {
    return {
        ...stop,
        status: 'ready',
        paragraph: filling.paragraph,
        bridge: filling.bridge,
        anchors: filling.anchors,
        tests: filling.tests,
        droppedClaims: filling.droppedClaims,
        validationNotes: filling.validationNotes,
        change: filling.change,
    };
}
