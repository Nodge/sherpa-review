import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { WorkerNextResponse, WorkerRegisterResponse } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';

import type { Command } from './args.js';
import { parseArgs } from './args.js';
import type { OpenBrowserOptions } from './browser.js';
import { openBrowser } from './browser.js';
import type { WorkerLabels } from './client.js';
import { requestComplete, requestFail, requestNext, requestProgress, requestRegister } from './client.js';
import type { CommandRunner } from './command.js';
import type { ServerConnection } from './discovery.js';
import { connect, connectAs, freshWorkerId, resolvePrKey } from './discovery.js';
import { CliError, userMessage } from './errors.js';
import type { CommandTarget } from './format.js';
import {
    formatCompleteResponse,
    formatDone,
    formatFailResponse,
    formatOversizedResult,
    formatProgressResponse,
    formatTask,
    formatUpReady,
    helpText,
    startCommandPrefix,
    taskCompleteCommand,
    workerNextCommand,
} from './format.js';
import { guideText } from './guide.js';
import type { CliHostPlugin } from './hosts/plugin.js';
import { resolveLocalTarget } from './local.js';
import {
    manifestPathFor,
    serverBinOverrideFrom,
    sherpaDirFrom,
    taskResultDirFor,
    taskResultFileFor,
    taskResultRootFor,
} from './paths.js';
import type { EnsureServerOptions, EnsureServerResult } from './up.js';
import { ensureServer, loadServerModule, resolveServerBin } from './up.js';
import { CLI_VERSION } from './version.js';

/** Invocation environment. Tests supply their own to run commands as functions instead of processes. */
export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    /**
     * Path to the running CLI file. The server module sits beside it, and this path also appears in commands
     * for the model. Defaults to `process.argv[1]`.
     */
    readonly entry?: string;
    /** Node flags for the server daemon started by `up`. None by default. */
    readonly daemonNodeFlags?: readonly string[];
    /** Host plugins from the composition root (`hosts/all.ts`): keys, PR discovery, local checkout. */
    readonly hosts: readonly CliHostPlugin[];
    /** Runs external commands for host plugins. Defaults to real binaries from PATH. */
    readonly runCommand?: CommandRunner;
    /** Test substitute for server discovery/startup. */
    readonly ensureServer?: (options: EnsureServerOptions) => Promise<EnsureServerResult>;
    /** Test substitute for the system opener. Tests don't launch a real browser. */
    readonly openBrowser?: (options: OpenBrowserOptions) => void;
    /** Root for task result files. Defaults to `os.tmpdir()`. */
    readonly tmpDir?: string;
}

/**
 * One CLI invocation. Exit code: 0 for normal protocol flow (including `rejected`:
 * this is a dialogue with the model, not a failure), 1 whenever the command could not complete.
 */
export async function run(argv: readonly string[], io: CliIo): Promise<number> {
    try {
        const command = parseArgs(argv);
        switch (command.kind) {
            case 'version':
                io.out(CLI_VERSION);
                return 0;
            case 'help':
                io.out(helpText());
                return 0;
            case 'guide':
                io.out(guideText(io.hosts, startCommandPrefix(path.resolve(entryOf(io) ?? 'sherpa-review.mjs'), CLI_VERSION)));
                return 0;
            case 'server':
                return await server(command, io);
            case 'up':
                return await up(command, io);
            case 'worker-register':
                return await workerRegister(command, io);
            case 'worker-next':
                return await workerNext(command, io);
            case 'task-complete':
                return await taskComplete(command, io);
            case 'task-progress':
                return await taskProgress(command, io);
            case 'task-fail':
                return await taskFail(command, io);
        }
    } catch (error) {
        io.err(userMessage(error));
        return 1;
    }
}

/**
 * Bootstraps the entire session in one command (`docs/protocol.md §3`): start the PR server, register
 * as a worker and return the UI link. The model knows nothing about the server or registration. It sees only the link
 * and the next step of the loop.
 */
