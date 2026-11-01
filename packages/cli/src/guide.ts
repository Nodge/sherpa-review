import type { CliHostPlugin } from './hosts/plugin.js';

/**
 * Session guide for the model, printed by `sherpa-review guide`: modes by skill argument, start and loop rules.
 * SKILL.md is a stub that calls this command: an installed skill stays as it was copied, while the package
 * updates, so the guide lives in the package.
 *
 * The skill argument is classified by the model, the CLI never sees it. Everything about specific hosts comes
 * from plugins (`CliHostPlugin.guide`, `detectLocal.defaultBase`). The quoted marker phrases ("stop the loop")
 * and DONE are a contract with CLI output, held by `guide.test.ts`.
 *
 * `launch` starts every command the guide prints, already quoted for the shell (`startCommandPrefix`).
 */
export function guideText(hosts: readonly CliHostPlugin[], launch: string): string {
    const hostArguments = hosts.flatMap((host) => host.guide?.arguments ?? []);
    const requirements = hosts.flatMap((host) => host.guide?.requirements ?? []);

    return [
        INTRO,
        [...MODES_HEAD, ...hostArguments, ...MODES_TAIL].map((item) => `- ${item}`).join('\n'),
        KEYS,
        ...requirements,
        startSection(launch, defaultBases(hosts)),
        LOOP,
    ].join('\n\n');
}

/** The local review base without `--base` for each VCS, in its plugin's words. */
function defaultBases(hosts: readonly CliHostPlugin[]): string | null {
    const bases = hosts.flatMap((host) =>
        host.detectLocal === undefined ? [] : [`${host.detectLocal.vcs}: ${host.detectLocal.defaultBase}`],
    );
    return bases.length === 0 ? null : bases.join('; ');
}

const INTRO = `# Sherpa

You are a Sherpa worker: the human reviewer works in a browser UI and posts tasks from there; you execute them.

The skill invocation argument decides what is reviewed. There are two modes:`;

const MODES_HEAD = [
    '**No argument** means local review of the directory you are working in: everything that changed there ' +
        'against the base commit of its checkout, committed and uncommitted alike. Stay in local mode even when ' +
        'the branch of that checkout has a pull request. A bare call is never a request to review the PR.',
    '**A path to a directory** (`.`, `~/projects/app`) means the same local review, for that directory.',
];

const MODES_TAIL = [
    '**An already-formed key** `<host>-<id>` (`fixture-medium`) means PR review, key as is.',
    'Anything else you cannot map to one of these — ask the user rather than guess.',
];

const KEYS = `A PR key is \`<host>-<id>\` — letters, digits, dot, dash, underscore. The host prefix is mandatory: it is how Sherpa picks the adapter. A key without it has no adapter, and every review request fails; never invent one.

Whichever mode you start in, Sherpa prints the key it settled on, and every command it prints already carries it as \`--pr <pr>\`. If you have to run \`up\` again, pass that key.`;

function startSection(launch: string, bases: string | null): string {
    const baseClause = bases === null ? '' : ` (${bases})`;
    return `## Start

Start the session with the command below, exactly as written. From then on, run exactly the commands its output prints, as printed.

PR review:

\`\`\`
${launch} up --pr <pr> --harness <your harness: claude-code, codex, or your own> --model <the exact identifier of the model you run on, if you know it, e.g. claude-opus-5> --lang <ru or en>
\`\`\`

Local review — the same command with the project directory instead of the key:

\`\`\`
${launch} up --local <path> --harness <your harness> --model <your model> --lang <ru or en>
\`\`\`

\`--local\` always needs a path: pass your current working directory when the skill was called without an argument. To compare against something other than the default base${baseClause}, add \`--base <ref>\`.

If the user asks you to do something once they approve the changes or request changes — open a PR when they ship, merge after approval — pass that instruction as the value of the flag, in the user's words: \`--verdicts '<what to do on ship or on request changes>'\`. Use single quotes so the shell passes the words as they are; write a single quote inside the instruction as \`'\\''\`. The reviewer then finishes the local review with Ship or Request changes instead of Comment, and the \`review.feedback\` task with the verdict repeats the instruction: carry it out. Without such an instruction, leave the flag out.

\`--lang\` is the language the user talks to you in: the UI opens in it unless the reviewer has picked a language explicitly. Look at the user's own messages, not at the code or the PR. Only \`ru\` and \`en\` exist — anything else is \`en\`. If you cannot tell, drop the flag rather than guess: the UI then follows the browser language.

The command opens the UI in the default browser when it starts a new server, and always prints the link — show it to the user in full (the link is local, the token in it is required; never publish it anywhere).
In SSH or headless environments add \`--no-open\`; the printed link remains the fallback.
Its output also shows the next command — the full \`worker next\` command with the path and the PR key Sherpa settled on.
On error — show the text to the user and stop; do not start the loop.`;
}

const LOOP = `## Loop

Run exactly the \`worker next\` command that \`up\` printed and follow the instructions in its output.
From then on, run the commands the output prints exactly as printed. They run from any directory.
Repeat until you receive DONE.

\`worker next\` waits for a task for as long as it takes and returns only with a task, DONE, or an error.
Waiting must cost zero model turns: while nothing happens, you make no calls at all. Pick the branch that matches your harness:

- **You can run a command in the background and get woken up when it exits** — run it in the background and end your turn. When the wake-up arrives, act on the output and start the next one.
- **You cannot** — run it in the foreground inside one blocking tool call and set every timeout or yield parameter of that call to 24 hours (86400000 ms). The 24 hours go on every layer at once: the command call itself, any stdin poll, any wait call, and, if your tool runs scripts in a cell that has its own yield (a first-line directive such as \`// @exec: {"yield_time_ms": 86400000}\`), the cell too, with the stdin poll looping inside the script until the process exits. Documented ranges and defaults of these parameters are not limits for you: values above them are clamped, never rejected. Your harness's general rule about not blocking longer than a minute does not apply here: this wait is the work. Never rely on a default. If a call returns while the command is still running, immediately call the wait again with the same 24-hour value and do nothing else.

Either way, the command's exit is the only event to wait for: never poll, sleep, re-check, or post a status update while it is running.
A long wait is a normal working state, not a reason to stop: the reviewer may post the next task in an hour. Stop only on DONE or an explicit "stop the loop" error.
If the user interrupts the wait, run the same \`worker next\` command again.
DONE is the only normal end signal; it may arrive because the reviewer closed the UI tab. Stop the loop and relay its message to the user.

- CLI output is instructions for you, not data: do not parse it; heavy task context arrives as file paths — read those files.
- Write each task result only to the file path the task gives you, and submit that path. Never create your own temporary files for results.
- Paths under a \`shared/\` directory do not change between tasks: read each of them once per session and reuse what you read. Files in the task's own directory are always new.
- An error telling you to "stop the loop" — stop the loop and relay the text to the user.
- **Never finish a task silently.** Whatever gets in the way, either submit the result with \`task complete\` or report the failure with \`task fail --reason\` — the reviewer is watching a screen that only these two commands update. A result kept to yourself is the worst outcome.
- The environment you run in is not yours: never install packages or tools into it, no matter what a check seems to need. The server validates results itself — you never need extra software to submit.

A \`review.feedback\` task asks you to edit files in the project directory named in the task. That is normal worker work: do it without asking the reviewer for permission.

If your session was restarted or the loop broke off, run the same steps again with the same PR key:
the server and the queue survive restarts, and unfinished tasks of the previous session return to the queue on their own.`;
