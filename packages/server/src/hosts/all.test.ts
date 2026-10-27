import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { FixtureHost, GALLERY_HOSTS } from '@sherpa/fixtures';
import { uiReviewHostSchema } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { ALL_HOSTS } from './all.js';
import { selectReviewHost, unconfiguredHostReason } from './select.js';

/**
 * Built-in plugins by key. Hosts are only constructed here: they touch neither the network nor disk
 * until the first method call.
 */

const SHERPA_DIR = path.join(os.tmpdir(), 'sherpa-select-test');

function select(prKey: string, options: { repo?: string; sherpaDir?: string } = {}) {
    return selectReviewHost(prKey, { sherpaDir: SHERPA_DIR, ...options }, ALL_HOSTS);
}

describe('built-in hosts', () => {
    it('uses non-overlapping plugin prefixes', () => {
        for (const plugin of ALL_HOSTS) {
            const others = ALL_HOSTS.filter((other) => other !== plugin);
            const overlaps = others.some(
                (other) => other.keyPrefix.startsWith(plugin.keyPrefix) || plugin.keyPrefix.startsWith(other.keyPrefix),
            );
            expect(overlaps, plugin.name).toBe(false);
        }
    });

    it('validates each host UI description against the schema and sends local review drafts to the agent', () => {
        for (const plugin of ALL_HOSTS) {
            expect(() => uiReviewHostSchema.parse({ id: plugin.name, ...plugin.ui }), plugin.name).not.toThrow();
            const local = plugin.name.startsWith('local-');
            expect(plugin.ui.drafts, plugin.name).toBe(local ? 'agent' : 'pr');
            expect(plugin.ui.iterations, plugin.name).toBe(local ? 'tree' : 'pr');
        }
    });

    it('uses the same host data in the gallery, UI tests and plugins', () => {
        for (const host of Object.values(GALLERY_HOSTS)) {
            const plugin = ALL_HOSTS.find((candidate) => candidate.name === host.id);
            expect(plugin === undefined ? null : { id: plugin.name, ...plugin.ui }, host.id).toEqual(host);
        }
    });

    it('creates a GitHub host with whoami and status subscription for a GitHub key', () => {
        const selected = select('github-acme--ui--kit--42');

        expect(selected?.name).toBe('github');
        expect(selected?.currentUser).toBeDefined();
        expect(selected?.watchStatus).toBeDefined();
        // GitHub has no iterations, so it has neither a dev "push" nor feedback rounds.
        expect(selected?.advanceIteration).toBeUndefined();
        expect(selected?.feedback).toBeUndefined();
    });

    it('does not create a host for an invalid GitHub key', () => {
        for (const key of ['github-acme--sherpa', 'github-acme--sherpa--0', 'github---sherpa--1']) {
            expect(select(key), key).toBeNull();
        }
    });

    it('creates a local host for a local git review key only with a project directory', () => {
        const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-select-repo-'));
        const sherpaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sherpa-select-state-'));
        try {
            // Without `--repo` or saved key state, there is no source for the directory, and the plugin explains this.
            expect(select('local-git-app-0badc0de', { sherpaDir })).toBeNull();
            expect(unconfiguredHostReason('local-git-app-0badc0de', { sherpaDir }, ALL_HOSTS)).toContain(
                'neither --repo nor saved local-host.json',
            );

            const selected = select('local-git-app-0badc0de', { repo, sherpaDir });

            expect(selected?.name).toBe('local-git');
            expect(selected?.feedback).toBeDefined();
            expect(selected?.refresh).toBeDefined();
            expect(unconfiguredHostReason('local-git-app-0badc0de', { sherpaDir }, ALL_HOSTS)).toBeNull();
        } finally {
            fs.rmSync(repo, { recursive: true, force: true });
            fs.rmSync(sherpaDir, { recursive: true, force: true });
        }
    });

    it('accepts a fixture key only with a known fixture name', () => {
        expect(select('fixture-medium')?.name).toBe('fixture');
        expect(select('fixture-edge')?.host).toBeInstanceOf(FixtureHost);
        expect(select('fixture-unknown')).toBeNull();
    });

    it('leaves unknown prefixes unclaimed without an explanation', () => {
        expect(select('unknown-777')).toBeNull();
        expect(select('local-app-0badc0de')).toBeNull();
        expect(unconfiguredHostReason('unknown-777', { sherpaDir: SHERPA_DIR }, ALL_HOSTS)).toBeNull();
    });
});
