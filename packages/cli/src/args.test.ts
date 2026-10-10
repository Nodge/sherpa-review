import { VERDICTS_INSTRUCTION_MAX_CHARS } from '@sherpa/protocol';
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

    it('server: passes everything after the subcommand to the server unchanged', () => {
        expect(parseArgs(['server', '--pr', 'github-quillmart--quillmart--1', '--sherpa-dir', '/s', '--version', '-h'])).toEqual({
            kind: 'server',
            argv: ['--pr', 'github-quillmart--quillmart--1', '--sherpa-dir', '/s', '--version', '-h'],
        });
        expect(parseArgs(['server'])).toEqual({ kind: 'server', argv: [] });
    });

    it('up: accepts PR, harness and model, rejects extra arguments', () => {
        expect(parseArgs(['up', '--pr', 'github-quillmart--quillmart--1', '--harness', 'claude-code', '--model', 'claude-opus-5'])).toEqual(
            {
                kind: 'up',
                prKey: 'github-quillmart--quillmart--1',
                local: undefined,
                base: undefined,
                verdicts: undefined,
                harness: 'claude-code',
                model: 'claude-opus-5',
                lang: undefined,
                noOpen: false,
            },
        );
        expect(parseArgs(['up'])).toEqual({
            kind: 'up',
            prKey: undefined,
            local: undefined,
            base: undefined,
            verdicts: undefined,
            harness: undefined,
            model: undefined,
            lang: undefined,
            noOpen: false,
        });
        expect(parseArgs(['up', '--no-open'])).toMatchObject({ kind: 'up', noOpen: true });
        expect(() => parseArgs(['up', '--no-open=true'])).toThrow('does not take a value');
        expect(() => parseArgs(['up', 'server'])).toThrow('sherpa up [--pr <pr key> | --local <path>');
    });

    it('up --local: accepts a project directory instead of a PR, with a base', () => {
        expect(parseArgs(['up', '--local', '.', '--base', 'main~3'])).toMatchObject({
            kind: 'up',
            prKey: undefined,
            local: '.',
            base: 'main~3',
        });
        expect(parseArgs(['up', '--local=/tmp/app'])).toMatchObject({ local: '/tmp/app', base: undefined });
    });

    it('up --local --verdicts <instruction>: accepts an instruction only for local review and only on up', () => {
        expect(parseArgs(['up', '--local', '.', '--verdicts', 'on ship, commit and open a PR'])).toMatchObject({
            local: '.',
            verdicts: 'on ship, commit and open a PR',
        });
        expect(parseArgs(['up', '--local', '.', '--verdicts=  on ship, merge  '])).toMatchObject({
            verdicts: 'on ship, merge',
        });
        expect(parseArgs(['up', '--local', '.'])).toMatchObject({ verdicts: undefined });
        expect(() => parseArgs(['up', '--verdicts', 'on ship, merge'])).toThrow(
            '`--verdicts` only makes sense with `--local`',
        );
        expect(() => parseArgs(['up', '--pr', 'github-quillmart--quillmart--1', '--verdicts', 'on ship, merge'])).toThrow(
            '`--verdicts` only makes sense with `--local`',
        );
        expect(() => parseArgs(['worker', 'next', '--verdicts', 'on ship, merge'])).toThrow(
            '--local, --base and --verdicts are only available for `sherpa up`',
        );
    });

    it('up --verdicts: rejects missing, empty or oversized instructions with a hint', () => {
        for (const argv of [
            ['up', '--local', '.', '--verdicts'],
            ['up', '--local', '.', '--verdicts', '--no-open'],
            ['up', '--local', '.', '--verdicts='],
            ['up', '--local', '.', '--verdicts', '   '],
        ]) {
            expect(() => parseArgs(argv)).toThrow("`--verdicts` needs the user's instruction");
        }

        const limit = VERDICTS_INSTRUCTION_MAX_CHARS;
        expect(parseArgs(['up', '--local', '.', '--verdicts', 'x'.repeat(limit)])).toMatchObject({
            verdicts: 'x'.repeat(limit),
        });
        expect(() => parseArgs(['up', '--local', '.', '--verdicts', 'x'.repeat(limit + 1)])).toThrow(
            `the \`--verdicts\` instruction is ${String(limit + 1)} characters long, the limit is ${String(limit)}`,
        );
    });

    it('up --local without a path: rejects with a hint instead of a generic "missing value"', () => {
        // The directory cannot be guessed, so the hint names it explicitly.
        expect(() => parseArgs(['up', '--local'])).toThrow('needs the path of the project directory');
        expect(() => parseArgs(['up', '--local', '--no-open'])).toThrow('needs the path of the project directory');
        expect(() => parseArgs(['up', '--local='])).toThrow('needs the path of the project directory');
    });

    it('up: --local and --pr select different reviews, --base requires --local', () => {
        expect(() => parseArgs(['up', '--local', '.', '--pr', 'github-quillmart--quillmart--1'])).toThrow('pass one of them');
        expect(() => parseArgs(['up', '--base', 'main'])).toThrow('only makes sense with `--local`');
        expect(() => parseArgs(['worker', 'next', '--local', '.'])).toThrow(
            'only available for `sherpa up`',
        );
        expect(() => parseArgs(['worker', 'next', '--base', 'main'])).toThrow(
            'only available for `sherpa up`',
        );
    });

    it('worker next, with and without a PR flag', () => {
        expect(parseArgs(['worker', 'next'])).toEqual({
            kind: 'worker-next',
            prKey: undefined,
        });
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
            lang: undefined,
        });
        expect(
            parseArgs(['worker', 'register', '--harness', 'claude-code', '--model', 'gpt-5', '--pr', 'github-quillmart--quillmart--1']),
        ).toEqual({
            kind: 'worker-register',
            prKey: 'github-quillmart--quillmart--1',
            harness: 'claude-code',
            model: 'gpt-5',
            lang: undefined,
        });
    });

    // The contract fixes the language list. The UI selects a dictionary by this label and has no third dictionary.
    it('--lang: accepts only ru and en on up and register, otherwise reports an argument error', () => {
        expect(parseArgs(['up', '--lang', 'ru'])).toMatchObject({ kind: 'up', lang: 'ru' });
        expect(parseArgs(['up', '--lang=EN'])).toMatchObject({ lang: 'en' });
        expect(parseArgs(['worker', 'register', '--lang', 'en'])).toMatchObject({
            kind: 'worker-register',
            lang: 'en',
        });
        // Wrapping is stripped just as it is for harness and model labels.
        expect(parseArgs(['worker', 'register', '--lang', '`ru`'])).toMatchObject({ lang: 'ru' });

        expect(() => parseArgs(['up', '--lang', 'de'])).toThrow(CliError);
        expect(() => parseArgs(['up', '--lang', 'de'])).toThrow('--lang expects `ru` or `en`, got `de`');
        expect(() => parseArgs(['worker', 'register', '--lang=ru-RU'])).toThrow('--lang expects');
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
