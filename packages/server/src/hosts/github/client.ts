import type { z } from 'zod';

import { RpcFailure, describeFetchError } from '../../errors.js';

import type { TokenSource } from './token.js';

/**
 * GitHub HTTP client: GraphQL is the main API, with REST for 3 endpoints unavailable in GraphQL
 * (`docs/research/github-api.md`). Every response passes fail-closed zod validation: GraphQL returns
 * `null` for a missing node, and without a schema this would leave missing data instead of an error.
 *
 * The transport is injected so tests run the adapter against recorded API responses without a network. The token stays
 * in the request header, out of logs and error messages (`docs/architecture.md §6`).
 */

export const GITHUB_API_BASE = 'https://api.github.com';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type Query = Record<string, string | number | undefined>;

export interface GithubClientOptions {
    readonly token: TokenSource;
    readonly fetch?: FetchLike;
    /** For tests only: the only live host is `https://api.github.com`. */
    readonly baseUrl?: string;
    /** Total request attempts (5xx/network). `1` disables retries. */
    readonly retryAttempts?: number;
    readonly retryBaseMs?: number;
    readonly timeoutMs?: number;
    /** Maximum wait for a rate-limit reset. Longer waits yield `host_unavailable`. */
    readonly rateLimitWaitMs?: number;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly now?: () => number;
}

/** Per-call overrides: endpoint headers and attempt limit. */
export interface RestOptions {
    readonly query?: Query;
    readonly headers?: Readonly<Record<string, string>>;
    /** Attempt limit for this call, at least one. */
    readonly retryAttempts?: number;
}

const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 300;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RATE_LIMIT_WAIT_MS = 5 * 60_000;

/**
 * GraphQL point reserve below which the client waits for a window reset: GitHub allows 5000 points per hour,
 * and reaching zero halfway through publication is worse than waiting.
 */
const RATE_LIMIT_RESERVE = 200;

/** Maximum REST list pages to read: at 100 entries per page, this exceeds any PR. */
const MAX_PAGES = 50;

/**
 * Maximum consecutive rate-limit waits. These responses do not consume an attempt, but GitHub may
 * omit the reset time, making the wait zero. Without a limit this would spin.
 */
const MAX_RATE_LIMIT_WAITS = 2;

export class GithubClient {
    private readonly token: TokenSource;
    private readonly fetchImpl: FetchLike;
    private readonly baseUrl: string;
    private readonly retryAttempts: number;
    private readonly retryBaseMs: number;
    private readonly timeoutMs: number;
    private readonly rateLimitWaitMs: number;
    private readonly sleep: (ms: number) => Promise<void>;
    private readonly random: () => number;
    private readonly now: () => number;

    /** Rate-limit window reset time. If null, there is nothing to wait for. */
    private rateLimitResetAt: number | null = null;

    constructor(options: GithubClientOptions) {
        this.token = options.token;
        this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
        this.baseUrl = (options.baseUrl ?? GITHUB_API_BASE).replace(/\/+$/, '');
        this.retryAttempts = options.retryAttempts ?? DEFAULT_RETRY_ATTEMPTS;
        this.retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.rateLimitWaitMs = options.rateLimitWaitMs ?? DEFAULT_RATE_LIMIT_WAIT_MS;
        this.sleep = options.sleep ?? defaultSleep;
        this.random = options.random ?? Math.random;
        this.now = options.now ?? Date.now;
    }

    /**
     * One GraphQL call. GitHub returns errors in `errors[]` with status 200, so the envelope is parsed
     * before the schema, otherwise `data: null` would look like a schema mismatch instead of a host failure.
     */
    async graphql<T>(
        query: string,
        variables: Record<string, unknown>,
        schema: z.ZodType<T>,
        attempts?: number,
    ): Promise<T> {
        const label = operationNameOf(query);
        const response = await this.perform(
            'POST',
            this.urlOf('/graphql', {}),
            {
                body: JSON.stringify({ query, variables }),
                headers: { 'content-type': 'application/json' },
            },
            label,
            Math.max(1, attempts ?? this.retryAttempts),
        );

        const parsed = this.parseJson(label, await this.readText(label, response));
        if (typeof parsed !== 'object' || parsed === null) {
            throw this.failure(label, 'response is not an object');
        }
        const envelope = parsed as { data?: unknown; errors?: unknown };
        if (Array.isArray(envelope.errors) && envelope.errors.length > 0) {
            throw this.failure(label, `GitHub error: ${describeApiErrors(envelope.errors)}`);
        }
        if (envelope.data === undefined || envelope.data === null) {
            throw this.failure(label, 'response has no `data` field');
        }

        this.rememberRateLimit(envelope.data);
        return this.validate(label, envelope.data, schema);
    }

