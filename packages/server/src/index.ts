/**
 * Sherpa local server (docs/architecture.md §1): discovery manifest, bearer authentication, storage,
 * leased task queue, worker endpoints and a UI channel (REST + SSE, serving the built UI).
 *
 * Public API needed by composition roots and the CLI: server startup, host selection and contracts
 * for plugins and channels. The root imports plugins and channel implementations from their own modules.
 */
export type {
    FeedbackAvailability,
    FeedbackChannel,
    FeedbackChannelFactory,
    FeedbackIssueInput,
    FeedbackIssueOutcome,
    FeedbackLaunchContext,
    IssuesFeedbackChannel,
    LinkFeedbackChannel,
} from './feedback-channel.js';
export { linkFeedbackChannel } from './feedback-channel.js';
export { RpcFailure } from './errors.js';
export type { HostPlugin, SelectedHost, SelectHostOptions } from './hosts/plugin.js';
export { selectReviewHost } from './hosts/select.js';
export type { HealthResponse, SherpaServer, StartServerOptions } from './server.js';
export { startServer } from './server.js';
export type { UpdateChannel, UpdateChannelRequest } from './update-channel.js';
