import type { Lens } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubControl, MockGithubOptions } from './mock-transport.js';
import { makeMockGithubFetch, MOCK_NUMBER, MOCK_OWNER, MOCK_REPO } from './mock-transport.js';

/**
 * The GitHub host's ownership lens uses base-branch CODEOWNERS, the last matching rule,
 * and a separate query for the reviewer's teams. The transport uses a recorded API, with no live calls.
 */

const TOKEN = 'test-token-must-never-leak-42';

function makeHost(options: MockGithubOptions = {}): GithubHost {
    return new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: makeMockGithubFetch(options),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
}

/** A non-`null` lens. GitHub always has ownership, and this method does not disable the concept. */
async function ownership(options: MockGithubOptions = {}): Promise<Lens> {
    const lens = await makeHost(options).ownershipLens();
    if (lens === null) {
        throw new Error('The GitHub host must return an ownership lens');
    }
    return lens;
}

describe('GitHub adapter: ownership lens from CODEOWNERS', () => {
    it('builds PR zones from file rules and my files from the login', async () => {
        const lens = await ownership();

        expect(lens.id).toBe('mine');
        expect(lens.available).toBe(true);
        expect(lens.note).toBeNull();
        expect(lens.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
        expect(lens.zones).toEqual([
            {
                path: 'assets',
                mine: false,
                owner: 'bob',
                paths: ['assets/logo.png', 'assets/icon.svg', 'assets/huge.png'],
            },
            { path: 'docs', mine: false, owner: 'acme/docs-team', paths: ['docs/readme.md'] },
            {
                path: 'src',
                mine: true,
                owner: 'alice',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
    });

    it('keeps all lens files in mine zones and none in other zones', async () => {
        const lens = await ownership();
        const mine = new Set(lens.paths);
        const zoned = new Set((lens.zones ?? []).filter((zone) => zone.mine).flatMap((zone) => zone.paths));

        expect([...mine].every((path) => zoned.has(path))).toBe(true);
        expect(zoned.size).toBe(mine.size);
        for (const zone of lens.zones ?? []) {
            if (!zone.mine) {
                expect(zone.paths.some((path) => mine.has(path))).toBe(false);
            }
        }
    });

    it('counts a file owned by a reviewer team as mine', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '/docs/ @acme/core\n/src/ @acme/docs-team\n' },
            teams: { acme: ['core'] },
        });

        expect(lens.paths).toEqual(['docs/readme.md']);
        expect(lens.zones).toEqual([
            { path: 'docs', mine: true, owner: 'acme/core', paths: ['docs/readme.md'] },
            {
                path: 'src',
                mine: false,
                owner: 'acme/docs-team',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
    });

    it('uses logins for ownership and does not cache the lens when the teams query fails', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({
            calls,
            failing: { SherpaOrgTeams: 403 },
            codeowners: { '.github/CODEOWNERS': '/docs/ @acme/core\n/src/ @alice\n' },
        });

        const lens = await host.ownershipLens();
        expect(lens?.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
        expect(lens?.note).toBe(
            'GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.',
        );
        expect(lens?.zones?.map((zone) => [zone.path, zone.mine])).toEqual([
            ['docs', false],
            ['src', true],
        ]);

        await host.ownershipLens();
        expect(calls.get('SherpaOrgTeams')).toBe(2);
    });

    it('does not count teams as mine when the token cannot see their organization', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '* @other-org/core\n' },
            teams: {},
        });

        expect(lens.available).toBe(false);
        expect(lens.note).toBe(
            'No files of this PR are in your CODEOWNERS zones. GitHub did not tell which teams you are in (read:org scope?): ownership by team is not counted.',
        );
        // The `*` pattern has no static prefix, so the file's top-level directory becomes its zone.
        expect(lens.zones?.map((zone) => zone.path)).toEqual(['assets', 'docs', 'src']);
    });

    it('disables the lens with an explanation when CODEOWNERS is absent from all 3 locations', async () => {
        const lens = await ownership({ codeowners: {} });

        expect(lens).toEqual({
            id: 'mine',
            label: 'My files',
            paths: [],
            available: false,
            note: 'This repository has no CODEOWNERS file.',
            zones: null,
            audit: null,
        });
    });

    it('handles a file that exists but has no rules', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '# only a comment\n\n' } });

        expect(lens.note).toBe('CODEOWNERS has no rules.');
        expect(lens.zones).toBeNull();
    });

    it('prefers the file in `.github` even when a root file exists', async () => {
        const lens = await ownership({
            codeowners: { '.github/CODEOWNERS': '/src/ @alice\n', CODEOWNERS: '* @bob\n' },
        });

        expect(lens.paths).toEqual(['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts']);
    });

    it('clears ownership for a rule without owners and leaves its files outside zones', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '* @alice\n/src/bundle.js\n' } });

        expect(lens.paths).not.toContain('src/bundle.js');
        expect((lens.zones ?? []).flatMap((zone) => zone.paths)).not.toContain('src/bundle.js');
        expect(lens.zones?.map((zone) => zone.path)).toEqual(['assets', 'docs', 'src']);
    });

    it('disables the lens when none of the files are mine but keeps other zones', async () => {
        const lens = await ownership({ codeowners: { CODEOWNERS: '* @bob\n' } });

        expect(lens.available).toBe(false);
        expect(lens.paths).toEqual([]);
        expect(lens.note).toBe('No files of this PR are in your CODEOWNERS zones.');
        expect(lens.zones?.every((zone) => !zone.mine)).toBe(true);
        expect(lens.zones?.flatMap((zone) => zone.paths).length).toBe(9);
    });

    it('reduces lens functionality without caching it when CODEOWNERS cannot be read', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls, failing: { SherpaCodeowners: 500 } });

        const lens = await host.ownershipLens();
        expect(lens?.available).toBe(false);
        expect(lens?.zones).toBeNull();
        // The reviewer gets a message about the file. The query name and response code stay in server.log.
        expect(lens?.note).toBe('GitHub could not read the CODEOWNERS file of this repository.');

        await host.ownershipLens();
        expect(calls.get('SherpaCodeowners')).toBe(2);
    });

    it('caches the lens by branch head and recalculates it after a push', async () => {
        const calls = new Map<string, number>();
        const control: MockGithubControl = {};
        const host = makeHost({ calls, control });

        await host.ownershipLens();
        await host.ownershipLens();
        expect(calls.get('rest:files')).toBe(1);
        expect(calls.get('SherpaCodeowners')).toBe(1);

        control.push?.();
        await host.ownershipLens();
        expect(calls.get('rest:files')).toBe(2);
        // The owners file lives on the PR base, so a push does not touch it.
        expect(calls.get('SherpaCodeowners')).toBe(1);
    });

    it('rereads owners from the new base commit when the base advances without a push', async () => {
        const calls = new Map<string, number>();
        const control: MockGithubControl = {};
        const host = makeHost({ calls, control });

        expect((await host.ownershipLens())?.available).toBe(true);

        control.mergeIntoBase?.({ '.github/CODEOWNERS': '/src/ @bob\n' });
        const lens = await host.ownershipLens();

        expect(lens?.available).toBe(false);
        expect(lens?.zones).toEqual([
            {
                path: 'src',
                mine: false,
                owner: 'bob',
                paths: ['src/service.ts', 'src/legacy.ts', 'src/generated.bin', 'src/bundle.js', 'src/renamed.ts'],
            },
        ]);
        expect(calls.get('SherpaCodeowners')).toBe(2);
        // The diff file list depends on the branch head, which has not moved.
        expect(calls.get('rest:files')).toBe(1);
    });
});