async function up(command: Extract<Command, { kind: 'up' }>, io: CliIo): Promise<number> {
    // Resolve the PR key before starting the server. The server would reject an invalid one too, but later and at a higher cost,
    // and discovery from cwd (the plugins' `discoverPr`) must happen exactly once per command.
    // `--local` names a directory, not a PR. The key comes from the directory and branch, not the host.
    const local =
        command.local === undefined
            ? null
            : await resolveLocalTarget(command.local, command.base, io.hosts, io.runCommand);
    const prKey = local?.prKey ?? (await resolvePrKey(command.prKey, io.env, io.hosts, io.runCommand));

    const sherpaDir = sherpaDirFrom(io.env);
    const target = targetOf(io, prKey);

    const server = await (io.ensureServer ?? ensureServer)({
        prKey,
        sherpaDir,
        entry: entryOf(io),
        serverBin: serverBinOverrideFrom(io.env),
        nodeFlags: io.daemonNodeFlags ?? [],
        ...(local === null
            ? {}
            : { repo: local.repo, base: local.base, branch: local.branch, verdicts: command.verdicts }),
    });
    // A fresh session always gets the worker slot. The server takes it even from a live previous session,
    // so `up` registers through the normal flow and has no fallback paths. The verdict mode goes
    // here too. A running server doesn't see startup arguments, and the last `up` wins.
    const registered = await registerWorker(
        prKey,
        labelsOf(command),
        io,
        target,
        local === null ? undefined : (command.verdicts ?? null),
    );
    // A running server from an old build silently drops `localVerdicts` without echoing it. The reviewer would see
    // only Comment, while the agent waited for a verdict that would never arrive.
    if (command.verdicts !== undefined && registered.localVerdicts !== command.verdicts) {
        throw new CliError(
            'The Sherpa server already running for this review is older than this CLI and ignores ' +
                '`--verdicts`: the reviewer would see only Comment. Stop that server (its pid is in ' +
                `${manifestPathFor(sherpaDir, prKey)}) and run the same \`up\` command again.`,
        );
    }

    io.out(
        formatUpReady(
            server.uiUrl,
            target,
            local === null
                ? null
                : { ...local, verdicts: registered.localVerdicts ?? null },
        ),
    );
    if (server.started && !command.noOpen) {
        try {
            (io.openBrowser ?? openBrowser)({ uiUrl: server.uiUrl });
        } catch {
            // The link is already printed. Headless/ssh use and opener failure don't turn a successful up into an error.
        }
    }
    return 0;
}

/** PR server process that `up` daemonizes. */
async function server(command: Extract<Command, { kind: 'server' }>, io: CliIo): Promise<number> {
    const serverBin = await resolveServerBin(entryOf(io), serverBinOverrideFrom(io.env));
    const serverModule = await loadServerModule(serverBin);
    return serverModule.runServer(command.argv);
}

async function workerRegister(command: Extract<Command, { kind: 'worker-register' }>, io: CliIo): Promise<number> {
    const prKey = await resolvePrKey(command.prKey, io.env, io.hosts, io.runCommand);
    const target = targetOf(io, prKey);
    const response = await registerWorker(prKey, labelsOf(command), io, target);

    // The server gives the next loop step a short name. The CLI adds the full command.
    io.out(`${response.message}\nThe full \`worker next\` command: \`${workerNextCommand(target)}\``);
    return 0;
}

/**
 * Registers a session as the PR worker. Each session gets a fresh identity.
 * The server writes it to the state file while handling `register` (`worker-id-file.ts`):
 * two parallel sessions must have exactly as many writers to the shared file as there are
 * owners of the slot: one.
 */
async function registerWorker(
    prKey: string,
    labels: WorkerLabels,
    io: CliIo,
    target: CommandTarget,
    localVerdicts?: string | null,
): Promise<WorkerRegisterResponse> {
    const connection = await connectAs(prKey, io.env, freshWorkerId(io.env), io.hosts, io.runCommand);
    return requestRegister(connection, target, labels, localVerdicts);
}

/** Session labels from command arguments. `up` and `worker register` declare them the same way. */
function labelsOf(command: Extract<Command, { kind: 'up' | 'worker-register' }>): WorkerLabels {
    return { harness: command.harness, model: command.model, lang: command.lang };
}

async function workerNext(command: Extract<Command, { kind: 'worker-next' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.hosts, io.runCommand);
    const target = targetOf(io, connection.prKey);
    const resultDir = await prepareResultDir(io.tmpDir ?? os.tmpdir(), sherpaDirFrom(io.env), connection, target);
    const response = await awaitTask(connection, target);

    switch (response.kind) {
        case 'task':
            io.out(formatTask(response.task, taskResultFileFor(resultDir, response.task), target));
            return 0;
        case 'done':
            io.out(formatDone(response.message));
            return 0;
    }
}

/**
 * Prepare the session result directory before leasing. Failure won't leave a task assigned to the worker. The file path
 * is unique to the lease, so a file already at that path belongs to the same lease (a repeated `next`) and
 * stays untouched.
 */
