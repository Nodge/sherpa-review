import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { localHostStatePathFor } from '../../paths.js';
import { selectReviewHost } from '../select.js';

import { makeLocalHost } from './index.js';
import { readLocalHostState, writeLocalHostState } from './state.js';

const PR_KEY = 'local-git-app-0badc0de';
const ON_SHIP = 'on ship, commit and open a PR';

describe('local review key state', () => {
    let sherpaDir: string;
    let repo: string;

    beforeEach(() => {
        sherpaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-state-'));
        repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-local-repo-'));
    });

    afterEach(() => {
        fs.rmSync(sherpaDir, { recursive: true, force: true });
        fs.rmSync(repo, { recursive: true, force: true });
    });

    function statePath(): string {
        return localHostStatePathFor(sherpaDir, PR_KEY);
    }

    // The CLI knows the branch: it built the key on it, and the checkout may change between `up` and the first snapshot.
    it('saves directory, branch and base when starting with --repo', () => {
        expect(
            makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: 'main~3', branch: 'feature', verdicts: null }),
        ).not.toBeNull();

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: 'feature', base: 'main~3', verdicts: null });
        expect(fs.statSync(statePath()).mode & 0o777).toBe(0o600);
    });

    it('leaves branch detection to the first snapshot when starting without --branch', () => {
        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: null, branch: null, verdicts: null })).not.toBeNull();

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: null, base: null, verdicts: null });
    });

    it('restores saved state when starting without --repo', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo: null, base: null, branch: null, verdicts: null })).not.toBeNull();
    });

    it('provides no host without --repo or saved state', () => {
        expect(makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo: null, base: null, branch: null, verdicts: null })).toBeNull();
        expect(selectReviewHost(PR_KEY, { sherpaDir })).toBeNull();
    });

    // The key binds directory and branch together: the branch cannot change under the same key.
    it('preserves the branch when starting again with the same directory', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: null, branch: null, verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)?.branch).toBe('feature');
    });

    it('does not inherit the branch from the previous directory when the directory changes', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo: '/elsewhere', branch: 'feature', base: null, verdicts: null });

        makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: null, branch: null, verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: null, base: null, verdicts: null });
    });

    it('preserves the instruction across restart from saved state', () => {
        makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: null, branch: 'feature', verdicts: ON_SHIP });
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe(ON_SHIP);

        const restarted = selectReviewHost(PR_KEY, { sherpaDir });

        // Same instruction: nothing to switch, as restart restored verdict mode.
        expect(restarted?.setLocalVerdicts?.(ON_SHIP)).toBe(false);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe(ON_SHIP);
    });

    it('disables verdict mode on repeated up --local without the flag', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: ON_SHIP });

        makeLocalHost({ prKey: PR_KEY, vcs: 'git', sherpaDir, repo, base: null, branch: 'feature', verdicts: null });

        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBeNull();
    });

    it('saves an instruction change on a running host, preserves the branch and restores it on restart', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: 'main~1', verdicts: null });
        const selected = selectReviewHost(PR_KEY, { sherpaDir });

        expect(selected?.setLocalVerdicts?.(ON_SHIP)).toBe(true);
        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({
            repo,
            branch: 'feature',
            base: 'main~1',
            verdicts: ON_SHIP,
        });

        // The mode is already enabled: no need to reread metadata, but the new instruction must reach disk.
        expect(selected?.setLocalVerdicts?.('on ship, merge into main')).toBe(false);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBe('on ship, merge into main');
        expect(selectReviewHost(PR_KEY, { sherpaDir })?.setLocalVerdicts?.('on ship, merge into main')).toBe(false);

        expect(selected?.setLocalVerdicts?.(null)).toBe(true);
        expect(readLocalHostState(sherpaDir, PR_KEY)?.verdicts).toBeNull();
    });

    it('reads state without the verdicts field as verdict mode disabled', () => {
        fs.mkdirSync(path.dirname(statePath()), { recursive: true });
        fs.writeFileSync(statePath(), JSON.stringify({ repo, branch: 'feature', base: null }));

        expect(readLocalHostState(sherpaDir, PR_KEY)).toEqual({ repo, branch: 'feature', base: null, verdicts: null });
    });

    it('rejects an empty instruction in the file through the schema, just like corrupt state', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: '   ' });

        expect(readLocalHostState(sherpaDir, PR_KEY)).toBeNull();
    });

    it('treats corrupt state as absent', () => {
        fs.mkdirSync(path.dirname(statePath()), { recursive: true });
        fs.writeFileSync(statePath(), '{"repo":42}');

        expect(readLocalHostState(sherpaDir, PR_KEY)).toBeNull();
    });

    it('a local-git-* key selects the local adapter with forced polling', () => {
        writeLocalHostState(sherpaDir, PR_KEY, { repo, branch: 'feature', base: null, verdicts: null });

        const selected = selectReviewHost(PR_KEY, { sherpaDir });

        expect(selected?.name).toBe('local-git');
        expect(typeof selected?.refresh).toBe('function');
        expect(selected?.advanceIteration).toBeUndefined();
    });

    // The server gets the VCS type from the key prefix: it has no separate flag.
    it('the local-git-* key selects the same adapter with the git backend', () => {
        const gitKey = 'local-git-app-0badc0de';
        writeLocalHostState(sherpaDir, gitKey, { repo, branch: 'feature', base: null, verdicts: null });

        expect(selectReviewHost(gitKey, { sherpaDir })?.name).toBe('local-git');
        // A key without a VCS type is not local and has no host.
        expect(selectReviewHost('local-app-0badc0de', { sherpaDir })).toBeNull();
    });
});
