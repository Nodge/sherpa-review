import type { Task } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { CommandTarget } from './format.js';
import {
    formatCompleteResponse,
    formatDone,
    formatFailResponse,
    formatOversizedResult,
    formatProgressResponse,
    formatRpcError,
    formatTask,
    formatUiUrl,
    formatUpReady,
    helpText,
    shellQuote,
} from './format.js';

const task: Task = {
    id: 42,
    type: 'echo',
    priority: 'interactive',
    attempt: 1,
    instructions: 'Return the contents of the file as is.',
    contextFiles: ['/tmp/sherpa/task-42-context.md'],
};

const RESULT_FILE = '/tmp/sherpa/pr-1/42-1.md';

const TARGET: CommandTarget = { cliPath: '/Users/me/.claude/skills/sherpa/bin/sherpa.mjs', prKey: 'github-quillmart--quillmart--1' };
/** Path containing a space. The command must survive being copied into a shell as is. */
const SPACED: CommandTarget = { cliPath: '/Users/Jo Doe/.claude/skills/sherpa/bin/sherpa.mjs', prKey: 'github-quillmart--quillmart--1' };
const CLI = `node ${TARGET.cliPath}`;

/** A command without the CLI path cannot run outside the skill directory and a checkout. */
const BARE_COMMAND = /(^|[^/\w.-])sherpa (up|worker|task)\b/mu;

describe('UI link', () => {
    it('uses the short fragment parameter name and loopback by default', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12')).toBe('http://127.0.0.1:4317/#t=Ab_cd-12');
    });

    it('escapes an IPv6 address in the URL', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12', '::1')).toBe('http://[::1]:4317/#t=Ab_cd-12');
    });
});

describe('up output for local review', () => {
    const uiUrl = 'http://127.0.0.1:4317/#t=token';

    it('names the default base in the VCS wording', () => {
        const git = formatUpReady(uiUrl, { ...TARGET, prKey: 'local-git-app-0badc0de' }, {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,
            verdicts: null,
        });
        const git = formatUpReady(uiUrl, { ...TARGET, prKey: 'local-git-app-0badc0de' }, {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,
            verdicts: null,
        });

        expect(git).toContain('on branch feature, base merge-base with main.');
        expect(git).toContain('on branch feature, base merge-base with the default branch.');
    });

    it('prints an explicit base as is', () => {
        const ready = formatUpReady(uiUrl, { ...TARGET, prKey: 'local-git-app-0badc0de' }, {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: 'origin/main~2',
            verdicts: null,
        });

        expect(ready).toContain('base origin/main~2.');
        expect(ready).not.toContain('Ship');
    });

    it('describes verdict mode on a separate line with the instruction', () => {
        const ready = formatUpReady(uiUrl, { ...TARGET, prKey: 'local-git-app-0badc0de' }, {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,
            verdicts: 'on ship, commit and open a PR',
        });

        expect(ready).toContain(
            'The reviewer finishes with Ship or Request changes; both arrive as a `review.feedback` task ' +
                'that repeats the user\'s instruction: "on ship, commit and open a PR".',
        );
    });

    it('prints the instruction verbatim in the ready line, without escaping', () => {
        const verdicts = 'on ship, commit with message "#61: done" in C:\\work\nthen open a PR';
        const ready = formatUpReady(uiUrl, { ...TARGET, prKey: 'local-git-app-0badc0de' }, {
            vcs: 'git',
            repo: '/repo/app',
            branch: 'feature',
            base: undefined,
            verdicts,
        });

        expect(ready).toContain(`that repeats the user's instruction: "${verdicts}".`);
    });
});

describe('help', () => {
    it('lists --verdicts with an instruction for up and its relationship to --local', () => {
        const help = helpText();

        expect(help).toContain('sherpa up [--local <path> [--verdicts <instruction>]]');
        expect(help).toMatch(
            /--verdicts <instruction> +the user's instruction for the outcome of the review, in their words; the reviewer then finishes with Ship or Request changes instead of Comment; only with `--local`/u,
        );
    });
});

