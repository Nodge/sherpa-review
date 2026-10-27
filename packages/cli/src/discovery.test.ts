import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { PROTOCOL_VERSION } from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CommandRunner } from './command.js';
import { connect, resolvePrKey, resolveWorkerId } from './discovery.js';
import { CliError } from './errors.js';
import type { CliHostPlugin } from './hosts/plugin.js';
import { manifestPathFor, sherpaDirFrom, workerIdPathFor } from './paths.js';

const PR_KEY = 'pr-777';

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
        const run: CommandRunner = () => Promise.reject(new Error('plugins do not run commands in these tests'));

        /** Plugin that finds the current branch's PR or explains why it can't. */
        function discovering(name: string, found: string | null, calls: string[] = []): CliHostPlugin {
            return {
                name,
                discoverPr: {
                    discover: () => {
                        calls.push(name);
                        return Promise.resolve(
                            found === null
                                ? { kind: 'unavailable', hint: `${name}: no checkout` }
                                : { kind: 'found', prKey: found },
                        );
                    },
                    suggestion: `run it from a ${name} checkout`,
                },
            };
        }

        /** Plugin that recognizes input with the `<name>:` prefix and turns it into a key. */
        function normalizing(name: string): CliHostPlugin {
            return {
                name,
                normalizeKey: (input) =>
                    input.startsWith(`${name}:`) ? `${name}-${input.slice(name.length + 1)}` : null,
            };
        }

        it('comes from the flag, otherwise from SHERPA_PR', async () => {
            const hosts = [discovering('vcs', 'vcs-3')];

            await expect(resolvePrKey('pr-1', { SHERPA_PR: 'pr-2' }, hosts, run)).resolves.toBe('pr-1');
            await expect(resolvePrKey(undefined, { SHERPA_PR: 'pr-2' }, hosts, run)).resolves.toBe('pr-2');
        });

        it('with neither set, uses the current branch PR from the first plugin that finds it', async () => {
            const calls: string[] = [];
            const hosts = [
                discovering('one', null, calls),
                discovering('two', 'two-7', calls),
                discovering('three', 'three-8', calls),
            ];

            await expect(resolvePrKey(undefined, {}, hosts, run)).resolves.toBe('two-7');
            await expect(resolvePrKey(undefined, { SHERPA_PR: '  ' }, hosts, run)).resolves.toBe('two-7');
            expect(calls).toEqual(['one', 'two', 'one', 'two']);
        });

        it('failed discovery asks for the skill and --pr, with plugin reasons and hints', async () => {
            const hosts = [discovering('one', null), normalizing('other'), discovering('two', null)];

            const error = await resolvePrKey(undefined, {}, hosts, run).catch((caught: unknown) => caught);

            expect(error).toBeInstanceOf(CliError);
            expect((error as CliError).message).toBe(
                'sherpa: it is unclear which PR to connect to.\n' +
                    'Tried to detect it from the current directory: one: no checkout; two: no checkout.\n' +
                    'Run the command through the Sherpa skill (it fills the PR in), pass `--pr <pr key>`, ' +
                    'run it from a one checkout, or run it from a two checkout.',
            );
        });

        it('without plugins supporting discovery, asks for the skill and --pr', async () => {
            await expect(resolvePrKey(undefined, {}, [normalizing('other')], run)).rejects.toThrow(
                'Sherpa cannot detect the PR of the current directory.\n' +
                    'Run the command through the Sherpa skill (it fills the PR in), or pass `--pr <pr key>`.',
            );
        });

        it('first plugin to recognize a link or number converts it to a key before any checks', async () => {
            const hosts = [normalizing('one'), normalizing('two'), discovering('vcs', 'vcs-3')];

            await expect(resolvePrKey('two:42', {}, hosts, run)).resolves.toBe('two-42');
            await expect(resolvePrKey(undefined, { SHERPA_PR: 'one:9' }, hosts, run)).resolves.toBe('one-9');
            // If no plugin recognizes it, pass the value through unchanged.
            await expect(resolvePrKey('pr-42', {}, hosts, run)).resolves.toBe('pr-42');
        });

        it('rejects a key that escapes the state directory', async () => {
            await expect(resolvePrKey('../../etc', {}, [], run)).rejects.toThrow('invalid PR key');
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

            const connection = await connect(PR_KEY, env, []);

            expect(connection).toMatchObject({ prKey: PR_KEY, port: 49152, token: 'secret' });
            expect(connection.workerId).not.toBe('');
        });

        it('missing manifest, invalid JSON, wrong schema or another PR produce one clear error', async () => {
            await expect(connect(PR_KEY, env, [])).rejects.toThrow('not found or not responding');

            const manifestPath = manifestPathFor(sherpaDir, PR_KEY);
            await fs.mkdir(path.dirname(manifestPath), { recursive: true });
            await fs.writeFile(manifestPath, '{not json');
            await expect(connect(PR_KEY, env, [])).rejects.toThrow('not found or not responding');

            await writeManifest({ port: 0 });
            await expect(connect(PR_KEY, env, [])).rejects.toThrow('not found or not responding');

            await writeManifest({ prKey: 'pr-778' });
            await expect(connect(PR_KEY, env, [])).rejects.toThrow('not found or not responding');
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
