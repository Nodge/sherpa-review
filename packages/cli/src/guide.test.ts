import { describe, expect, it } from 'vitest';

import { run } from './cli.js';
import { formatDone, formatRpcError, startCommandPrefix } from './format.js';
import { guideText } from './guide.js';
import type { CliHostPlugin } from './hosts/plugin.js';

const TARGET = { cliPath: '/opt/sherpa/bin/sherpa-review.mjs', prKey: 'pr-1' };
const LAUNCH = 'node /opt/sherpa/bin/sherpa-review.mjs';

/** Made-up plugins: the guide core is tested without the built-in hosts. */
const ALPHA: CliHostPlugin = {
    name: 'alpha',
    guide: { arguments: ['**An alpha URL** means PR review of that alpha PR.'], requirements: ['Alpha needs a token.'] },
};
const BETA: CliHostPlugin = {
    name: 'beta',
    detectLocal: {
        vcs: 'bvcs',
        defaultBase: 'merge-base with main',
        detect: () => Promise.resolve({ kind: 'absent', reason: 'not needed' }),
    },
    guide: { arguments: ['**A beta URL** means PR review of that beta PR.'], requirements: ['Beta needs a mount.'] },
};
const HOSTS = [ALPHA, BETA];

async function runCli(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(argv, {
        env: {},
        hosts: HOSTS,
        entry: TARGET.cliPath,
        out: (text) => out.push(text),
        err: (text) => err.push(text),
    });
    return { code, out: out.join('\n'), err: err.join('\n') };
}

describe('sherpa-review guide', () => {
    it('prints the core and the plugin parts in list order', async () => {
        const { code, out } = await runCli(['guide']);

        expect(code).toBe(0);
        expect(out).toBe(guideText(HOSTS, LAUNCH));
        // Host items sit between the local modes and the ready-made key.
        const order = [
            '**A path to a directory**',
            '**An alpha URL**',
            '**A beta URL**',
            '**An already-formed key**',
            'Alpha needs a token.',
            'Beta needs a mount.',
            '## Start',
        ].map((part) => out.indexOf(part));
        expect(order.every((index) => index >= 0)).toBe(true);
        expect(order).toEqual([...order].sort((a, b) => a - b));
        expect(out).toContain('other than the default base (bvcs: merge-base with main), add `--base <ref>`');
    });

    it('rejects any argument or option', async () => {
        for (const argv of [['guide', 'foo'], ['guide', '--pr', 'fixture-medium']]) {
            const { code, out, err } = await runCli(argv);

            expect(code, argv.join(' ')).toBe(1);
            expect(out).toBe('');
            expect(err).toContain('`sherpa-review guide` takes no arguments');
        }
    });

    it('is listed in the help', async () => {
        const { out } = await runCli(['--help']);

        expect(out).toContain('sherpa-review guide');
    });

    it('names no hosts or VCS in the core', () => {
        const core = guideText([], LAUNCH);

        expect(core).not.toMatch(/github|\bgit\b/iu);
        expect(core).toContain('`fixture-medium`');
        expect(core).toContain('other than the default base, add `--base <ref>`');
    });
});

describe('the start command in the guide', () => {
    it('pins an npx run to its exact version', () => {
        const cli = '/home/me/.npm/_npx/0123abcd/node_modules/sherpa-review/bin/sherpa-review.mjs';

        expect(startCommandPrefix(cli, '0.12.0')).toBe('npx -y sherpa-review@0.12.0');
    });

    it('runs anything else by its path with node', () => {
        expect(startCommandPrefix('/usr/lib/node_modules/sherpa-review/bin/sherpa-review.mjs', '0.12.0')).toBe(
            'node /usr/lib/node_modules/sherpa-review/bin/sherpa-review.mjs',
        );
        // A dev build has no published version to pin.
        expect(startCommandPrefix('/home/me/.npm/_npx/0123abcd/node_modules/sherpa-review/bin/sherpa-review.mjs', '0.0.0')).toBe(
            'node /home/me/.npm/_npx/0123abcd/node_modules/sherpa-review/bin/sherpa-review.mjs',
        );
        expect(startCommandPrefix('/tmp/my dir/sherpa-review.mjs', '0.12.0')).toBe("node '/tmp/my dir/sherpa-review.mjs'");
    });
});

describe('the guide for the model', () => {
    const guide = guideText(HOSTS, LAUNCH);

    it('starts with the given command, then runs exactly the printed commands', () => {
        expect(guide).toContain(`${LAUNCH} up --pr <pr>`);
        expect(guide).toContain(`${LAUNCH} up --local <path>`);
        expect(guide).toContain('--model');
        // The loop uses exactly the command printed by `up`, with the full path and `--pr`.
        expect(guide).toContain('exactly the `worker next` command that `up` printed');
        expect(guide).not.toContain(`${LAUNCH} worker next`);
    });

    it('states the loop rules: shared context and the result file', () => {
        // A path under `shared/` is read once per session.
        expect(guide).toContain('`shared/`');
        expect(guide).toContain('once per session');
        // The task supplies the result file. A custom path in shared tmp would collide across sessions on one machine.
        expect(guide).toContain('only to the file path the task gives you');
    });

    // Bootstrap is inside `up`. A model that knows about the server and registration diverges from the CLI
    // at the next startup change.
    it('tells the model nothing about the server or registration', () => {
        expect(guide).not.toContain('@sherpa/server');
        expect(guide).not.toContain('worker register');
    });

    /**
     * The loop recognizes situations by exact output phrases: "stop the loop" ends the loop, DONE ends the work.
     * If the wording diverges, the model silently stops recognizing these situations.
     */
    it('uses loop marker phrases that the CLI prints verbatim', () => {
        // Quotes enclose exactly the phrases the model looks for in output. In code spans they are code.
        const markers = [...guide.replace(/`[^`\n]*`/gu, '').matchAll(/"([^"]+)"/gu)].map((match) => match[1] ?? '');
        expect(markers).toEqual(expect.arrayContaining(['stop the loop']));
        expect(guide).toContain('DONE');

        const printed = [
            formatDone('The reviewer closed the tab.'),
            formatRpcError({ code: 'worker_conflict', message: 'Another session took over.' }, 'worker', TARGET),
        ].join('\n');
        for (const marker of [...markers, 'DONE']) {
            expect(printed, marker).toContain(marker);
        }
        expect(formatDone('x').endsWith('\nDONE')).toBe(true);
    });
});