describe('task prompt format', () => {
    it('contains a title, instructions, context and submission commands', () => {
        const output = formatTask(task, RESULT_FILE, TARGET);

        expect(output.startsWith('TASK sherpa/42 (echo), attempt 1')).toBe(true);
        expect(output).toContain('Return the contents of the file as is.');
        expect(output).toContain('Context: /tmp/sherpa/task-42-context.md');
        expect(output).toContain(`Write the result to ${RESULT_FILE} and submit it:`);
        expect(output).toContain(`  ${CLI} task complete 42 --file ${RESULT_FILE} --pr github-quillmart--quillmart--1`);
        expect(output).not.toContain('<path>');
        expect(output).toContain(`Interim status: ${CLI} task progress 42 --pr github-quillmart--quillmart--1 --text "..."`);
        expect(output).toContain(`Cannot do it: ${CLI} task fail 42 --pr github-quillmart--quillmart--1 --reason "..."`);
        expect(output).not.toMatch(BARE_COMMAND);
    });

    it('single-quotes CLI and file paths with special characters', () => {
        const output = formatTask(task, '/tmp/Jo Doe/42-1.md', SPACED);

        expect(output).toContain(
            `node '${SPACED.cliPath}' task complete 42 --file '/tmp/Jo Doe/42-1.md' --pr github-quillmart--quillmart--1`,
        );
    });

    it('prints "none" without context files and the result schema only when present', () => {
        expect(formatTask({ ...task, contextFiles: [] }, RESULT_FILE, TARGET)).toContain('Context: none');
        expect(formatTask(task, RESULT_FILE, TARGET)).not.toContain('Result schema');
        expect(formatTask({ ...task, resultSchemaFile: '/tmp/schema.json' }, RESULT_FILE, TARGET)).toContain(
            'Result schema: /tmp/schema.json — the result is validated against it.',
        );
    });

    it('prints DONE as a separate word that ends the session', () => {
        expect(formatDone('There is no more work.').split('\n')).toContain('DONE');
    });
});

describe('complete responses', () => {
    it('accepted asks for the next task', () => {
        const output = formatCompleteResponse(
            { kind: 'accepted', message: 'The result is accepted.' },
            42,
            RESULT_FILE,
            TARGET,
        );

        expect(output).toContain('The result is accepted.');
        expect(output).toContain(`Call \`${CLI} worker next --pr github-quillmart--quillmart--1\` for the next task.`);
    });

    it('rejected lists errors as items and asks to call complete again with the same file', () => {
        const output = formatCompleteResponse(
            { kind: 'rejected', errors: ['empty', 'no summary section'] },
            42,
            '/work/answer.md',
            TARGET,
        );

        expect(output).toContain('1. empty');
        expect(output).toContain('2. no summary section');
        expect(output).toContain(`\`${CLI} task complete 42 --file /work/answer.md --pr github-quillmart--quillmart--1\` again.`);
    });

    it('noop prints the server message', () => {
        const output = formatCompleteResponse(
            { kind: 'noop', message: 'Task sherpa/42 is already finished.' },
            42,
            RESULT_FILE,
            TARGET,
        );

        expect(output).toContain('is already finished');
        expect(output).toContain(`${CLI} worker next --pr github-quillmart--quillmart--1`);
    });
});

describe('progress and fail responses', () => {
    it('name the next step as a full command', () => {
        const outputs = [
            formatProgressResponse({ kind: 'accepted' }, 42, TARGET),
            formatProgressResponse({ kind: 'noop', message: 'Task sherpa/42 has been cancelled.' }, 42, TARGET),
            formatFailResponse({ kind: 'accepted' }, 42, TARGET),
            formatFailResponse({ kind: 'noop', message: 'Task sherpa/42 has been cancelled.' }, 42, TARGET),
        ];

        expect(outputs[1]).toContain(`${CLI} worker next --pr github-quillmart--quillmart--1`);
        expect(outputs[2]).toContain(`${CLI} worker next --pr github-quillmart--quillmart--1`);
        expect(outputs[3]).toContain(`${CLI} worker next --pr github-quillmart--quillmart--1`);
        for (const output of outputs) {
            expect(output).not.toMatch(BARE_COMMAND);
        }
    });
});

