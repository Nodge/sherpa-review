import { describe, expect, it } from 'vitest';

import { parseArgs, sanitizeLabel } from './args.js';
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

    it('up: accepts PR, harness and model, rejects extra arguments', () => {
        expect(parseArgs(['up', '--pr', 'github-quillmart--quillmart--1', '--harness', 'claude-code', '--model', 'claude-opus-5'])).toEqual(
            {
                kind: 'up',
                prKey: 'github-quillmart--quillmart--1',
                harness: 'claude-code',
                model: 'claude-opus-5',
            },
        );
        expect(parseArgs(['up'])).toEqual({ kind: 'up', prKey: undefined, harness: undefined, model: undefined });
        expect(() => parseArgs(['up', 'server'])).toThrow('sherpa up --pr');
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

    it('worker register, harness and model are optional', () => {
        expect(parseArgs(['worker', 'register'])).toEqual({
            kind: 'worker-register',
            prKey: undefined,
            harness: undefined,
            model: undefined,
        });
        expect(
            parseArgs(['worker', 'register', '--harness', 'claude-code', '--model', 'gpt-5', '--pr', 'github-quillmart--quillmart--1']),
        ).toEqual({
            kind: 'worker-register',
            prKey: 'github-quillmart--quillmart--1',
            harness: 'claude-code',
            model: 'gpt-5',
        });
    });

    // The model supplies these values in backticks, quotes and surrounding whitespace.
    it('strips wrapping from harness and model, treats empty values as an absent parameter', () => {
        expect(sanitizeLabel('`claude-opus-5[1m]`')).toBe('claude-opus-5[1m]');
        expect(sanitizeLabel('"claude-sonnet-5"')).toBe('claude-sonnet-5');
        expect(sanitizeLabel("  'gpt-5'  ")).toBe('gpt-5');
        expect(sanitizeLabel('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5-20251001');
        expect(sanitizeLabel('')).toBeUndefined();
        expect(sanitizeLabel('   ')).toBeUndefined();
        expect(sanitizeLabel('```')).toBeUndefined();
        expect(sanitizeLabel(undefined)).toBeUndefined();
        // The contract limits labels to 64 characters. Excess characters are trimmed without an error.
        expect(sanitizeLabel('m'.repeat(100))).toHaveLength(64);
    });

    it('omits a model from the request when sanitizing leaves it empty', () => {
        expect(parseArgs(['up', '--model', '``'])).toMatchObject({ model: undefined });
        expect(parseArgs(['up', '--model=`claude-opus-5[1m]`'])).toMatchObject({ model: 'claude-opus-5[1m]' });
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
            { argv: ['task', 'complete'], contains: 'no task number' },
            { argv: ['task', 'complete', 'abc', '--file', 'x'], contains: 'must be a positive number' },
            { argv: ['task', 'complete', '0', '--file', 'x'], contains: 'must be a positive number' },
            { argv: ['task', 'complete', '1'], contains: '--file' },
            { argv: ['task', 'progress', '1'], contains: '--text' },
            { argv: ['task', 'fail', '1'], contains: '--reason' },
            { argv: ['task', 'fail', '1', '--reason'], contains: 'has no value' },
            { argv: ['task', 'complete', '1', '2', '--file', 'x'], contains: 'unexpected arguments' },
            { argv: ['worker', 'next', '--force'], contains: 'unknown flag' },
            { argv: ['review'], contains: 'unknown command' },
        ];

        for (const { argv, contains } of cases) {
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(CliError);
            expect(() => parseArgs(argv), argv.join(' ')).toThrow(contains);
        }
    });
});
