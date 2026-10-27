/**
 * Shared PR key formats (`docs/protocol.md §8`). The key is part of a path in `~/.sherpa`, so it uses
 * the `prKeySchema` alphabet. The host plugin chooses the key prefix. The CLI builds keys, the server
 * uses them to select a host. Only what the CLI and server share lives here: the local key structure and the
 * GitHub key format. Other prefixes are known only to their host plugins.
 */

/** Shared prefix for local review keys and adapter names. */
const LOCAL_PREFIX = 'local-';

/**
 * `local-<vcs>-<directory>-<hash>`: working tree of a local checkout. The host plugin names the VCS kind,
 * which goes in the key. The server uses it to select a backend, the CLI recognizes local review without asking the server.
 */
export function localPrKeyPrefix(vcs: string): string {
    return `${LOCAL_PREFIX}${vcs}-`;
}

/** Local adapter name (`SelectedHost.name`, also `uiState.reviewHost.id`): `local-<vcs>`. */
export function localHostName(vcs: string): string {
    return `${LOCAL_PREFIX}${vcs}`;
}

/**
 * `github-<owner>--<repository>--<number>`. The separator is a double hyphen: GitHub owners
 * cannot contain it, but repository names can.
 */
export const GITHUB_PR_KEY_PREFIX = 'github-';

/** PR address on github.com: owner, repository and number. */
export interface GithubPrRef {
    readonly owner: string;
    readonly repo: string;
    readonly number: number;
}

const SEPARATOR = '--';

/** GitHub owner: letters, digits and single hyphens. Cannot contain a double hyphen. */
const OWNER_PATTERN = /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*$/;

/** GitHub repository: letters, digits, dots, hyphens and underscores. Consecutive hyphens are allowed. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/;

const NUMBER_PATTERN = /^[1-9][0-9]*$/;

export function githubPrKey(ref: GithubPrRef): string {
    return `${GITHUB_PR_KEY_PREFIX}${ref.owner}${SEPARATOR}${ref.repo}${SEPARATOR}${String(ref.number)}`;
}

/**
 * Key parsing: owner before the first `--`, number after the last, repository is everything between.
 * null means this is not a GitHub PR key (including parts that do not look like GitHub names).
 */
export function parseGithubPrKey(key: string): GithubPrRef | null {
    if (!key.startsWith(GITHUB_PR_KEY_PREFIX)) {
        return null;
    }

    const rest = key.slice(GITHUB_PR_KEY_PREFIX.length);
    const first = rest.indexOf(SEPARATOR);
    const last = rest.lastIndexOf(SEPARATOR);
    if (first === -1 || last === first) {
        return null;
    }

    return githubPrRefOf(
        rest.slice(0, first),
        rest.slice(first + SEPARATOR.length, last),
        rest.slice(last + SEPARATOR.length),
    );
}

/** PR address from its parts. null means a part does not look like a GitHub name or PR number. */
export function githubPrRefOf(owner: string, repo: string, number: string): GithubPrRef | null {
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !NUMBER_PATTERN.test(number)) {
        return null;
    }
    return { owner, repo, number: Number(number) };
}
