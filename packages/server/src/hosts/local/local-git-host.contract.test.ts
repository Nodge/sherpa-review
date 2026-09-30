import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';

import type { GitFixture } from './git-fixture.js';
import { copyGitRepo, gitAvailable, makeGitRepo } from './git-fixture.js';
import { gitVcs } from './git-vcs.js';
import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';
import { commandRunnerIn } from './vcs.js';

/**
 * `ReviewHost` contract suite on the local host with the `git` backend: real `git` in a temporary
 * repository. A "push" here means editing a working-tree file and forcing a poll.
 */

const TOUCHED_FILE = 'src/service.ts';

/** Tests do not need a polling timer. Only `refresh` advances the snapshot. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

const repos: GitFixture[] = [];
const fixtures = new WeakMap<LocalHost, GitFixture>();

/** The suite working tree is prepared once. Each test gets a copy. */
let template: GitFixture | null = null;

afterAll(() => {
    for (const repo of repos.splice(0)) {
        repo.cleanup();
    }
    template?.cleanup();
    template = null;
});

function makeHost(): LocalHost {
    template ??= seededTemplate();
    const repo = copyGitRepo(template, 'sherpa-git-contract-');
    repos.push(repo);

    const host = new LocalHost({
        prKey: 'local-git-app-0badc0de',
        vcs: gitVcs(commandRunnerIn('git', repo.root)),
        projectDir: repo.root,
        base: null,
        branch: 'feature',
        threads: memoryThreadsStore(),
        iterations: memoryIterationsStore(),
        pollIntervalMs: POLL_INTERVAL_MS,
    });
    fixtures.set(host, repo);
    return host;
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

describeReviewHostContract('LocalHost/git', makeHost, {
    // `user.name` from the temporary repository configuration (`git-fixture.ts`).
    viewer: 'Sherpa Tester',
    slow: true,
    skip: !gitAvailable,
    advance: async (host) => {
        const repo = fixtures.get(host);
        if (repo === undefined) {
            throw new Error('git repository for the host was not found');
        }
        repo.write(TOUCHED_FILE, service(7070));
        await host.refresh();
    },
});