    /** REST call with schema validation of the body. */
    async rest<T>(path: string, schema: z.ZodType<T>, options: RestOptions = {}): Promise<T> {
        const response = await this.perform('GET', this.urlOf(path, options.query ?? {}), initOf(options), path, this.attemptsOf(options));
        return this.validate(path, this.parseJson(path, await this.readText(path, response)), schema);
    }

    /**
     * REST list with all pages: GitHub puts pagination in the `Link` header, not the body.
     * Pages are merged into one array so the caller does not need to know about them.
     */
    async restList<T>(path: string, schema: z.ZodType<T[]>, options: RestOptions = {}): Promise<T[]> {
        const items: T[] = [];
        let url: string | null = this.urlOf(path, options.query ?? {});

        for (let page = 0; page < MAX_PAGES && url !== null; page += 1) {
            const response: Response = await this.perform('GET', url, initOf(options), path, this.attemptsOf(options));
            items.push(...this.validate(path, this.parseJson(path, await this.readText(path, response)), schema));
            url = nextPageUrl(response.headers.get('link'));
        }
        return items;
    }

    /** Raw endpoint bytes. `null` means GitHub returned 404 (the path does not exist at this revision). */
    async restBytes(path: string, options: RestOptions = {}): Promise<Uint8Array | null> {
        const response = await this.perform(
            'GET',
            this.urlOf(path, options.query ?? {}),
            initOf(options),
            path,
            this.attemptsOf(options),
            (status) => status === 404,
        );
        if (response.status === 404) {
            return null;
        }

        try {
            return new Uint8Array(await response.arrayBuffer());
        } catch (error) {
            throw this.failure(path, `could not read the full response (${describeFetchError(error)})`);
        }
    }

    private attemptsOf(options: RestOptions): number {
        return Math.max(1, options.retryAttempts ?? this.retryAttempts);
    }

    /**
     * Request with retries and rate-limit waits. `accepted` passes through statuses that
     * are not errors for the caller (404 for file bytes).
     */
    private async perform(
        method: string,
        url: string,
        init: RequestInit,
        label: string,
        attempts: number,
        accepted: (status: number) => boolean = () => false,
    ): Promise<Response> {
        const token = await this.token();
        let lastError: RpcFailure | null = null;
        let attempt = 1;
        let rateLimitWaits = 0;

        while (attempt <= attempts) {
            await this.awaitRateLimitWindow(label);

            let response: Response;
            try {
                response = await this.fetchImpl(url, {
                    ...init,
                    method,
                    headers: {
                        accept: 'application/vnd.github+json',
                        'x-github-api-version': '2022-11-28',
                        ...(init.headers as Record<string, string> | undefined),
                        authorization: `Bearer ${token}`,
                    },
                    signal: AbortSignal.timeout(this.timeoutMs),
                });
            } catch (error) {
                lastError = this.failure(label, `network unavailable (${describeFetchError(error)})`);
                await this.backoff(attempt, attempts);
                attempt += 1;
                continue;
            }

            if (response.ok || accepted(response.status)) {
                return response;
            }
            // Rate-limit exhaustion needs a window reset wait, not exponential backoff, and consumes no attempt:
            // the response means the request was not executed, so retrying is safe even for writes.
            // Otherwise a mutation limited to one attempt would never wait for a reset.
            if (this.isRateLimited(response)) {
                lastError = this.failure(label, 'GitHub rate limit exhausted');
                rateLimitWaits += 1;
                if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
                    break;
                }
                continue;
            }
            const reason = `${String(response.status)} ${response.statusText}`.trim();
            if (!retriable(response.status)) {
                throw this.failure(label, reason);
            }
            lastError = this.failure(label, reason);
            await this.backoff(attempt, attempts);
            attempt += 1;
        }

