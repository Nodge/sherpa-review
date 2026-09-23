import fs from 'node:fs/promises';

import type { WorkerNextResponse, WorkerRegisterResponse } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';

import type { Command } from './args.js';
import { parseArgs } from './args.js';
import type { OpenBrowserOptions } from './browser.js';
import { openBrowser } from './browser.js';
import type { WorkerLabels } from './client.js';
import { requestComplete, requestFail, requestNext, requestProgress, requestRegister } from './client.js';
import type { ServerConnection } from './discovery.js';
import { connect, connectAs, freshWorkerId, resolvePrKey } from './discovery.js';
import { CliError, userMessage } from './errors.js';
import {
    formatCompleteResponse,
    formatDone,
    formatFailResponse,
    formatOversizedResult,
    formatProgressResponse,
    formatTask,
    formatUpReady,
    helpText,
} from './format.js';
import { resolveLocalTarget } from './local.js';
import { serverBinOverrideFrom, sherpaDirFrom } from './paths.js';
import type { CommandRunner } from './pr-discovery.js';
import type { EnsureServerOptions, EnsureServerResult } from './up.js';
import { ensureServer } from './up.js';
import { CLI_VERSION } from './version.js';

/** Invocation environment. Tests supply their own to run commands as functions instead of processes. */
export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    /** Path to the running CLI file: `up` looks for the server bundle beside it. Defaults to `process.argv[1]`. */
    readonly entry?: string;
    /** External command runner for PR discovery from cwd. Defaults to the real Git executable. */
    readonly runCommand?: CommandRunner;
    /** Test substitute for server discovery/startup. */
    readonly ensureServer?: (options: EnsureServerOptions) => Promise<EnsureServerResult>;
    /** Test substitute for the system opener. Tests don't launch a real browser. */
    readonly openBrowser?: (options: OpenBrowserOptions) => void;
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
    // and discovery from cwd (`pr-discovery.ts`) must happen exactly once per command.
    // `--local` names a directory, not a PR. The key comes from the directory and branch, not the host.
    const local =
        command.local === undefined
            ? null
            : await resolveLocalTarget(command.local, command.base, io.runCommand);
    const prKey = local?.prKey ?? (await resolvePrKey(command.prKey, io.env, io.runCommand));

    const server = await (io.ensureServer ?? ensureServer)({
        prKey,
        sherpaDir: sherpaDirFrom(io.env),
        entry: io.entry ?? process.argv[1],
        serverBin: serverBinOverrideFrom(io.env),
        ...(local === null ? {} : { repo: local.repo, base: local.base, branch: local.branch }),
    });
    // A fresh session always gets the worker slot. The server takes it even from a live previous session,
    // so `up` registers through the normal path, with no fallback paths.
    await registerWorker(prKey, labelsOf(command), io);

    io.out(formatUpReady(server.uiUrl, prKey, local));
    if (server.started && !command.noOpen) {
        try {
            (io.openBrowser ?? openBrowser)({ uiUrl: server.uiUrl });
        } catch {
            // The link is already printed. Headless/ssh use and opener failure don't turn a successful up into an error.
        }
    }
    return 0;
}

async function workerRegister(command: Extract<Command, { kind: 'worker-register' }>, io: CliIo): Promise<number> {
    const response = await registerWorker(command.prKey, labelsOf(command), io);

    // The server text already contains the next loop step. The CLI prints it as is.
    io.out(response.message);
    return 0;
}

/**
 * Registers a session as the PR worker. Each session gets a fresh identity.
 * The server writes it to the state file while handling `register` (`worker-id-file.ts`):
 * two parallel sessions must have exactly as many writers to the shared file as there are
 * owners of the slot: one.
 */
async function registerWorker(
    prKeyArg: string | undefined,
    labels: WorkerLabels,
    io: CliIo,
): Promise<WorkerRegisterResponse> {
    const connection = await connectAs(prKeyArg, io.env, freshWorkerId(io.env), io.runCommand);
    return requestRegister(connection, labels);
}

/** Session labels from command arguments. `up` and `worker register` declare them the same way. */
function labelsOf(command: Extract<Command, { kind: 'up' | 'worker-register' }>): WorkerLabels {
    return { harness: command.harness, model: command.model, lang: command.lang };
}

async function workerNext(command: Extract<Command, { kind: 'worker-next' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.runCommand);
    const response = await awaitTask(connection);

    switch (response.kind) {
        case 'task':
            io.out(formatTask(response.task));
            return 0;
        case 'done':
            io.out(formatDone(response.message));
            return 0;
    }
}

/**
 * Waits for a task indefinitely. Swallows the server's `idle` and sends another `next` immediately. Returns
 * only a task, `done` or an error.
 */
async function awaitTask(connection: ServerConnection): Promise<Exclude<WorkerNextResponse, { kind: 'idle' }>> {
    for (;;) {
        const response = await requestNext(connection);
        if (response.kind !== 'idle') {
            return response;
        }
    }
}

async function taskComplete(command: Extract<Command, { kind: 'task-complete' }>, io: CliIo): Promise<number> {
    const result = await readResultFile(command.file, command.taskId);

    const connection = await connect(command.prKey, io.env, io.runCommand);
    const response = await requestComplete(connection, command.taskId, result);
    io.out(formatCompleteResponse(response, command.taskId));
    return 0;
}

async function taskProgress(command: Extract<Command, { kind: 'task-progress' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.runCommand);
    const response = await requestProgress(connection, command.taskId, command.text);
    io.out(formatProgressResponse(response, command.taskId));
    return 0;
}

async function taskFail(command: Extract<Command, { kind: 'task-fail' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env, io.runCommand);
    const response = await requestFail(connection, command.taskId, command.reason);
    io.out(formatFailResponse(response, command.taskId));
    return 0;
}

/**
 * Reads the result file with a size precheck. Rejects an oversized result locally,
 * before sending it, so the task stays leased and the model can try to shorten the result.
 */
export async function readResultFile(file: string, taskId: number): Promise<string> {
    const stats = await fs.stat(file).catch(() => null);
    if (stats === null) {
        throw new CliError(
            `sherpa: there is no file ${file}.\nSave the result to a file and call ` +
                `\`sherpa task complete ${String(taskId)} --file <path>\` again.`,
        );
    }
    if (!stats.isFile()) {
        throw new CliError(`sherpa: ${file} is not a file.\nPass the path of the file with the task result.`);
    }
    if (stats.size > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, stats.size));
    }

    let result: string;
    try {
        result = await fs.readFile(file, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(`sherpa: cannot read ${file} — ${detail}.\nCheck the path and the file permissions.`);
    }

    // File size and string length differ with invalid encoding. Count again using what will go into the body.
    const bytes = Buffer.byteLength(result, 'utf8');
    if (bytes > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, bytes));
    }
    return result;
}
