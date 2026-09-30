/**
 * PR key formats (`docs/protocol.md §8`). The key is part of a path under `~/.sherpa`, so it uses
 * the `prKeySchema` alphabet. Its prefix selects the host adapter. The CLI builds keys and the server
 * selects hosts from them. These functions are pure. The protocol has no side effects.
 */




/**
 * Version control systems for local review. The kind is part of the key (`local-git-…`),
 * allowing the server to select a backend and the CLI and UI to recognize local review without asking the server.
 */
export const LOCAL_VCS_KINDS = ['git'] as const;
export type LocalVcsKind = (typeof LOCAL_VCS_KINDS)[number];

/** `local-<vcs>-<directory>-<hash>`: the working tree of a local checkout. */
export function localPrKeyPrefix(kind: LocalVcsKind): string {
    return `local-${kind}-`;
}

/** Local adapter name (`SelectedHost.name`, also `uiState.reviewHost`): `local-git`. */
export function localHostName(kind: LocalVcsKind): string {
    return `local-${kind}`;
}

/** VCS kind of a local key. Returns null for keys outside local review. */
export function localVcsOfPrKey(prKey: string): LocalVcsKind | null {
    return LOCAL_VCS_KINDS.find((kind) => prKey.startsWith(localPrKeyPrefix(kind))) ?? null;
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

/** `https://github.com/<owner>/<repo>/pull/<number>` with any suffix. Scheme and `www.` are optional. */
const URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

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

    return refOf(rest.slice(0, first), rest.slice(first + SEPARATOR.length, last), rest.slice(last + SEPARATOR.length));
}

/** PR address from a github.com URL. Returns null if the URL is not a github.com PR. */
export function parseGithubPrUrl(url: string): GithubPrRef | null {
    const found = URL_PATTERN.exec(url.trim());
    if (found === null) {
        return null;
    }
    return refOf(found[1] ?? '', found[2] ?? '', found[3] ?? '');
}

function refOf(owner: string, repo: string, number: string): GithubPrRef | null {
    if (!OWNER_PATTERN.test(owner) || !REPO_PATTERN.test(repo) || !NUMBER_PATTERN.test(number)) {
        return null;
    }
    return { owner, repo, number: Number(number) };
}
