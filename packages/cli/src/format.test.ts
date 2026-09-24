import type { Task } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    formatCompleteResponse,
    formatDone,
    formatOversizedResult,
    formatRpcError,
    formatTask,
    formatUiUrl,
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

describe('UI link', () => {
    it('uses the short fragment parameter name and loopback by default', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12')).toBe('http://127.0.0.1:4317/#t=Ab_cd-12');
    });

    it('escapes an IPv6 address in the URL', () => {
        expect(formatUiUrl(4317, 'Ab_cd-12', '::1')).toBe('http://[::1]:4317/#t=Ab_cd-12');
    });
});

describe('task prompt format', () => {
    it('contains a title, instructions, context and submission commands', () => {
        const output = formatTask(task, RESULT_FILE);

        expect(output.startsWith('TASK sherpa/42 (echo), attempt 1')).toBe(true);
        expect(output).toContain('Return the contents of the file as is.');
        expect(output).toContain('Context: /tmp/sherpa/task-42-context.md');
        expect(output).toContain(`Write the result to ${RESULT_FILE} and submit it:`);
        expect(output).toContain(`  sherpa task complete 42 --file ${RESULT_FILE}`);
        expect(output).not.toContain('<path>');
        expect(output).toContain('sherpa task progress 42 --text');
        expect(output).toContain('sherpa task fail 42 --reason');
    });

    it('prints "none" without context files and the result schema only when present', () => {
        expect(formatTask({ ...task, contextFiles: [] }, RESULT_FILE)).toContain('Context: none');
        expect(formatTask(task, RESULT_FILE)).not.toContain('Result schema');
        expect(formatTask({ ...task, resultSchemaFile: '/tmp/schema.json' }, RESULT_FILE)).toContain(
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
        );

        expect(output).toContain('The result is accepted.');
        expect(output).toContain('sherpa worker next');
    });

    it('rejected lists errors as items and asks to call complete again with the same file', () => {
        const output = formatCompleteResponse(
            { kind: 'rejected', errors: ['empty', 'no summary section'] },
            42,
            '/work/answer.md',
        );

        expect(output).toContain('1. empty');
        expect(output).toContain('2. no summary section');
        expect(output).toContain('sherpa task complete 42 --file /work/answer.md');
    });

    it('noop prints the server message', () => {
        const output = formatCompleteResponse(
            { kind: 'noop', message: 'Task sherpa/42 is already finished.' },
            42,
            RESULT_FILE,
        );

        expect(output).toContain('is already finished');
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
        );

        expect(output).toContain('The request failed contract validation.');
        expect(output).toContain('- taskId: a number is expected');
        expect(output).not.toContain('bad_request');
    });

    it('does not duplicate hints when the server already says what to do', () => {
        const message = 'The CLI protocol version 9.9.9 is incompatible. Update the skill together with the CLI.';

        expect(formatRpcError({ code: 'version_incompatible', message }, 'worker')).toBe(`sherpa: ${message}`);
    });

    it('worker conflict in the loop gives a terminal instruction to stop', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'worker');

        expect(output).toContain(CONFLICT_MESSAGE);
        expect(output).toContain('stop the loop');
    });

    // Registration no longer rejects with a conflict (the server takes over the slot), but the call role
    // remains. A different server running an older version may still return a conflict for register.
    it('conflict at registration leaves only the server message, as this session was never a worker', () => {
        const output = formatRpcError({ code: 'worker_conflict', message: CONFLICT_MESSAGE }, 'register');

        expect(output).toBe(`sherpa: ${CONFLICT_MESSAGE}`);
        expect(output).not.toContain('stop the loop');
    });

    it('explains an exceeded limit in kilobytes and leaves the task assigned to the worker', () => {
        const output = formatOversizedResult(42, '/tmp/answer.md', RESULT_MAX_BYTES * 2);

        expect(output).toContain('512 KB');
        expect(output).toContain('256 KB');
        expect(output).toContain('sherpa task complete 42 --file /tmp/answer.md');
        expect(output).toContain('The task stays yours');
    });
});
