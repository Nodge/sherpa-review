import { gitVcs } from './git-vcs.js';
import { localHostPlugin } from './plugin.js';
import { commandRunnerIn } from './vcs.js';

/** Local review of a git repository working tree. */
export const localGitHostPlugin = localHostPlugin('git', (repo) => gitVcs(commandRunnerIn('git', repo)));
