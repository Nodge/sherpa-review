import type { AnchorPosition, Iteration, ReviewHost, ReviewUser, UiReviewHost, Verdict } from '@sherpa/protocol';

/**
 * Host composition contract: host plugin, selected adapter and its host-specific capabilities.
 * It is not a process boundary, so it lives in the server rather than the protocol.
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
    /**
     * User instruction for the review outcome (`--verdicts`) when the task is built. null means verdict
     * mode is disabled.
     */
    readonly instruction: string | null;
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

/** How the UI describes the host (`uiState.reviewHost`), except its name, supplied by `HostPlugin.name`. */
export type HostUi = Omit<UiReviewHost, 'id'>;

export interface SelectedHost {
    /** Adapter name: `uiState.reviewHost.id`. */
    readonly name: string;
    readonly ui: HostUi;
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
     * Host-specific subscription to review status changes (for example, cheap status
     * polling). When present, the server uses it to reread PR metadata and detect another reviewer's ship.
     */
    readonly watchStatus?: (onChange: () => void) => () => void;
    /**
     * true disables network update checks: the fixture host gets its version from
     * a development endpoint (`UI_DEV_ENDPOINTS.updateAvailable`).
     */
    readonly disablesUpdateCheck?: boolean;
    /** Fixture host only: development toggle for draft write failures (buffer e2e). */
    readonly setFailDraftWrites?: (fail: boolean) => void;
    /**
     * Local host only: force a working-tree poll outside the interval.
     * Like other host-specific access, this does not extend beyond the registration point.
     */
    readonly refresh?: () => Promise<void>;
    /**
     * Local host only: review outcome instruction (`--verdicts`) on a running server. null means
     * the mode is disabled. true means the mode was enabled or disabled and PR metadata needs rereading.
     */
    readonly setLocalVerdicts?: (instruction: string | null) => boolean;
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
    /** Local review base (`--base`). null means merge-base with the default base branch. */
    readonly base?: string | null;
    /** Branch where the CLI built the key (`--branch`). null leaves detection to the first snapshot. */
    readonly branch?: string | null;
    /** Instruction for the local review outcome (`--verdicts`), used only together with `repo`. */
    readonly verdicts?: string | null;
    /** State root: contains the key state. */
    readonly sherpaDir?: string;
}

/**
 * Host plugin: a PR key prefix and its adapter factory. The server core does not know hosts by name.
 * The plugin list comes from the composition root (`hosts/all.ts`), and selection
 * uses the prefix (`selectReviewHost`).
 */
export interface HostPlugin {
    /** Adapter name: `SelectedHost.name`, also `uiState.reviewHost.id`. */
    readonly name: string;
    readonly ui: HostUi;
    /** PR key prefix used to select the plugin. Plugin prefixes within one list do not overlap. */
    readonly keyPrefix: string;
    /** Host for a key with this prefix. null means the key cannot be parsed or the host cannot start. */
    make(prKey: string, options: SelectHostOptions): Omit<SelectedHost, 'name' | 'ui'> | null;
    /**
     * Why this key will have no host, as a server log message. null means there is nothing to explain.
     * For hosts that need more than a key (the local host needs the project directory).
     */
    unconfigured?(prKey: string, options: SelectHostOptions): string | null;
}
