import { describe, expect, it, vi } from 'vitest';

import { NpmUpdateChannel } from './npm-update-channel.js';

/** npm update channel with a mocked `fetch`: package document from the npm registry. */

const signal = new AbortController().signal;

const PACKUMENT = {
    name: 'sherpa-review',
    'dist-tags': { latest: '0.5.0', next: '0.6.0' },
    time: {
        created: '2026-08-01T10:00:00.000Z',
        '0.4.0': '2026-08-20T10:00:00.000Z',
        '0.5.0': '2026-09-01T09:00:00.000Z',
    },
};

function respondWith(body: string, status = 200) {
    return vi.fn((_input: string, _init?: RequestInit) => Promise.resolve(new Response(body, { status })));
}

async function latestOf(transport: ReturnType<typeof respondWith>, packageName = 'sherpa-review') {
    return new NpmUpdateChannel(packageName).latest({ fetch: transport as unknown as typeof fetch, signal });
}

describe('npm update channel', () => {
    it('reads the latest tag and its publication time', async () => {
        const transport = respondWith(JSON.stringify(PACKUMENT));

        expect(await latestOf(transport)).toEqual({
            version: '0.5.0',
            builtFrom: null,
            releasedAt: '2026-09-01T09:00:00.000Z',
            whatsNew: null,
        });
        const [url, init] = transport.mock.calls[0] ?? [];
        expect(url).toBe('https://registry.npmjs.org/sherpa-review');
        expect(init?.signal).toBe(signal);
    });

    it('URL-encodes the slash in the package scope', async () => {
        const transport = respondWith(JSON.stringify(PACKUMENT));

        await latestOf(transport, '@sherpa/cli');

        expect(transport.mock.calls[0]?.[0]).toBe('https://registry.npmjs.org/@sherpa%2Fcli');
    });

    it('returns an unknown version without an error for an unpublished package (404)', async () => {
        expect(await latestOf(respondWith('{"error":"Not found"}', 404))).toBeNull();
    });

    it('throws with the response status for other non-2xx responses', async () => {
        await expect(latestOf(respondWith('{}', 503))).rejects.toThrow('503');
    });

    it('returns a version without a release date when `time` is missing', async () => {
        const { time: _time, ...withoutTime } = PACKUMENT;

        expect((await latestOf(respondWith(JSON.stringify(withoutTime))))?.releasedAt).toBeNull();
    });

    it('returns a version without a release date when its time is not ISO', async () => {
        const odd = { ...PACKUMENT, time: { '0.5.0': 'yesterday' } };

        expect((await latestOf(respondWith(JSON.stringify(odd))))?.releasedAt).toBeNull();
    });

    it('throws on malformed JSON', async () => {
        await expect(latestOf(respondWith('{ not json'))).rejects.toThrow();
    });

    it('throws when dist-tags.latest is missing', async () => {
        await expect(latestOf(respondWith(JSON.stringify({ name: 'sherpa-review', versions: {} })))).rejects.toThrow();
    });

    it('throws when latest is not semver', async () => {
        const broken = { ...PACKUMENT, 'dist-tags': { latest: 'from-the-day-before-yesterday' } };

        await expect(latestOf(respondWith(JSON.stringify(broken)))).rejects.toThrow();
    });

    it('distinguishes packages by channel ID so the check cache recognises its own entry', () => {
        expect(new NpmUpdateChannel('sherpa-review').id).toBe('npm:sherpa-review');
        expect(new NpmUpdateChannel('@sherpa/cli').id).toBe('npm:@sherpa/cli');
    });

    it('provides only a package page link as the hint, with no command or directory', () => {
        const channel = new NpmUpdateChannel('sherpa-review');

        expect(channel.install()).toEqual({
            dir: null,
            command: null,
            readmeUrl: 'https://www.npmjs.com/package/sherpa-review',
        });
    });
});
