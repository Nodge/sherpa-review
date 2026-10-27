/**
 * Feedback channel for Sherpa itself (the Feedback button in the top bar). The core does not know its name.
 * The build composition root supplies the channel, just like the host list and update channel.
 *
 * - `link`: the button opens an external page (for example, repository issues), and the server sends nothing.
 * - `issues`: a UI form, with the server creating an issue through the channel implementation.
 *
 * Request validation, title, automatic context, whoami and logging are shared in `feedback-routes.ts`.
 */
export type FeedbackChannel = LinkFeedbackChannel | IssuesFeedbackChannel;

export interface LinkFeedbackChannel {
    readonly kind: 'link';
    readonly url: string;
}

export interface IssuesFeedbackChannel {
    readonly kind: 'issues';
    /** Availability for the UI snapshot: synchronous, without spawning processes. */
    availability(): FeedbackAvailability;
    /**
     * Creates an issue. A channel that discovers it cannot send returns `unavailable` with text
     * for the form. This reduces functionality without failing the endpoint. A send failure throws `RpcFailure` with the channel message.
     */
    create(input: FeedbackIssueInput): Promise<FeedbackIssueOutcome>;
    /** Where to ask or discuss when no issue is needed. If null or absent, the UI hides the link. */
    readonly discussionUrl?: string | null;
}

export interface FeedbackAvailability {
    readonly available: boolean;
    /** When `available: false`, explains why and where to write manually. Otherwise null. */
    readonly reason: string | null;
}

export interface FeedbackIssueInput {
    readonly summary: string;
    readonly description: string;
}

export type FeedbackIssueOutcome =
    | { readonly kind: 'created'; readonly key: string | null; readonly url: string | null }
    | { readonly kind: 'unavailable'; readonly reason: string };

/** Installation directory where the channel implementation looks for its tools. */
export interface FeedbackLaunchContext {
    readonly installDir: string | null;
}

/** Creates a channel from the launch context. If null, the build has no channel or feedback button. */
export type FeedbackChannelFactory = (context: FeedbackLaunchContext) => FeedbackChannel | null;

/** Link channel: the Feedback button opens `url` in a new tab. */
export function linkFeedbackChannel(url: string): LinkFeedbackChannel {
    return { kind: 'link', url };
}
