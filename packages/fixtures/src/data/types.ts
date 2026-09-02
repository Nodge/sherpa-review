import type { HostId, Iteration, Lens, PrDiff, PrMeta, ReviewUser, Thread } from '@sherpa/protocol';

/** Fixture iteration without status. The host computes status from its active-iteration pointer. */
export type FixtureIterationMeta = Omit<Iteration, 'status'>;

/** One PR iteration: the diff and threads the host returns while it is active. */
export interface FixtureIteration {
    iteration: FixtureIterationMeta;
    diff: PrDiff;
    threads: Thread[];
    /** Iteration rewritten by this push (force-push). The host no longer lists the replaced one. */
    replaces: HostId | null;
}

/**
 * A slice between two iterations (interdiff) is declared in data instead of computed.
 * Its hunks are manually matched to iteration patches and checked by guard tests.
 */
export interface FixtureInterdiff {
    base: HostId;
    head: HostId;
    diff: PrDiff;
}

/** A complete fixture PR: everything `FixtureHost` returns and mutates in memory. */
export interface FixtureData {
    pr: PrMeta;
    /** In order of appearance. The first starts the review. The list cannot be empty. */
    iterations: FixtureIteration[];
    interdiffs: FixtureInterdiff[];
    /** null means the host has no ownership concept (`ReviewHost.ownershipLens` contract). */
    ownership: Lens | null;
    extraLenses: Lens[];
    /** "Me" in this fixture: the author of new drafts and the user who resolves threads. */
    currentUser: ReviewUser;
    /** Time of the first mutation. A fixed step between mutations makes timestamps predictable. */
    mutationEpoch: string;
}

/**
 * Flat fixture slice at one iteration, the shape `FixtureData` used before iterations.
 * Used by consumers that do not need iterations: UI tests, the gallery and e2e.
 */
export interface FixtureIterationView {
    pr: PrMeta;
    iteration: FixtureIterationMeta;
    diff: PrDiff;
    threads: Thread[];
    ownership: Lens | null;
    extraLenses: Lens[];
    currentUser: ReviewUser;
    mutationEpoch: string;
}
