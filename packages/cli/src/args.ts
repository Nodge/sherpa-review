import type { Locale } from '@sherpa/protocol';
import { VERDICTS_INSTRUCTION_MAX_CHARS, localeSchema } from '@sherpa/protocol';

import { CliError } from './errors.js';

/** Parsed CLI invocation. All command inputs are known after argument parsing. */
export type Command =
    | { readonly kind: 'version' }
    | { readonly kind: 'help' }
    | {
          readonly kind: 'up';
          readonly prKey: string | undefined;
          /** Local review project directory (`--local`). Mutually exclusive with `--pr`. */
          readonly local: string | undefined;
          /** Local review comparison base (`--base`). Requires `--local`. */
          readonly base: string | undefined;
          /**
           * User instruction for the local review outcome (`--verdicts <instruction>`). With it, the review
           * ends with Ship or Request changes. Requires `--local`.
           */
          readonly verdicts: string | undefined;
          /** Harness label for worker status in the UI. Optional. */
          readonly harness: string | undefined;
          /** Worker model name for worker status in the UI. Optional. */
          readonly model: string | undefined;
          /** The language the agent uses with the reviewer, a hint for the UI locale. */
          readonly lang: Locale | undefined;
          /** Skip opening the browser after a cold start. */
          readonly noOpen: boolean;
      }
    | {
          readonly kind: 'worker-next';
          readonly prKey: string | undefined;
      }
    | {
          readonly kind: 'worker-register';
          readonly prKey: string | undefined;
          /** Harness label for worker status in the UI. Optional. */
          readonly harness: string | undefined;
          /** Worker model name for worker status in the UI. Optional. */
          readonly model: string | undefined;
          /** The language the agent uses with the reviewer, a hint for the UI locale. */
          readonly lang: Locale | undefined;
      }
    | {
          readonly kind: 'task-complete';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly file: string;
      }
    | {
          readonly kind: 'task-progress';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly text: string;
      }
    | {
          readonly kind: 'task-fail';
          readonly prKey: string | undefined;
          readonly taskId: number;
          readonly reason: string;
      };

const OPTIONS = [
    '--pr',
    '--local',
    '--base',
    '--file',
    '--text',
    '--reason',
    '--harness',
    '--model',
    '--lang',
    '--verdicts',
] as const;
const FLAGS = ['--no-open'] as const;
type OptionName = (typeof OPTIONS)[number];
type FlagName = (typeof FLAGS)[number];

type TaskSubcommand = 'complete' | 'progress' | 'fail';

/** Contract limit for free-form `harness` and `model` strings (`@sherpa/protocol`). */
const LABEL_MAX_CHARS = 64;

/**
 * Parse arguments. Any malformed input raises `CliError` with a hint for the correct invocation.
 * The model gets command formats wrong, so output must correct it (`docs/protocol.md §1`).
 */
export function parseArgs(argv: readonly string[]): Command {
    if (argv.includes('--version') || argv.includes('-v')) {
        return { kind: 'version' };
    }
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
        return { kind: 'help' };
    }

    const { options, flags, positionals } = splitArgs(argv);
    const prKey = options.get('--pr');
    const group = positionals[0];

    if (group !== 'up' && flags.size > 0) {
        throw new CliError('sherpa: --no-open is only available for `sherpa up`.');
    }
    if (group !== 'up' && (options.has('--local') || options.has('--base') || options.has('--verdicts'))) {
        throw new CliError('sherpa: --local, --base and --verdicts are only available for `sherpa up`.');
    }
    if (group === 'up') {
        return parseUpCommand(positionals, options, flags, prKey);
    }
    if (group === 'worker') {
        return parseWorkerCommand(positionals, options, prKey);
    }
    if (group === 'task') {
        return parseTaskCommand(positionals, options, prKey);
    }

    throw new CliError(
        `sherpa: unknown command ${JSON.stringify(positionals.join(' '))}.\n` +
            'Available: `sherpa up`, `sherpa worker next`, `sherpa task complete|progress|fail <id>`; ' +
            '`sherpa --help` lists them all.',
    );
}

/**
 * Harness or model label from an argument. The model supplies it in whatever form it chooses:
 * in quotes, in backticks, with surrounding whitespace, sometimes beyond the contract limit.
 * A string that is empty after sanitizing is equivalent to an absent parameter.
 */