/** Server message for `worker_conflict` (worker-registry): the fact without the next step. */
const CONFLICT_MESSAGE =
    'Another live session (w-1) is the worker of this PR — two sessions per PR are not supported, ' +
    'and the slot belongs to the session that started last. This one is not it.';

describe('errors', () => {
    it('prints the server message and details as a list', () => {
        const output = formatRpcError(
            {
                code: 'bad_request',
                message: 'The request failed contract validation.',
                details: ['taskId: a number is expected'],
            },
            'worker',
            TARGET,
        );

        expect(output).toContain('The request failed contract validation.');
        expect(output).toContain('- taskId: a number is expected');
        expect(output).not.toContain('bad_request');
    });

    it('does not duplicate hints when the server already says what to do', () => {
        const message = 'The CLI protocol version 9.9.9 is incompatible. Update the skill together with the CLI.';

        expect(formatRpcError({ code: 'version_incompatible', message }, 'worker', TARGET)).toBe(`sherpa: ${message}`);
    });

    it('worker conflict in the loop gives a terminal instruction to stop', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'worker', TARGET);

        expect(output).toContain(CONFLICT_MESSAGE);
        expect(output).toContain('stop the loop');
    });

    // Registration no longer rejects with a conflict (the server takes over the slot), but the call role
    // remains. A different server running an older version may still return a conflict for register.
    it('conflict at registration leaves only the server message, as this session was never a worker', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'register', TARGET);

        expect(output).toBe(`sherpa: ${CONFLICT_MESSAGE}`);
        expect(output).not.toContain('stop the loop');
    });

    it('explains an exceeded limit in kilobytes and leaves the task assigned to the worker', () => {
        const output = formatOversizedResult(42, '/tmp/answer.md', RESULT_MAX_BYTES * 2, TARGET);

        expect(output).toContain('512 KB');
        expect(output).toContain('256 KB');
        expect(output).toContain(`${CLI} task complete 42 --file /tmp/answer.md --pr github-quillmart--quillmart--1`);
        expect(output).toContain('The task stays yours');
    });

    it('a task closed for exceeding the limit and a lease held by another worker lead to the loop with a full command', () => {
        const tooLarge = formatRpcError({ code: 'result_too_large', message: 'Too large.' }, 'worker', TARGET);
        const lease = formatRpcError(
            { code: 'lease_not_held', message: 'Call `worker next` and work on the task it gives you.' },
            'worker',
            TARGET,
        );

        expect(tooLarge).toContain(`call \`${CLI} worker next --pr github-quillmart--quillmart--1\` for the next one`);
        expect(lease).toContain(`\`${CLI} worker next --pr github-quillmart--quillmart--1\``);
        expect(tooLarge).not.toMatch(BARE_COMMAND);
        expect(lease).not.toMatch(BARE_COMMAND);
    });
});

describe('printed commands', () => {
    it('up names worker next as a full command with the path and key', () => {
        const ready = formatUpReady('http://127.0.0.1:4317/#t=token', TARGET);

        expect(ready).toContain(`Then run \`${CLI} worker next --pr github-quillmart--quillmart--1\``);
        expect(ready).not.toMatch(BARE_COMMAND);
    });

    it('POSIX quoting: safe text stays as is, the rest gets single quotes', () => {
        expect(shellQuote('/opt/sherpa/bin/sherpa.mjs')).toBe('/opt/sherpa/bin/sherpa.mjs');
        expect(shellQuote('/Users/Jo Doe/a.md')).toBe("'/Users/Jo Doe/a.md'");
        expect(shellQuote("/tmp/it's/$HOME")).toBe(String.raw`'/tmp/it'\''s/$HOME'`);
        expect(shellQuote('/tmp/café.md')).toBe("'/tmp/café.md'");
        expect(shellQuote('=x')).toBe("'=x'");
        expect(shellQuote('a=b')).toBe('a=b');
    });
});
