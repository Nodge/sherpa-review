import type { Lens, PrDiff, PrMeta, ReviewUser, Thread } from '@sherpa/protocol';

/** A complete fixture PR: everything `FixtureHost` returns and mutates in memory. */
export interface FixtureData {
    pr: PrMeta;
    diff: PrDiff;
    threads: Thread[];
    /** null means the host has no ownership concept (`ReviewHost.ownershipLens` contract). */
    ownership: Lens | null;
    extraLenses: Lens[];
    /** "Me" in this fixture: the author of new drafts and the user who resolves threads. */
    currentUser: ReviewUser;
    /** Time of the first mutation. A fixed step between mutations makes timestamps predictable. */
    mutationEpoch: string;
}