export function sanitizeLabel(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }

    const trimmed = raw
        .replace(/^[\s'"`]+/u, '')
        .replace(/[\s'"`]+$/u, '')
        .slice(0, LABEL_MAX_CHARS)
        .trim();
    return trimmed === '' ? undefined : trimmed;
}

function parseUpCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    flags: ReadonlySet<FlagName>,
    prKey: string | undefined,
): Command {
    if (positionals.length > 1) {
        throw new CliError(
            `sherpa: unexpected arguments after \`up\`: ${positionals.slice(1).join(' ')}.\n` +
                'Expected `sherpa up [--pr <pr key> | --local <path> [--base <ref>] [--verdicts <instruction>]] ' +
                '[--harness <harness name>] [--model <model name>] [--lang <ru|en>] [--no-open]`; ' +
                'without `--pr` and `--local` the PR is taken from the Git branch of the current directory.',
        );
    }

    const local = parseLocal(options.get('--local'));
    const base = options.get('--base')?.trim();
    if (local !== undefined && prKey !== undefined) {
        throw new CliError(
            'sherpa: `--local` and `--pr` mean different reviews — pass one of them.\n' +
                'Use `--local <path>` to review the working tree of a checkout, `--pr <pr key>` to review a PR.',
        );
    }
    if (base !== undefined && local === undefined) {
        throw new CliError(
            'sherpa: `--base` only makes sense with `--local`.\n' +
                'Call `sherpa up --local <path> --base <ref>`; for a PR the base comes from the host.',
        );
    }
    const verdicts = parseVerdicts(options.get('--verdicts'));
    if (verdicts !== undefined && local === undefined) {
        throw new CliError(
            'sherpa: `--verdicts` only makes sense with `--local`.\n' +
                'Call `sherpa up --local <path> --verdicts \'<instruction>\'`; a PR takes its verdicts from the host.',
        );
    }

    return {
        kind: 'up',
        prKey,
        local,
        base: base === '' ? undefined : base,
        verdicts,
        harness: sanitizeLabel(options.get('--harness')),
        model: sanitizeLabel(options.get('--model')),
        lang: parseLang(options.get('--lang')),
        noOpen: flags.has('--no-open'),
    };
}

/** Project directory from `--local`. A path is required, and an empty value counts as absent. */
function parseLocal(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    if (value === '') {
        throw new CliError(MISSING_LOCAL_PATH);
    }
    return value;
}

/** Instruction from `--verdicts`. Must be nonempty and no longer than `VERDICTS_INSTRUCTION_MAX_CHARS`. */
function parseVerdicts(raw: string | undefined): string | undefined {
    if (raw === undefined) {
        return undefined;
    }
    const value = raw.trim();
    if (value === '') {
        throw new CliError(MISSING_VERDICTS_INSTRUCTION);
    }
    if (value.length > VERDICTS_INSTRUCTION_MAX_CHARS) {
        throw new CliError(
            `sherpa: the \`--verdicts\` instruction is ${String(value.length)} characters long, ` +
                `the limit is ${String(VERDICTS_INSTRUCTION_MAX_CHARS)}.\n` +
                'Pass what the user asked for on ship or on request changes in a sentence or two, in their words.',
        );
    }
    return value;
}

const MISSING_VERDICTS_INSTRUCTION =
    'sherpa: `--verdicts` needs the user\'s instruction for the outcome of the review.\n' +
    'Call `sherpa up --local <path> --verdicts \'<what to do on ship or on request changes>\'` ' +
    'in the user\'s words, in single quotes; without such an instruction leave the flag out.';

const MISSING_LOCAL_PATH =
    'sherpa: `--local` needs the path of the project directory to review.\n' +
    'Call `sherpa up --local <path>` — `.` is the directory you are in right now.';

function parseWorkerCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if ((sub !== 'next' && sub !== 'register') || positionals.length > 2) {
        throw new CliError(
            'sherpa: group `worker` has two commands — `sherpa worker next` and `sherpa worker register`.',
        );
    }
    if (sub === 'register') {
        return {
            kind: 'worker-register',
            prKey,
            harness: sanitizeLabel(options.get('--harness')),
            model: sanitizeLabel(options.get('--model')),
            lang: parseLang(options.get('--lang')),
        };
    }
    return { kind: 'worker-next', prKey };
}

/**
 * Session language. Unlike free-form `--harness`/`--model` labels, the contract fixes the list
 * (`localeSchema`). The UI selects a dictionary from it and has none for "de".
 */
function parseLang(raw: string | undefined): Locale | undefined {
    const value = sanitizeLabel(raw);
    if (value === undefined) {
        return undefined;
    }

    const parsed = localeSchema.safeParse(value.toLowerCase());
    if (!parsed.success) {
        throw new CliError(
            `sherpa: --lang expects \`ru\` or \`en\`, got \`${value}\`.\n` +
                'Pass the language you speak with the reviewer in; if you are not sure, omit the flag ' +
                'and the UI will pick the language itself.',
        );
    }
    return parsed.data;
}

function parseTaskCommand(
    positionals: readonly string[],
    options: ReadonlyMap<OptionName, string>,
    prKey: string | undefined,
): Command {
    const sub = positionals[1];
    if (sub !== 'complete' && sub !== 'progress' && sub !== 'fail') {
        throw new CliError(
            'sherpa: group `task` has three commands — `complete`, `progress`, `fail`.\n' +
                'For example: `sherpa task complete 42 --file answer.md`.',
        );
    }
    if (positionals.length > 3) {
        throw new CliError(
            `sherpa: unexpected arguments after \`task ${sub}\`: ${positionals.slice(3).join(' ')}.\n` +
                `Expected \`sherpa task ${sub} <id> ${requiredOptionOf(sub)} "..."\`.`,
        );
    }

    const taskId = parseTaskId(positionals[2], sub);

    switch (sub) {
        case 'complete':
            return { kind: 'task-complete', prKey, taskId, file: requireOption(options, '--file', sub) };
        case 'progress':
            return { kind: 'task-progress', prKey, taskId, text: requireOption(options, '--text', sub) };
        case 'fail':
            return { kind: 'task-fail', prKey, taskId, reason: requireOption(options, '--reason', sub) };
    }
}

function parseTaskId(raw: string | undefined, sub: TaskSubcommand): number {
    if (raw === undefined) {
        throw new CliError(
            `sherpa: no task number given.\nCall \`sherpa task ${sub} <id> ${requiredOptionOf(sub)} "..."\`; ` +
                'the task number comes from the output of `sherpa worker next`.',
        );
    }

    // `sherpa/42` instead of `42` is a common model mistake because that is how it sees the task number.
    const digits = raw.startsWith('sherpa/') ? raw.slice('sherpa/'.length) : raw;
    const taskId = Number(digits);
    if (!Number.isInteger(taskId) || taskId <= 0) {
        throw new CliError(
            `sherpa: the task number must be a positive number, got ${JSON.stringify(raw)}.\n` +
                'Take the number from the output of `sherpa worker next` (the `TASK sherpa/<id>` line).',
        );
    }
    return taskId;
}

function requireOption(options: ReadonlyMap<OptionName, string>, name: OptionName, sub: TaskSubcommand): string {
    const value = options.get(name);
    if (value === undefined || value === '') {
        throw new CliError(
            `sherpa: \`task ${sub}\` requires ${name}.\n` +
                `Call \`sherpa task ${sub} <id> ${name} ${name === '--file' ? '<path>' : '"..."'}\`.`,
        );
    }
    return value;
}

function requiredOptionOf(sub: TaskSubcommand): OptionName {
    switch (sub) {
        case 'complete':
            return '--file';
        case 'progress':
            return '--text';
        case 'fail':
            return '--reason';
    }
}

/** Both flag forms are supported: `--file path` and `--file=path`. */
function splitArgs(argv: readonly string[]): {
    options: ReadonlyMap<OptionName, string>;
    flags: ReadonlySet<FlagName>;
    positionals: readonly string[];
} {
    const options = new Map<OptionName, string>();
    const flags = new Set<FlagName>();
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index] ?? '';
        if (!arg.startsWith('-')) {
            positionals.push(arg);
            continue;
        }

        const separator = arg.indexOf('=');
        const name = separator === -1 ? arg : arg.slice(0, separator);
        if (isFlag(name)) {
            if (separator !== -1) {
                throw new CliError(`sherpa: flag ${name} does not take a value.`);
            }
            flags.add(name);
            continue;
        }
        if (!isOption(name)) {
            throw new CliError(
                `sherpa: unknown flag ${name}.\nAvailable: ${[...OPTIONS, ...FLAGS].join(', ')}, --version, --help.`,
            );
        }

        if (separator !== -1) {
            options.set(name, arg.slice(separator + 1));
            continue;
        }

        const value = argv[index + 1];
        if (value === undefined || value.startsWith('--')) {
            throw new CliError(missingValueMessage(name));
        }
        options.set(name, value);
        index += 1;
    }

    return { options, flags, positionals };
}

/** The project directory and instruction cannot be guessed, so rejection names exactly what is missing. */
function missingValueMessage(name: OptionName): string {
    switch (name) {
        case '--local':
            return MISSING_LOCAL_PATH;
        case '--verdicts':
            return MISSING_VERDICTS_INSTRUCTION;
        default:
            return `sherpa: flag ${name} has no value.`;
    }
}

function isOption(name: string): name is OptionName {
    return (OPTIONS as readonly string[]).includes(name);
}

function isFlag(name: string): name is FlagName {
    return (FLAGS as readonly string[]).includes(name);
}
