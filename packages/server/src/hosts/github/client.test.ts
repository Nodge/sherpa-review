import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { RpcFailure } from '../../errors.js';

import { GithubClient } from './client.js';

/**
 * GitHub client in isolation: retries, waiting for rate-limit resets, REST pagination through `Link`,
 * and keeping the token inside the request header.
 */

const TOKEN = 'test-token-must-never-leak-42';
const QUERY = 'query SherpaProbe { rateLimit { cost remaining resetAt } viewer { login } }';
const SCHEMA = z.object({ viewer: z.object({ login: z.string() }) });

/** Returns a failed call as `RpcFailure`: a successful call here is a test failure, not another type branch. */
async function failureOf(call: Promise<unknown>): Promise<RpcFailure> {
    try {
        await call;
    } catch (error) {
        return error as RpcFailure;
    }
    throw new Error('expected a host failure, but the call succeeded');
}

interface Call {
    readonly url: string;
    readonly headers: Headers;
}

function makeClient(
    responses: readonly (() => Response)[],
    options: { calls?: Call[]; sleeps?: number[]; now?: () => number; rateLimitWaitMs?: number } = {},
): GithubClient {
    let index = 0;
    return new GithubClient({
        token: () => Promise.resolve(TOKEN),
        baseUrl: 'https://api.github.test',
        retryAttempts: 3,
        retryBaseMs: 10,
        random: () => 0,
        sleep: (ms) => {
            options.sleeps?.push(ms);
            return Promise.resolve();
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        ...(options.rateLimitWaitMs === undefined ? {} : { rateLimitWaitMs: options.rateLimitWaitMs }),
        fetch: (url, init) => {
            options.calls?.push({ url, headers: new Headers(init?.headers) });
            const next = responses[Math.min(index, responses.length - 1)];
            index += 1;
            if (next === undefined) {
                throw new Error('test responses exhausted');
            }
            return Promise.resolve(next());
        },
    });
}

function graphqlOk(body: unknown, remaining = 4999): () => Response {
    return () =>
        new Response(
            JSON.stringify({ data: { rateLimit: { cost: 1, remaining, resetAt: '2026-09-20T11:00:00Z' }, ...(body as object) } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
        );
}

describe('GitHub client', () => {
    it('sends the token in a header and the API version', async () => {
        const calls: Call[] = [];
        const client = makeClient([graphqlOk({ viewer: { login: 'alice' } })], { calls });

        expect(await client.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
        expect(calls[0]?.headers.get('x-github-api-version')).toBe('2022-11-28');
        expect(calls[0]?.headers.get('accept')).toBe('application/vnd.github+json');
    });

    it('returns GitHub `errors[]` as the host message without the token', async () => {
        const client = makeClient([
            () =>
                new Response(JSON.stringify({ data: null, errors: [{ message: 'Resource not accessible' }] }), {
                    status: 200,
                }),
        ]);

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure).toBeInstanceOf(RpcFailure);
        expect(failure.message).toBe('GitHub, SherpaProbe: GitHub error: Resource not accessible.');
        expect(failure.message).not.toContain(TOKEN);
    });

    it('retries 5xx but not 4xx', async () => {
        const sleeps: number[] = [];
        const flaky = makeClient(
            [() => new Response('boom', { status: 502 }), graphqlOk({ viewer: { login: 'alice' } })],
            { sleeps },
        );
        expect(await flaky.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([10]);

        const calls: Call[] = [];
        const forbidden = makeClient([() => new Response('no', { status: 404, statusText: 'Not Found' })], { calls });
        await expect(forbidden.graphql(QUERY, {}, SCHEMA)).rejects.toBeInstanceOf(RpcFailure);
        expect(calls).toHaveLength(1);
    });

    it('fails the host call for a schema mismatch instead of leaving missing data', async () => {
        const client = makeClient([graphqlOk({ viewer: { name: 'alice' } })]);

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure.message).toContain('response does not match the adapter schema');
        expect(failure.details?.[0]).toContain('viewer.login');
    });

    it('waits for a reset before the next request when the remaining quota falls below the reserve', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [graphqlOk({ viewer: { login: 'alice' } }, 12), graphqlOk({ viewer: { login: 'alice' } })],
            { sleeps, now: () => reset - 30_000 },
        );

        await client.graphql(QUERY, {}, SCHEMA);
        expect(sleeps).toEqual([]);
        await client.graphql(QUERY, {}, SCHEMA);
        expect(sleeps).toEqual([30_000]);
    });

    it('waits for a reset on 403 with zero quota instead of exponential retries', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 403,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
                graphqlOk({ viewer: { login: 'alice' } }),
            ],
            { sleeps, now: () => reset - 5_000 },
        );

        expect(await client.graphql(QUERY, {}, SCHEMA)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([5_000]);
    });

    it('also waits for rate-limit resets for mutations with a single attempt', async () => {
        const sleeps: number[] = [];
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 403,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
                graphqlOk({ viewer: { login: 'alice' } }),
            ],
            { sleeps, now: () => reset - 5_000 },
        );

        // Writes get one attempt to avoid duplicate creation, but must still wait for rate-limit resets.
        expect(await client.graphql(QUERY, {}, SCHEMA, 1)).toEqual({ viewer: { login: 'alice' } });
        expect(sleeps).toEqual([5_000]);
    });

    it('does not spin when the rate limit has no reset time', async () => {
        const calls: Call[] = [];
        const client = makeClient(
            [() => new Response('rate limited', { status: 429, headers: { 'x-ratelimit-remaining': '0' } })],
            { calls },
        );

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA, 1));
        expect(failure.message).toContain('GitHub rate limit exhausted');
        expect(calls).toHaveLength(3);
    });

    it('fails the host call when the reset wait is too long instead of sleeping for an hour', async () => {
        const reset = Date.parse('2026-09-20T11:00:00Z');
        const client = makeClient(
            [
                () =>
                    new Response('rate limited', {
                        status: 429,
                        headers: {
                            'x-ratelimit-remaining': '0',
                            'x-ratelimit-reset': String(Math.floor(reset / 1000)),
                        },
                    }),
            ],
            { now: () => reset - 3_600_000, rateLimitWaitMs: 60_000 },
        );

        const failure = await failureOf(client.graphql(QUERY, {}, SCHEMA));
        expect(failure.code).toBe('host_unavailable');
        expect(failure.message).toContain('rate limit exhausted');
    });

    it('reads all REST list pages through the `Link` header', async () => {
        const pages = [
            () =>
                new Response('[{"filename":"a.ts"}]', {
                    status: 200,
                    headers: { link: '<https://api.github.test/next?page=2>; rel="next", <x>; rel="last"' },
                }),
            () => new Response('[{"filename":"b.ts"}]', { status: 200 }),
        ];
        const calls: Call[] = [];
        const client = makeClient(pages, { calls });

        const files = await client.restList('/files', z.array(z.object({ filename: z.string() })));
        expect(files).toEqual([{ filename: 'a.ts' }, { filename: 'b.ts' }]);
        expect(calls[1]?.url).toBe('https://api.github.test/next?page=2');
    });

    it('returns null for a file bytes 404 instead of an error', async () => {
        const client = makeClient([() => new Response('{"message":"Not Found"}', { status: 404 })]);

        expect(await client.restBytes('/repos/a/b/contents/nope.png')).toBeNull();
    });
});
