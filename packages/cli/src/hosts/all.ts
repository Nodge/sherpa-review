import { gitCliHost } from './git.js';
import { githubCliHost } from './github.js';
import type { CliHostPlugin } from './plugin.js';

/**
 * CLI host composition root. The only place that lists plugins by name.
 * Only the entry point (`index.ts`) and tests import it.
 */
export const CLI_HOSTS: readonly CliHostPlugin[] = [githubCliHost, gitCliHost];
