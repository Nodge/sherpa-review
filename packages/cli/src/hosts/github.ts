import { githubPrKey, githubPrRefOf } from '@sherpa/protocol';

import type { CliHostPlugin } from './plugin.js';

/** GitHub in the CLI: github.com PR link → `github-<owner>--<repo>--<number>` key. */

/** `https://github.com/<owner>/<repo>/pull/<number>` with any suffix. Scheme and `www.` are optional. */
const URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export const githubCliHost: CliHostPlugin = {
    name: 'github',
    normalizeKey: normalizeGithubKey,
    guide: {
        arguments: [
            '**A GitHub PR URL** (`https://github.com/<owner>/<repo>/pull/<n>`, any trailing path) means PR review ' +
                'of that pull request. Pass the URL to `--pr` as it is. Sherpa turns it into the key itself and ' +
                'prints the key it settled on.',
        ],
        requirements: [
            'A GitHub PR needs no checkout, as Sherpa reads it over the GitHub API, but it does need a token: ' +
                '`GITHUB_TOKEN`, `GH_TOKEN`, or a `gh` CLI you are already logged into. If a command fails with ' +
                'a message about the token, relay it to the reviewer and stop: logging in is their decision. ' +
                'Ownership by team (`@org/team` in CODEOWNERS) needs the `read:org` scope on that token. ' +
                'Without it Sherpa counts ownership by login only and says so.',
        ],
    },
};

/** PR key from a github.com link. null means the link is not a github.com PR. */
export function normalizeGithubKey(input: string): string | null {
    const found = URL_PATTERN.exec(input.trim());
    if (found === null) {
        return null;
    }
    const ref = githubPrRefOf(found[1] ?? '', found[2] ?? '', found[3] ?? '');
    return ref === null ? null : githubPrKey(ref);
}
