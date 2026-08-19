import { describe, expect, it } from 'vitest';

import { parseArgs } from './args.js';
import { CliError } from './errors.js';

describe('argument parsing', () => {
    it('utility commands: version and help', () => {
        expect(parseArgs(['--version']).kind).toBe('version');
        expect(parseArgs(['-v']).kind).toBe('version');
        expect(parseArgs([]).kind).toBe('help');
        expect(parseArgs(['--help']).kind).toBe('help');
        // Version takes priority over everything else. It tells the caller what is installed.
        expect(parseArgs(['worker', 'next', '--version']).kind).toBe('version');
    });

    it('worker next, with and without a PR flag', () => {
        expect(parseArgs(['worker', 'next'])).toEqual({ kind: 'worker-next', prKey: undefined });
        expect(parseArgs(['worker', 'next', '--pr', 'github-quillmart--quillmart--1'])).toEqual({
            kind: 'worker-next',
            prKey: 'github-quillmart--quillmart--1',
        });
        expect(parseArgs(['--pr=github-quillmart--quillmart--1', 'worker', 'next'])).toEqual({
            kind: 'worker-next',
            prKey: 'github-quillmart--quillmart--1',
        });
    });

    it('three task commands with their required flags', () => {
        expect(parseArgs(['task', 'complete', '42', '--file', 'answer.md'])).toEqual({
            kind: 'task-complete',
            prKey: undefined,
            taskId: 42,
            file: 'answer.md',
        });
        expect(parseArgs(['task', 'progress', '42', '--text', 'reading the diff'])).toEqual({
            kind: 'task-progress',
            prKey: undefined,
            taskId: 42,
            text: 'reading the diff',
        });
        expect(parseArgs(['task', 'fail', '42', '--reason', 'no access'])).toEqual({
            kind: 'task-fail',
            prKey: undefined,
            taskId: 42,
            reason: 'no access',
        });
    });

    it('accepts a task number in the format shown to the model', () => {
        expect(parseArgs(['task', 'fail', 'sherpa/7', '--reason', 'x'])).toMatchObject({ taskId: 7 });
    });

    it('explains the correct invocation for malformed calls', () => {
        const cases: { argv: string[]; contains: string }[] = [
            { argv: ['worker'], contains: 'worker next' },
            { argv: ['worker', 'nxt'], contains: 'worker next' },
            { argv: ['task'], contains: 'complete' },
            { argv: ['task', 'done', '1'], contains: 'complete' },
            { argv: ['task', 'complete'], contains: 'task number' },
            { argv: ['task', 'complete', 'abc', '--file', 'x'], contains: 'positive number' },
            { argv: ['task', 'complete', '0', '--file', 'x'], contains: 'positive number' },
            { argv: ['task', 'complete', '1'], contains: '--file' },
            { argv: ['task', 'progress', '1'], contains: '--text' },
            { argv: ['task', 'fail', '1'], contains: '--reason' },
            { argv: ['task', 'fail', '1', '--reason'], contains: 'has no value' },
            { argv: ['task', 'complete', '1', '2', '--file', 'x'], contains: 'extra arguments' },
            { argv: ['worker', 'next', '--force'], contains: 'unknown flag' },
            { argv: ['review'], contains: 'unknown command' },
        ];

        for (const { argv, contains } of cases) {
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(CliError);
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(contains);
        }
    });
});
