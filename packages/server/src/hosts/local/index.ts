import { localIterationsDirOf, localReviewPathFor } from '../../paths.js';


import { gitVcs } from './git-vcs.js';
import { fileIterationsStore } from './iterations-store.js';
import { LocalHost } from './local-host.js';
import type { LocalHostState } from './state.js';
import { readLocalHostState, writeLocalHostState } from './state.js';
import { fileThreadsStore } from './threads-store.js';
import type { LocalVcs, LocalVcsKind } from './vcs.js';
import { commandRunnerIn } from './vcs.js';

export { LocalHost } from './local-host.js';
export type { LocalHostOptions } from './local-host.js';
export { readLocalHostState, writeLocalHostState } from './state.js';
export type { LocalHostState } from './state.js';

export interface LocalHostSetup {
    readonly prKey: string;
    /** The key prefix names the VCS behind it. */
    readonly vcs: LocalVcsKind;
    readonly sherpaDir: string;
    /** Project directory from `--repo`. If null, use the saved key state. */
    readonly repo: string | null;
    /** Base from `--base`. Used only together with `--repo`. */
    readonly base: string | null;
    /** Branch from `--branch`, used by the CLI to build the key. If null, the first snapshot fixes it. */
    readonly branch: string | null;
    /** Review outcome instruction from `--verdicts`. Like the base, used only together with `--repo`. */
    readonly verdicts: string | null;
}

/**
 * Local review host for a `local-<vcs>-*` key. The project directory comes from `--repo`
 * (and is saved then), or from state saved by the previous run. Without either source,
 * there is no host.
 */
export function makeLocalHost(setup: LocalHostSetup): LocalHost | null {
    const stored = readLocalHostState(setup.sherpaDir, setup.prKey);
    const state = resolveState(setup, stored);
    if (state === null) {
        return null;
    }
    if (setup.repo !== null) {
        writeLocalHostState(setup.sherpaDir, setup.prKey, state);
    }

    // The branch and instruction are saved at different times. Each write starts from the last saved
    // state, and a failed write does not advance it.
    let current = state;
    const persist = (patch: Partial<LocalHostState>): void => {
        const next = { ...current, ...patch };
        writeLocalHostState(setup.sherpaDir, setup.prKey, next);
        current = next;
    };

    return new LocalHost({
        prKey: setup.prKey,
        vcs: vcsIn(setup.vcs, state.repo),
        projectDir: state.repo,
        base: state.base,
        branch: state.branch,
        verdicts: state.verdicts,
        threads: fileThreadsStore(localReviewPathFor(setup.sherpaDir, setup.prKey)),
        iterations: fileIterationsStore(localIterationsDirOf(setup.sherpaDir, setup.prKey)),
        onBranchResolved: (branch) => {
            persist({ branch });
        },
        onVerdictsChanged: (verdicts) => {
            persist({ verdicts });
        },
    });
}

/** VCS backend that works with the project directory. */
function vcsIn(kind: LocalVcsKind, repo: string): LocalVcs {
    const run = commandRunnerIn(kind, repo);
    return gitVcs(run);
}

/**
 * The key branch survives restarts. Normally the CLI supplies it (`--branch`): it built the key
 * from that branch, and the checkout may switch between `up` and the first snapshot. Without the flag,
 * use the previous run's branch, or let the first snapshot fix it if none was saved.
 */
function resolveState(setup: LocalHostSetup, stored: LocalHostState | null): LocalHostState | null {
    if (setup.repo === null) {
        return stored;
    }
    return {
        repo: setup.repo,
        branch: setup.branch ?? (stored?.repo === setup.repo ? stored.branch : null),
        base: setup.base,
        // Each `up --local` supplies the instruction. Without the flag, the mode is disabled. The last call wins.
        verdicts: setup.verdicts,
    };
}
