import { githubPrKey, githubPrRefOf } from '@sherpa/protocol';

import type { CliHostPlugin } from './plugin.js';

/** GitHub in the CLI: github.com PR link → `github-<owner>--<repo>--<number>` key. */

/** `https://github.com/<owner>/<repo>/pull/<number>` with any suffix. Scheme and `www.` are optional. */
const URL_PATTERN = /^(?:https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:[/?#].*)?$/;

export const githubCliHost: CliHostPlugin = {
    name: 'github',
    normalizeKey: normalizeGithubKey,
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
