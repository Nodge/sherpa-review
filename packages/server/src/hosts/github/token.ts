import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { RpcFailure } from '../../errors.js';

/**
 * Resolve the GitHub token through the `gh` chain (`docs/research/github-api.md` §Token): `$GITHUB_TOKEN` →
 * `$GH_TOKEN` → `gh auth token`. Sherpa has no OAuth login of its own. It reads the token exactly where
 * the official CLI keeps it.
 *
 * The token value is never logged or included in error messages (`docs/architecture.md §6`).
 * Only the successful source and the reasons the others failed are exposed.
 */

const execFileAsync = promisify(execFile);

/** Lazy token source. Cache the result without letting failure poison the cache. */
export type TokenSource = () => Promise<string>;

export interface GithubTokenOptions {
    readonly env?: NodeJS.ProcessEnv;
    /** Run `gh auth token` and return stdout. */
    readonly runGh?: () => Promise<string>;
}

const ENV_VARS = ['GITHUB_TOKEN', 'GH_TOKEN'] as const;

export function githubTokenSource(options: GithubTokenOptions = {}): TokenSource {
    let cached: Promise<string> | null = null;
    return () => {
        cached ??= resolveGithubToken(options).catch((error: unknown) => {
            // Otherwise a single failure (missing `gh`, expired session) would stick for the whole process.
            cached = null;
            throw error;
        });
        return cached;
    };
}

export async function resolveGithubToken(options: GithubTokenOptions = {}): Promise<string> {
    const env = options.env ?? process.env;
    const runGh = options.runGh ?? defaultRunGh;
    const misses: string[] = [];

    for (const name of ENV_VARS) {
        const value = (env[name] ?? '').trim();
        if (value !== '') {
            return value;
        }
        misses.push(`${name} is not set`);
    }

    try {
        const token = (await runGh()).trim();
        if (token !== '') {
            return token;
        }
        misses.push('`gh auth token` returned an empty token');
    } catch (error) {
        misses.push(`\`gh auth token\`: ${messageOf(error)}`);
    }

    throw new RpcFailure('host_unavailable', 'Could not obtain a GitHub token.', misses);
}

async function defaultRunGh(): Promise<string> {
    const { stdout } = await execFileAsync('gh', ['auth', 'token'], { timeout: 20_000 });
    return stdout;
}

/**
 * An external error's text for the reasons list. `execFile` messages contain the command, but not the token
 * value. Limit the length as a precaution so unexpected output does not reach the log in full.
 */
function messageOf(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    return message.length > 200 ? `${message.slice(0, 200)}…` : message;
}
