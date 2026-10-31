import { localHostName, localPrKeyPrefix } from '@sherpa/protocol';

import { DEFAULT_SHERPA_DIR } from '../../paths.js';
import type { HostPlugin } from '../plugin.js';

import { makeLocalHost, readLocalHostState } from './index.js';
import type { LocalVcs } from './vcs.js';

/**
 * Local review plugin `local-<vcs>-<directory>-<hash>` over the shared `LocalHost`: the key prefix
 * names the VCS type, and its VCS plugin supplies the backend for the project directory.
 */
export function localHostPlugin(kind: string, vcs: (repo: string) => LocalVcs): HostPlugin {
    return {
        name: localHostName(kind),
        keyPrefix: localPrKeyPrefix(kind),
        ui: {
            label: { en: 'local checkout', ru: 'локальный чекаут' },
            webAction: null,
            drafts: 'agent',
            iterations: 'tree',
        },
        make: (prKey, options) => {
            const host = makeLocalHost({
                prKey,
                vcs,
                sherpaDir: options.sherpaDir ?? DEFAULT_SHERPA_DIR,
                repo: options.repo ?? null,
                base: options.base ?? null,
                branch: options.branch ?? null,
                verdicts: options.verdicts ?? null,
            });
            if (host === null) {
                return null;
            }
            return {
                host,
                currentUser: () => host.currentUser(),
                refresh: () => host.refresh(),
                setLocalVerdicts: (instruction) => host.setVerdicts(instruction),
                feedback: host,
            };
        },
        unconfigured: (prKey, options) =>
            (options.repo ?? null) === null &&
            readLocalHostState(options.sherpaDir ?? DEFAULT_SHERPA_DIR, prKey) === null
                ? `key ${prKey} is local, but neither --repo nor saved local-host.json is available. ` +
                  'Run `sherpa-review up --local <path>` from the project directory'
                : null,
    };
}
