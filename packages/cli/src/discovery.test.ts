import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { connect, resolvePrKey, resolveWorkerId } from './discovery.js';
import { CliError } from './errors.js';
import { manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';

const PR_KEY = 'github-quillmart--quillmart--777';

describe('discovery', () => {
    let sherpaDir: string;
    let env: Record<string, string | undefined>;

    beforeEach(async () => {
        sherpaDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-cli-'));
        env = { SHERPA_DIR: sherpaDir };
    });

    afterEach(async () => {
        await fs.rm(sherpaDir, { recursive: true, force: true });
    });

    async function writeManifest(overrides: Record<string, unknown> = {}): Promise<void> {
        const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
        await fs.mkdir(path.dirname(manifestPath), { recursive: true });
        await fs.writeFile(
            manifestPath,
            JSON.stringify({
                prKey: PR_KEY,
                port: 49152,
                pid: process.pid,
                token: 'secret',
                protocolVersion: PROTOCOL_VERSION,
                serverVersion: '0.0.0',
                createdAt: new Date().toISOString(),
                ...overrides,
            }),
        );
    }

    describe('PR key', () => {
        it('uses the flag, otherwise SHERPA_PR', () => {
            expect(resolvePrKey('github-quillmart--quillmart--1', { SHERPA_PR: 'github-quillmart--quillmart--2' })).toBe('github-quillmart--quillmart--1');
            expect(resolvePrKey(undefined, { SHERPA_PR: 'github-quillmart--quillmart--2' })).toBe('github-quillmart--quillmart--2');
        });

        it('without either, asks to launch through the skill or pass --pr', () => {
            expect(() => resolvePrKey(undefined, {})).toThrow(CliError);
            expect(() => resolvePrKey(undefined, { SHERPA_PR: '  ' })).toThrow('--pr');
        });

        it('rejects a key that escapes the state directory', () => {
            expect(() => resolvePrKey('../../etc', {})).toThrow('invalid PR key');
        });
    });

    describe('state root', () => {
        it('SHERPA_DIR overrides ~/.sherpa', () => {
            expect(sherpaDirFrom({ SHERPA_DIR: '/tmp/x' })).toBe('/tmp/x');
            expect(sherpaDirFrom({})).toBe(path.join(os.homedir(), '.sherpa'));
        });
    });

    describe('manifest', () => {
        it('provides the server port and token', async () => {
            await writeManifest();

            const connection = await connect(PR_KEY, env);

            expect(connection).toMatchObject({ prKey: PR_KEY, port: 49152, token: 'secret' });
            expect(connection.workerId).not.toBe('');
        });

        it('missing manifest, invalid JSON, wrong schema or another PR produce one clear error', async () => {
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(path.dirname(manifestPath), { recursive: true });
            await fs.writeFile(manifestPath, '{not json');
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            await writeManifest({ port: 0 });
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');

            await writeManifest({ prKey: 'github-quillmart--quillmart--778' });
            await expect(connect(PR_KEY, env)).rejects.toThrow('not found or not responding');
        });
    });

    describe('worker identity', () => {
        it('is created once and survives subsequent calls', async () => {
            const first = await resolveWorkerId(sherpaDir, PR_KEY, env);
            const second = await resolveWorkerId(sherpaDir, PR_KEY, env);

            expect(first).toBe(second);
            expect((await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim()).toBe(first);
        });

        it('parallel first calls get the same id', async () => {
            const [first, second] = await Promise.all([
                resolveWorkerId(sherpaDir, PR_KEY, env),
                resolveWorkerId(sherpaDir, PR_KEY, env),
            ]);

            expect(first).toBe(second);
            expect((await fs.readFile(workerIdPathFor(sherpaDir, PR_KEY), 'utf8')).trim()).toBe(first);
        });

        it('file is accessible only to its owner', async () => {
            await resolveWorkerId(sherpaDir, PR_KEY, env);

            const stats = await fs.stat(workerIdPathFor(sherpaDir, PR_KEY));

            expect(stats.mode & 0o777).toBe(0o600);
        });

        it('SHERPA_WORKER_ID overrides the file and writes nothing', async () => {
            const workerId = await resolveWorkerId(sherpaDir, PR_KEY, { ...env, SHERPA_WORKER_ID: 'w-debug' });

            expect(workerId).toBe('w-debug');
            await expect(fs.stat(workerIdPathFor(sherpaDir, PR_KEY))).rejects.toThrow();
        });
    });
});
