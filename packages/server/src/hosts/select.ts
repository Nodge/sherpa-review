import type { FixtureName } from '@sherpa/fixtures';
import { FIXTURE_NAMES, makeFixtureHost } from '@sherpa/fixtures';
import type { AnchorPosition, Iteration, ReviewHost, ReviewUser, Verdict } from '@sherpa/protocol';
import {
    
    GITHUB_PR_KEY_PREFIX,
    LOCAL_VCS_PR_KEY_PREFIX,
    parseGithubPrKey,
} from '@sherpa/protocol';

import { DEFAULT_SHERPA_DIR } from '../paths.js';


import { makeGithubHost } from './github/index.js';
import { makeLocalGitHost } from './local-git/index.js';

/**
 * Select the host adapter by PR key (`<host>-<pr>`, `docs/protocol.md §8`):
 * `github-<owner>--<repository>--<number>` identifies a PR on
 * github.com, `local-git-<directory>-<hash>` identifies a local git working tree,
 * `fixture-<name from FIXTURE_NAMES>` identifies deterministic fixtures (UI development and e2e),
 * anything else has no host, and review endpoints return `no_review_host`.
 *
 * The fixture host is intentionally connected to the server. Otherwise development mode and e2e would need a live
 * review host.
 */

/** Publication round waiting for the agent: a verdict and threads with comments from this publication. */
export interface FeedbackRound {
    readonly id: string;
    readonly verdict: Verdict;
    readonly createdAt: string;
    readonly threadIds: readonly string[];
}

/** Thread comment tree as read by the agent. */
export interface FeedbackComment {
    readonly author: ReviewUser;
    readonly createdAt: string;
    readonly body: string;
    readonly replies: readonly FeedbackComment[];
}

export interface FeedbackThread {
    readonly threadId: string;
    /** File path relative to the project directory. null means a PR discussion. */
    readonly path: string | null;
    /** Absolute path to the same file: the agent edits it directly in the checkout. */
    readonly file: string | null;
    /** Anchor side and line. null means a whole-file anchor or PR discussion. */
    readonly position: AnchorPosition | null;
    /** Patch excerpt around the anchor. null means no excerpt, with the reason in `note`. */
    readonly excerpt: string | null;
    /** Why the excerpt is missing: the thread is outdated or the file is absent from the active diff. */
    readonly note: string | null;
    readonly resolved: boolean;
    readonly comments: readonly FeedbackComment[];
}

export interface FeedbackRoundContext {
    readonly roundId: string;
    readonly verdict: Verdict;
    /** Project directory: the agent has nothing to edit outside it. */
    readonly projectDir: string;
    readonly threads: readonly FeedbackThread[];
}

/** Agent reply to a round thread. */
export interface FeedbackReply {
    readonly threadId: string;
    readonly body: string;
}

/**
 * Local review rounds: published comments become an agent task, and its replies become
 * regular thread comments. Host-specific, like `refresh`: this access does not extend beyond
 * the orchestrator registration point.
 */
export interface FeedbackHost {
    /** `pending` rounds in creation order. */
    pendingRounds(): Promise<FeedbackRound[]>;
    roundContext(roundId: string): Promise<FeedbackRoundContext>;
    /**
     * Agent replies go to round threads, and the round becomes `done` with a summary. A reply to a thread outside the round is an error.
     */
    completeRound(
        roundId: string,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void>;
}

export interface SelectedHost {
    /** Adapter name for `uiState.reviewHost`. */
    readonly name: string;
    readonly host: ReviewHost;
    /** Optional host-specific whoami for automatic feedback context. */
    readonly currentUser?: () => string | null | Promise<string | null>;
    /**
     * Fixture host only: development "push" (`UI_DEV_ENDPOINTS.fixtureAdvanceIteration`).
     * This access does not extend beyond the development route registration point. Shared server code
     * knows nothing about fixtures.
     */
    readonly advanceIteration?: () => Iteration;
    /**
     * Host-specific subscription to review status changes (a status field in the lightweight
     * polling). When available, the server uses it to reread PR metadata and detect someone else's ship.
     */
    readonly watchStatus?: (onChange: () => void) => () => void;
    /** Fixture host only: development toggle for draft write failures (buffer e2e). */
    readonly setFailDraftWrites?: (fail: boolean) => void;
    /**
     * Local host only: force a working-tree poll outside the interval.
     * Like other host-specific access, this does not extend beyond the registration point.
     */
    readonly refresh?: () => Promise<void>;
    /**
     * Local host only: publication rounds that the server turns into agent tasks.
     * Without it, there is no feedback orchestrator.
     */
    readonly feedback?: FeedbackHost;
}

/** What the factory needs beyond the key: for the local host, the directory and where its state lives. */
export interface SelectHostOptions {
    /** Local review project directory (`--repo`). null uses the saved key state. */
    readonly repo?: string | null;
    /** Local review base (`--base`). With null, use `git merge-base main HEAD`. */
    readonly base?: string | null;
    /** Branch where the CLI built the key (`--branch`). null leaves detection to the first snapshot. */
    readonly branch?: string | null;
    /** State root: contains the key state. */
    readonly sherpaDir?: string;
}

export type ReviewHostFactory = (prKey: string, options: SelectHostOptions) => SelectedHost | null;

const FIXTURE_PREFIX = 'fixture-';

export function selectReviewHost(prKey: string, options: SelectHostOptions = {}): SelectedHost | null {
    
        
        
        if (!/^[1-9]\d*$/.test(raw)) {
            return null;
        }
        
        return {
            
            host,
            currentUser: () => host.currentUser(),
            watchStatus: (onChange) => host.watchStatus(onChange),
        };
    }

    if (prKey.startsWith(GITHUB_PR_KEY_PREFIX)) {
        const ref = parseGithubPrKey(prKey);
        if (ref === null) {
            return null;
        }
        const host = makeGithubHost({ ...ref, sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR });
        return {
            name: 'github',
            host,
            currentUser: () => host.currentUser(),
            watchStatus: (onChange) => host.watchStatus(onChange),
        };
    }

    if (prKey.startsWith(LOCAL_VCS_PR_KEY_PREFIX)) {
        const host = makeLocalVcsHost({
            prKey,
            sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR,
            repo: options.repo ?? null,
            base: options.base ?? null,
            branch: options.branch ?? null,
        });
        if (host === null) {
            return null;
        }
        return {
            name: 'local-git',
            host,
            currentUser: () => host.currentUser(),
            refresh: () => host.refresh(),
            feedback: host,
        };
    }

    if (prKey.startsWith(FIXTURE_PREFIX)) {
        const raw = prKey.slice(FIXTURE_PREFIX.length);
        if (!isFixtureName(raw)) {
            return null;
        }
        const host = makeFixtureHost(raw);
        return {
            name: 'fixture',
            host,
            advanceIteration: () => host.advanceIteration(),
            setFailDraftWrites: (fail) => {
                host.setFailDraftWrites(fail);
            },
        };
    }

    return null;
}

function isFixtureName(value: string): value is FixtureName {
    return (FIXTURE_NAMES as readonly string[]).includes(value);
}
