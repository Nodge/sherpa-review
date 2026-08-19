import type { Task } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import {
    formatCompleteResponse,
    formatDone,
    formatOversizedResult,
    formatRpcError,
    formatTask,
} from './format.js';

const task: Task = {
    id: 42,
    type: 'echo',
    priority: 'interactive',
    attempt: 1,
    instructions: 'Return the file contents as is.',
    contextFiles: ['/tmp/sherpa/task-42-context.md'],
};

describe('task prompt format', () => {
    it('contains a title, instructions, context and submission commands', () => {
        const output = formatTask(task);

        expect(output.startsWith('TASK sherpa/42 (echo), attempt 1')).toBe(true);
        expect(output).toContain('Return the file contents as is.');
        expect(output).toContain('Context: /tmp/sherpa/task-42-context.md');
        expect(output).toContain('sherpa task complete 42 --file <path>');
        expect(output).toContain('sherpa task progress 42 --text');
        expect(output).toContain('sherpa task fail 42 --reason');
    });

    it('prints "none" without context files and the result schema only when present', () => {
        expect(formatTask({ ...task, contextFiles: [] })).toContain('Context: none');
        expect(formatTask(task)).not.toContain('Result schema');
        expect(formatTask({ ...task, resultSchemaFile: '/tmp/schema.json' })).toContain(
            'Result schema: /tmp/schema.json — the result is validated against it.',
        );
    });

    it('prints DONE as a separate word that ends the session', () => {
        expect(formatDone('No more work.').split('\n')).toContain('DONE');
    });
});

describe('complete responses', () => {
    it('accepted asks for the next task', () => {
        const output = formatCompleteResponse({ kind: 'accepted', message: 'Result accepted.' }, 42);

        expect(output).toContain('Result accepted.');
        expect(output).toContain('sherpa worker next');
    });

    it('rejected lists errors and asks to call complete again', () => {
        const output = formatCompleteResponse({ kind: 'rejected', errors: ['empty', 'missing "summary" section'] }, 42);

        expect(output).toContain('1. empty');
        expect(output).toContain('2. missing "summary" section');
        expect(output).toContain('sherpa task complete 42 --file <path>');
    });

    it('noop prints the server message', () => {
        const output = formatCompleteResponse({ kind: 'noop', message: 'Task sherpa/42 is already complete.' }, 42);

        expect(output).toContain('already complete');
    });
});

describe('errors', () => {
    it('prints the server message and details as a list', () => {
        const output = formatRpcError({
            code: 'bad_request',
            message: 'The request failed contract validation.',
            details: ['taskId: expected a number'],
        });

        expect(output).toContain('The request failed contract validation.');
        expect(output).toContain('- taskId: expected a number');
        expect(output).not.toContain('bad_request');
    });

    it('does not duplicate hints when the server already says what to do', () => {
        const message = 'CLI protocol version 9.9.9 is incompatible. Update the skill together with the CLI.';

        expect(formatRpcError({ code: 'version_incompatible', message })).toBe(`sherpa: ${message}`);
    });

    it('explains an exceeded limit in kilobytes and leaves the task assigned to the worker', () => {
        const output = formatOversizedResult(42, '/tmp/answer.md', RESULT_MAX_BYTES * 2);

        expect(output).toContain('512 KB');
        expect(output).toContain('256 KB');
        expect(output).toContain('sherpa task complete 42 --file /tmp/answer.md');
        expect(output).toContain('stays yours');
    });
});
