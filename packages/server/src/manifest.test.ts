import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { PROTOCOL_VERSION } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    claimManifest,
    cleanStaleManifests,
    isManifestServerAlive,
    isProcessAlive,
    readManifest,
    releaseStaleManifest,
    removeOwnManifest,
} from './manifest.js';
import { manifestPathFor, serversDirOf } from './paths.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { deadPid, makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';
import { SERVER_VERSION } from './version.js';

function manifestFor(overrides: Partial<ServerManifest> = {}): ServerManifest {
    return {
        prKey: 'github-quillmart--quillmart--1',
        port: 65000,
        pid: process.pid,
        token: 'token',
        protocolVersion: PROTOCOL_VERSION,
        serverVersion: SERVER_VERSION,
        createdAt: new Date().toISOString(),
        ...overrides,
    };
}

describe('manifest', () => {
    let sherpaDir: string;
    let serversDir: string;
    const servers: SherpaServer[] = [];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        serversDir = serversDirOf(sherpaDir);
        await fs.mkdir(serversDir, { recursive: true });
    });

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    it('writes atomically and leaves no temporary files', async () => {
        const target = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1');
        const manifest = manifestFor();
        expect(await claimManifest(target, manifest)).toBe(true);

        expect(await fs.readdir(serversDir)).toEqual(['github-quillmart--quillmart--1.json']);
        expect(await readManifest(target)).toEqual(manifest);
    });

    it('returns false from claimManifest without changing an occupied path', async () => {
        const target = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1');
        const occupant = manifestFor({ port: 65010 });
        await claimManifest(target, occupant);

        expect(await claimManifest(target, manifestFor({ port: 65011 }))).toBe(false);
        expect(await readManifest(target)).toEqual(occupant);
        expect(await fs.readdir(serversDir)).toEqual(['github-quillmart--quillmart--1.json']);
    });

    describe('releaseStaleManifest', () => {
        it('removes the stale manifest used for the decision', async () => {
            const target = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1');
            const stale = manifestFor({ pid: await deadPid() });
            await claimManifest(target, stale);

            await releaseStaleManifest(target, stale);

            expect(await fs.readdir(serversDir)).toEqual([]);
        });

        it('keeps a manifest replaced between the check and removal', async () => {
            const target = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1');
            const stale = manifestFor({ port: 65010, pid: await deadPid() });
            const fresh = manifestFor({ port: 65011 });
            await claimManifest(target, fresh);

            await releaseStaleManifest(target, stale);

            expect(await readManifest(target)).toEqual(fresh);
            expect(await fs.readdir(serversDir)).toEqual(['github-quillmart--quillmart--1.json']);
        });

        it('does nothing when no file exists at the path', async () => {
            await releaseStaleManifest(manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1'), manifestFor());

            expect(await fs.readdir(serversDir)).toEqual([]);
        });
    });

    it('treats malformed JSON and files that fail the schema as absent', async () => {
        const broken = path.join(serversDir, 'broken.json');
        const wrongShape = path.join(serversDir, 'wrong.json');
        await fs.writeFile(broken, '{not json');
        await fs.writeFile(wrongShape, JSON.stringify({ prKey: 'github-quillmart--quillmart--1', port: 0 }));

        expect(await readManifest(broken)).toBeNull();
        expect(await readManifest(wrongShape)).toBeNull();
        expect(await readManifest(path.join(serversDir, 'does-not-exist.json'))).toBeNull();
    });

    it('keeps a manifest overwritten by another server in removeOwnManifest', async () => {
        const target = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--1');
        const mine = manifestFor({ port: 65001 });
        await claimManifest(target, manifestFor({ port: 65002 }));

        await removeOwnManifest(target, mine);
        expect(await readManifest(target)).not.toBeNull();

        await fs.rm(target);
        await claimManifest(target, mine);
        await removeOwnManifest(target, mine);
        expect(await readManifest(target)).toBeNull();
    });

    describe('cleanStaleManifests', () => {
        it('removes manifests of dead processes and garbage but keeps a live one', async () => {
            const live = await startServer({ prKey: 'github-quillmart--quillmart--live', sherpaDir });
            servers.push(live);

            const stale = manifestPathFor(sherpaDir, 'github-quillmart--quillmart--stale');
            await claimManifest(stale, manifestFor({ prKey: 'github-quillmart--quillmart--stale', pid: await deadPid() }));
            const garbage = path.join(serversDir, 'garbage.json');
            await fs.writeFile(garbage, 'not a manifest at all');
            const foreign = path.join(serversDir, 'readme.txt');
            await fs.writeFile(foreign, 'not .json, not our concern');

            const removed = await cleanStaleManifests(serversDir);

            expect(removed.sort()).toEqual([garbage, stale].sort());
            expect(await fs.readdir(serversDir)).toEqual(expect.arrayContaining(['github-quillmart--quillmart--live.json', 'readme.txt']));
            expect(await readManifest(manifestPathFor(sherpaDir, 'github-quillmart--quillmart--live'))).not.toBeNull();
        });

        it('handles a missing directory without failing', async () => {
            expect(await cleanStaleManifests(path.join(sherpaDir, 'no-directory'))).toEqual([]);
        });
    });

    describe('server liveness from the manifest', () => {
        it('returns its own prKey from a live server', async () => {
            const live = await startServer({ prKey: 'github-quillmart--quillmart--live', sherpaDir });
            servers.push(live);
            const manifest = await readManifest(manifestPathFor(sherpaDir, 'github-quillmart--quillmart--live'));
            if (manifest === null) {
                throw new Error('live server did not write a manifest');
            }

            expect(await isManifestServerAlive(manifest)).toBe(true);
        });

        it('treats a live PID with no server on the port as not live', async () => {
            expect(await isManifestServerAlive(manifestFor({ pid: process.pid, port: 65123 }))).toBe(false);
        });

        it('treats a dead PID as not live without using the network', async () => {
            const pid = await deadPid();

            expect(isProcessAlive(pid)).toBe(false);
            expect(await isManifestServerAlive(manifestFor({ pid }))).toBe(false);
        });
    });
});
