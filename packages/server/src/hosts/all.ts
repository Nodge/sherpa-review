import type { FeedbackChannelFactory } from '../feedback-channel.js';
import { linkFeedbackChannel } from '../feedback-channel.js';
import { NpmUpdateChannel } from '../npm-update-channel.js';
import type { UpdateChannel } from '../update-channel.js';

import { fixtureHostPlugin } from './fixture/plugin.js';
import { githubHostPlugin } from './github/plugin.js';
import { localGitHostPlugin } from './local/git-plugin.js';
import type { HostPlugin } from './plugin.js';

/** npm package name. */
const NPM_PACKAGE = 'sherpa-review';

/** Sherpa repository on GitHub. */
const GITHUB_REPO = 'nodge/sherpa-review';

/**
 * Server build composition root: the only place that names host plugins, the update channel
 * and the feedback channel. Only entry points (`bundle.ts`, `dev.ts`) and tests import it.
 */
export const ALL_HOSTS: readonly HostPlugin[] = [githubHostPlugin, localGitHostPlugin, fixtureHostPlugin];

/** Update channel: the package `latest` tag in the npm registry. */
export const UPDATE_CHANNEL: UpdateChannel = new NpmUpdateChannel(NPM_PACKAGE);

/** Feedback channel: the button opens GitHub repository issues. */
export const FEEDBACK_CHANNEL: FeedbackChannelFactory = () =>
    linkFeedbackChannel(`https://github.com/${GITHUB_REPO}/issues`);
