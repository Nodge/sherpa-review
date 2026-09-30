import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import { githubTokenSource, resolveGithubToken } from './token.js';

/** The token value must not appear in any text. The test searches for that exact value. */
const SECRET = 'ghp-secret-value-42';

/** Chain failure as `RpcFailure`. A successful call fails the test here. */
async function failureOf(call: Promise<unknown>): Promise<RpcFailure> {
    try {
        await call;
    } catch (error) {
        return error as RpcFailure;
    }
    throw new Error('expected the token chain to fail, but a token was found');
}

describe('GitHub token', () => {
    it('uses GITHUB_TOKEN before other sources', async () => {
        const token = await resolveGithubToken({
            env: { GITHUB_TOKEN: ` ${SECRET} `, GH_TOKEN: 'other' },
            runGh: () => Promise.reject(new Error('must not be called')),
        });

        expect(token).toBe(SECRET);
    });

    it('falls back to GH_TOKEN when the first source is unset', async () => {
        const token = await resolveGithubToken({
            env: { GH_TOKEN: SECRET },
            runGh: () => Promise.reject(new Error('must not be called')),
        });

        expect(token).toBe(SECRET);
    });

    it('uses `gh auth token` as the last source', async () => {
        const token = await resolveGithubToken({ env: {}, runGh: () => Promise.resolve(`${SECRET}\n`) });

        expect(token).toBe(SECRET);
    });

    it('returns host_unavailable with failure reasons but no token text when the whole chain fails', async () => {
        const failure = await failureOf(
            resolveGithubToken({
                env: { GITHUB_TOKEN: '  ', GH_TOKEN: '' },
                runGh: () => Promise.reject(new Error('gh: not logged in')),
            }),
        );

        expect(failure).toBeInstanceOf(RpcFailure);
        expect(failure.code).toBe('host_unavailable');
        expect(failure.details).toEqual([
            'GITHUB_TOKEN is not set',
            'GH_TOKEN is not set',
            '`gh auth token`: gh: not logged in',
        ]);
    });

    it('does not expose the value of a found token', async () => {
        // The source succeeded. Neither the message nor the details may contain the value.
        const source = githubTokenSource({ env: { GITHUB_TOKEN: SECRET } });
        expect(await source()).toBe(SECRET);

        const failure = await failureOf(resolveGithubToken({ env: {}, runGh: () => Promise.resolve('') }));

        expect(JSON.stringify([failure.message, failure.details])).not.toContain(SECRET);
    });

    it('caches successful results and does not cache failures', async () => {
        let calls = 0;
        const source = githubTokenSource({
            env: {},
            runGh: () => {
                calls += 1;
                return calls === 1 ? Promise.reject(new Error('no session')) : Promise.resolve(SECRET);
            },
        });

        await expect(source()).rejects.toBeInstanceOf(RpcFailure);
        expect(await source()).toBe(SECRET);
        expect(await source()).toBe(SECRET);
        expect(calls).toBe(2);
    });
});
