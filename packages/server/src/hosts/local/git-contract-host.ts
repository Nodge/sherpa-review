import type { GitFixture } from './git-fixture.js';
import { copyGitRepo, makeGitRepo } from './git-fixture.js';
import { GIT_PR_KEY } from './git-project.js';
import { gitVcs } from './git-vcs.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';
import { commandRunnerIn } from './vcs.js';

/**
 * A local host using real `git` for the `ReviewHost` contract suite. A working tree with every
 * file kind is prepared once and copied for each host. A "push" here means editing a file
 * in the working tree and forcing a poll.
 */

const TOUCHED_FILE = 'src/service.ts';

/** Tests do not need a polling timer. Only `refresh` advances the snapshot. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

export interface GitContractHosts {
    /** Host on a fresh copy of the tree. `verdicts` is the instruction for `--verdicts` mode. */
    readonly makeHost: (verdicts?: string | null) => LocalHost;
    readonly advance: (host: LocalHost) => Promise<void>;
    /** Removes the copies and template. Called in `afterAll`. */
    readonly cleanup: () => void;
}

export function gitContractHosts(): GitContractHosts {
    const repos: GitFixture[] = [];
    const fixtures = new WeakMap<LocalHost, GitFixture>();
    let template: GitFixture | null = null;

    return {
        makeHost: (verdicts = null) => {
            template ??= seededTemplate();
            const repo = copyGitRepo(template, 'sherpa-git-contract-');
            repos.push(repo);

            const host = new LocalHost({
                prKey: GIT_PR_KEY,
                vcs: gitVcs(commandRunnerIn('git', repo.root)),
                projectDir: repo.root,
                base: null,
                branch: 'feature',
                verdicts,
                threads: memoryThreadsStore(),
                iterations: memoryIterationsStore(),
                pollIntervalMs: POLL_INTERVAL_MS,
            });
            fixtures.set(host, repo);
            return host;
        },
        advance: async (host) => {
            const repo = fixtures.get(host);
            if (repo === undefined) {
                throw new Error('git repository for the host not found');
            }
            repo.write(TOUCHED_FILE, service(7070));
            await host.refresh();
        },
        cleanup: () => {
            for (const repo of repos.splice(0)) {
                repo.cleanup();
            }
            template?.cleanup();
            template = null;
        },
    };
}

/** Working tree with every file kind: modified, added, deleted, image and untracked. */
function seededTemplate(): GitFixture {
    const repo = makeGitRepo('sherpa-git-template-');
    repo.write(TOUCHED_FILE, service(8080));
    repo.write('src/legacy.ts', 'export const legacy = true;\n');
    repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    repo.commitAll('base');
    repo.git('checkout', '-b', 'feature');

    repo.write(TOUCHED_FILE, service(9090));
    repo.remove('src/legacy.ts');
    repo.write('src/fresh.ts', 'export const fresh = 1;\n');
    repo.git('add', 'src/fresh.ts');
    repo.write('assets/logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));
    repo.write('notes.md', '# notes\n\nlocal only\n');
    repo.write('cache.bin', Buffer.from([0x01, 0x00, 0x02]));
    // Set the base branch through origin/HEAD so one command finds it without trying alternatives.
    repo.git('update-ref', 'refs/remotes/origin/main', 'main');
    repo.git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    return repo;
}

function service(port: number): string {
    return `${['export function serve() {', `    const port = ${String(port)};`, '    listen(port);', '    log("up");', '}'].join('\n')}\n`;
}
