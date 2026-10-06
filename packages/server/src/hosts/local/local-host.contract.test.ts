import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll } from 'vitest';

import { describeReviewHostContract } from '../review-host-contract.js';



import { memoryIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import { memoryThreadsStore } from './threads-store.js';

/**
 * `ReviewHost` contract suite on the local host with a git backend over
 * a real temporary directory. A "push" means editing a working-tree file and forcing
 * a poll. The suite on real `git` is `local-git-host.contract.test.ts`.
 */

const PROJECT_PREFIX = 'app';
const TOUCHED_FILE = 'src/service.ts';

/** Tests do not need a polling timer. Only `refresh` advances the snapshot. */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

const checkouts: string[] = [];
const fakes = new WeakMap<LocalHost, FakeVcs>();

afterAll(() => {
    for (const dir of checkouts.splice(0)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

function makeHost(verdicts: string | null = null): LocalHost {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-'));
    checkouts.push(root);

    const fake = new FakeVcs({ root, prefix: PROJECT_PREFIX });
    seed(fake);

    const host = new LocalHost({
        prKey: 'local-git-app-0badc0de',
        vcs: scriptedVcs(fake.runner),
        projectDir: fake.projectDir,
        base: null,
        branch: fake.branch,
        verdicts,
        threads: memoryThreadsStore(),
        iterations: memoryIterationsStore(),
        pollIntervalMs: POLL_INTERVAL_MS,
    });
    fakes.set(host, fake);
    return host;
}

/** Working tree with every file kind: modified, added, deleted, image and untracked. */
function seed(fake: FakeVcs): void {
    const base = ['export function serve() {', '    const port = 8080;', '    listen(port);', '    log("up");', '}'];
    fake.commit(`${PROJECT_PREFIX}/${TOUCHED_FILE}`, `${base.join('\n')}\n`);
    fake.writeDisk(
        `${PROJECT_PREFIX}/${TOUCHED_FILE}`,
        `${['export function serve() {', '    const port = 9090;', '    listen(port);', '    log("up");', '}'].join('\n')}\n`,
    );

    fake.commit(`${PROJECT_PREFIX}/src/legacy.ts`, 'export const legacy = true;\n');
    fake.removeDisk(`${PROJECT_PREFIX}/src/legacy.ts`);

    fake.added.add(`${PROJECT_PREFIX}/src/fresh.ts`);
    fake.writeDisk(`${PROJECT_PREFIX}/src/fresh.ts`, 'export const fresh = 1;\n');

    // Image sides come from the base and disk. Blobs are addressed by content.
    fake.commit(`${PROJECT_PREFIX}/assets/logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    fake.writeDisk(`${PROJECT_PREFIX}/assets/logo.png`, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02]));

    fake.writeDisk(`${PROJECT_PREFIX}/notes.md`, '# notes\n\nlocal only\n');
    fake.writeDisk(`${PROJECT_PREFIX}/cache.bin`, Buffer.from([0x01, 0x00, 0x02]));

    // A file outside the project directory must not enter the diff.
    fake.commit('other/outside.ts', 'export const outside = 1;\n');
    fake.writeDisk('other/outside.ts', 'export const outside = 2;\n');
}

/** A local host "push": edit a working-tree file and force a poll. */
async function advance(host: LocalHost): Promise<void> {
    const fake = fakes.get(host);
    if (fake === undefined) {
        throw new Error('Fake git for the host was not found');
    }
    fake.writeDisk(
        `${PROJECT_PREFIX}/${TOUCHED_FILE}`,
        `${['export function serve() {', '    const port = 7070;', '    listen(port);', '    log("up");', '}'].join('\n')}\n`,
    );
    await host.refresh();
}

/** Default fake checkout login. */
const VIEWER = 'reviewer';

describeReviewHostContract('LocalHost/git', () => makeHost(), { viewer: VIEWER, advance });

// `--verdicts` mode: the same contract, with Request changes and Ship instead of Comment.
describeReviewHostContract('LocalHost/git --verdicts', () => makeHost('on ship, commit and open a PR'), {
    viewer: VIEWER,
    advance,
});