async function prepareResultDir(
    tmpRoot: string,
    sherpaDir: string,
    connection: ServerConnection,
    target: CommandTarget,
): Promise<string> {
    const root = taskResultRootFor(tmpRoot);
    const dir = taskResultDirFor(tmpRoot, sherpaDir, connection.prKey, connection.workerId);
    try {
        await fs.mkdir(root, { recursive: true, mode: RESULT_DIR_MODE });
        await assertPrivateDir(root);
        await fs.mkdir(dir, { recursive: true, mode: RESULT_DIR_MODE });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(
            `sherpa-review: cannot prepare the directory for task results ${dir} — ${detail}.\n` +
                `Fix it or point TMPDIR to a private directory, then call \`${workerNextCommand(target)}\` again.`,
        );
    }
    return dir;
}

/** Only the owning session reads task results. */
const RESULT_DIR_MODE = 0o700;

/**
 * The root is in shared tmp, and someone else may have created it first. A symlink, a directory owned by someone else or an open
 * directory would let others read and replace results. `mkdir` silently accepts an existing directory.
 */
async function assertPrivateDir(dir: string): Promise<void> {
    const uid = process.getuid?.();
    if (uid === undefined) {
        // Windows: each user has their own tmp, with no POSIX permissions.
        return;
    }
    const stats = await fs.lstat(dir);
    if (!stats.isDirectory()) {
        throw new Error(`${dir} is not a directory`);
    }
    if (stats.uid !== uid) {
        throw new Error(`${dir} belongs to another user`);
    }
    if ((stats.mode & 0o077) !== 0) {
        throw new Error(`${dir} is open to other users (mode ${(stats.mode & 0o777).toString(8)})`);
    }
}

/**
 * Waits for a task indefinitely. Swallows the server's `idle` and sends another `next` immediately. Returns
 * only a task, `done` or an error.
 */
async function awaitTask(
    connection: ServerConnection,
    target: CommandTarget,
): Promise<Exclude<WorkerNextResponse, { kind: 'idle' }>> {
    for (;;) {
        const response = await requestNext(connection, target);
        if (response.kind !== 'idle') {
            return response;
        }
    }
}

async function taskComplete(command: Extract<Command, { kind: 'task-complete' }>, io: CliIo): Promise<number> {
    // Resolve the key before reading the file. The resubmission hint prints the full command with `--pr`.
    const prKey = await resolvePrKey(command.prKey, io.env, io.hosts, io.runCommand);
    const target = targetOf(io, prKey);
    // The path is absolute so the resubmission commands in hints work from any cwd.
    const file = path.resolve(command.file);
    const result = await readResultFile(file, command.taskId, target);

    const connection = await connect(prKey, io.env, io.hosts, io.runCommand);
    const response = await requestComplete(connection, target, command.taskId, result);
    io.out(formatCompleteResponse(response, command.taskId, file, target));
    return 0;
}

async function taskProgress(command: Extract<Command, { kind: 'task-progress' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.hosts, io.runCommand);
    const target = targetOf(io, connection.prKey);
    const response = await requestProgress(connection, target, command.taskId, command.text);
    io.out(formatProgressResponse(response, command.taskId, target));
    return 0;
}

async function taskFail(command: Extract<Command, { kind: 'task-fail' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.hosts, io.runCommand);
    const target = targetOf(io, connection.prKey);
    const response = await requestFail(connection, target, command.taskId, command.reason);
    io.out(formatFailResponse(response, command.taskId, target));
    return 0;
}

function entryOf(io: CliIo): string | undefined {
    return io.entry ?? process.argv[1];
}

/**
 * Printed commands call the same CLI file that is running now, with the key it connected to.
 * The path is absolute because the model runs commands from any cwd.
 */
function targetOf(io: CliIo, prKey: string): CommandTarget {
    return { cliPath: path.resolve(entryOf(io) ?? 'sherpa-review.mjs'), prKey };
}

/**
 * Reads the result file with a size precheck. Rejects an oversized result locally,
 * before sending it, so the task stays leased and the model can try to shorten the result.
 */
export async function readResultFile(file: string, taskId: number, target: CommandTarget): Promise<string> {
    const stats = await fs.stat(file).catch(() => null);
    if (stats === null) {
        throw new CliError(
            `sherpa-review: there is no file ${file}.\nWrite the result to ${file} and call ` +
                `\`${taskCompleteCommand(target, taskId, file)}\` again.`,
        );
    }
    if (!stats.isFile()) {
        throw new CliError(`sherpa-review: ${file} is not a file.\nPass the path of the file with the task result.`);
    }
    if (stats.size > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, stats.size, target));
    }

    let result: string;
    try {
        result = await fs.readFile(file, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(`sherpa-review: cannot read ${file} — ${detail}.\nCheck the path and the file permissions.`);
    }

    // File size and string length differ with invalid encoding. Count again using what will go into the body.
    const bytes = Buffer.byteLength(result, 'utf8');
    if (bytes > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, bytes, target));
    }
    return result;
}
