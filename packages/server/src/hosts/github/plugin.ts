import { GITHUB_PR_KEY_PREFIX, parseGithubPrKey } from '@sherpa/protocol';

import { DEFAULT_SHERPA_DIR } from '../../paths.js';
import type { HostPlugin } from '../plugin.js';

import { makeGithubHost } from './index.js';

/** `github-<owner>--<repository>--<number>`: a PR on github.com. */
export const githubHostPlugin: HostPlugin = {
    name: 'github',
    keyPrefix: GITHUB_PR_KEY_PREFIX,
    ui: {
        label: { en: 'GitHub', ru: 'GitHub' },
        webAction: { en: 'Open on GitHub', ru: 'Открыть на GitHub' },
        drafts: 'pr',
        iterations: 'pr',
    },
    make: (prKey, options) => {
        const ref = parseGithubPrKey(prKey);
        if (ref === null) {
            return null;
        }
        const host = makeGithubHost({ ...ref, sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR });
        return {
            host,
            currentUser: () => host.currentUser(),
            watchStatus: (onChange) => host.watchStatus(onChange),
        };
    },
};
