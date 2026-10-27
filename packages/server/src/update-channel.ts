import type { DistributionVersion, UiUpdateInstall } from '@sherpa/protocol';

/**
 * Update channel: where the server learns about a new distribution version and how to suggest updating.
 * The core does not know channels by name. The build composition root supplies one, like the host list.
 * Cache, TTL, dismissed version and version comparison are shared in `UpdateChecker`.
 */
export interface UpdateChannel {
    /**
     * Identifies whose result is in the check cache: all builds on the machine share the cache file,
     * and one channel's version must not appear in another.
     */
    readonly id: string;
    /**
     * Latest published version. null means the channel does not know it. Network errors, responses
     * that fail schema validation and other failures throw: the check writes the reason to stderr.
     */
    latest(request: UpdateChannelRequest): Promise<DistributionVersion | null>;
    /** Toast hint: installation directory, update command and a link to instructions. */
    install(installDir: string | null): UiUpdateInstall;
}

export interface UpdateChannelRequest {
    readonly fetch: typeof fetch;
    /** `UpdateChecker` sets the request timeout. */
    readonly signal: AbortSignal;
}