        throw lastError ?? this.failure(label, 'request did not complete');
    }

    /**
     * For 403/429 with zero remaining quota, remember the reset time from `x-ratelimit-reset`.
     * The wait happens before the next attempt, in the same place as a planned wait.
     */
    private isRateLimited(response: Response): boolean {
        if (response.status !== 403 && response.status !== 429) {
            return false;
        }
        if ((response.headers.get('x-ratelimit-remaining') ?? '') !== '0') {
            return false;
        }
        const reset = Number(response.headers.get('x-ratelimit-reset') ?? '');
        if (Number.isFinite(reset) && reset > 0) {
            this.rateLimitResetAt = Math.max(this.rateLimitResetAt ?? 0, reset * 1000);
        }
        return true;
    }

    /** When GraphQL points fall below the reserve, wait for the window reset instead of hitting zero. */
    private rememberRateLimit(data: unknown): void {
        if (typeof data !== 'object' || data === null) {
            return;
        }
        const limit = (data as { rateLimit?: unknown }).rateLimit;
        if (typeof limit !== 'object' || limit === null) {
            return;
        }
        const { remaining, resetAt } = limit as { remaining?: unknown; resetAt?: unknown };
        if (typeof remaining !== 'number' || remaining >= RATE_LIMIT_RESERVE || typeof resetAt !== 'string') {
            return;
        }
        const reset = Date.parse(resetAt);
        if (!Number.isNaN(reset)) {
            this.rateLimitResetAt = reset;
        }
    }

    private async awaitRateLimitWindow(label: string): Promise<void> {
        const resetAt = this.rateLimitResetAt;
        if (resetAt === null) {
            return;
        }

        const wait = resetAt - this.now();
        if (wait <= 0) {
            this.rateLimitResetAt = null;
            return;
        }
        if (wait > this.rateLimitWaitMs) {
            this.rateLimitResetAt = null;
            throw this.failure(
                label,
                `rate limit exhausted, window resets in ${String(Math.ceil(wait / 1000))} s, longer than reasonable to wait`,
            );
        }
        await this.sleep(wait);
        this.rateLimitResetAt = null;
    }

    /** Exponential backoff with jitter. Does not wait after the last attempt. */
    private async backoff(attempt: number, attempts: number): Promise<void> {
        if (attempt >= attempts) {
            return;
        }
        const window = this.retryBaseMs * 2 ** (attempt - 1);
        await this.sleep(window + Math.floor(this.random() * window));
    }

    private async readText(label: string, response: Response): Promise<string> {
        try {
            return await response.text();
        } catch (error) {
            throw this.failure(label, `could not read the full response (${describeFetchError(error)})`);
        }
    }

    private parseJson(label: string, raw: string): unknown {
        try {
            return JSON.parse(raw);
        } catch {
            throw this.failure(label, 'response is not JSON');
        }
    }

    private validate<T>(label: string, payload: unknown, schema: z.ZodType<T>): T {
        const result = schema.safeParse(payload);
        if (!result.success) {
            throw this.failure(
                label,
                'response does not match the adapter schema',
                result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
            );
        }
        return result.data;
    }

    private urlOf(path: string, query: Query): string {
        const url = new URL(`${this.baseUrl}${path}`);
        for (const [key, value] of Object.entries(query)) {
            if (value !== undefined) {
                url.searchParams.set(key, String(value));
            }
        }
        return url.toString();
    }

    private failure(label: string, reason: string, details?: readonly string[]): RpcFailure {
        return new RpcFailure('host_unavailable', `GitHub, ${label}: ${reason}.`, details);
    }
}

function initOf(options: RestOptions): RequestInit {
    return options.headers === undefined ? {} : { headers: { ...options.headers } };
}

/** Operation name from the query text, also used as the endpoint label in error messages. */
function operationNameOf(query: string): string {
    return /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(query)?.[1] ?? 'graphql';
}

/** Retries help with 5xx, not 4xx (except rate-limit exhaustion, which has its own branch). */
function retriable(status: number): boolean {
    return status >= 500;
}

/** Next page from the `Link` header. If null, this is the last page. */
function nextPageUrl(link: string | null): string | null {
    if (link === null) {
        return null;
    }
    for (const part of link.split(',')) {
        const found = /<([^>]+)>\s*;\s*rel="next"/.exec(part.trim());
        if (found?.[1] !== undefined) {
            return found[1];
        }
    }
    return null;
}

function describeApiErrors(errors: readonly unknown[]): string {
    const messages = errors.slice(0, 3).map((error) => {
        if (typeof error === 'object' && error !== null && 'message' in error) {
            return typeof error.message === 'string' ? error.message : JSON.stringify(error);
        }
        return JSON.stringify(error);
    });
    return messages.join('; ');
}

function defaultSleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        // The delay between attempts must not keep the process alive.
        timer.unref();
    });
}
