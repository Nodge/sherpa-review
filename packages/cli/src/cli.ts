import fs from 'node:fs/promises';

import type { WorkerRegisterResponse } from '@sherpa/protocol';
import { RESULT_MAX_BYTES } from '@sherpa/protocol';

import type { Command } from './args.js';
import { parseArgs } from './args.js';
import type { WorkerLabels } from './client.js';
import { requestComplete, requestFail, requestNext, requestProgress, requestRegister } from './client.js';
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
import { serverBinOverrideFrom, sherpaDirFrom } from './paths.js';
import { ensureServer } from './up.js';
import { CLI_VERSION } from './version.js';

/** Invocation environment. Tests supply their own to run commands as functions instead of processes. */
export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
    /** Path to the running CLI file: `up` looks for the server bundle beside it. Defaults to `process.argv[1]`. */
    readonly entry?: string;
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
 * Bootstraps the session in one command (rpc-design §3): start the PR server, register
 * as a worker and return the UI link. The model knows nothing about the server or registration. It sees only the link
 * and the next step of the loop.
 */
async function up(command: Extract<Command, { kind: 'up' }>, io: CliIo): Promise<number> {
    // Validate the PR key before starting the server: the server would reject a bad key too, but later and at greater cost.
    const prKey = resolvePrKey(command.prKey, io.env);

    const uiUrl = await ensureServer({
        prKey,
        sherpaDir: sherpaDirFrom(io.env),
        entry: io.entry ?? process.argv[1],
        serverBin: serverBinOverrideFrom(io.env),
    });
    // A fresh session always gets the worker slot: the server takes it even from a live previous session
    // (decision 2026-08-20), so `up` registers through the normal path with no fallback.
    await registerWorker(prKey, labelsOf(command), io);

    io.out(formatUpReady(uiUrl, prKey));
    return 0;
}

async function workerRegister(command: Extract<Command, { kind: 'worker-register' }>, io: CliIo): Promise<number> {
    const response = await registerWorker(command.prKey, labelsOf(command), io);

    // The server text already contains the next loop step. The CLI prints it as is.
    io.out(response.message);
    return 0;
}

/**
 * Registers a session as the PR worker: each session has a fresh identity (decision log).
 * The server writes it to the state file while handling `register` (`worker-id-file.ts`):
 * two parallel sessions must have exactly as many writers to the shared file as there are
 * owners of the slot: one.
 */
async function registerWorker(
    prKeyArg: string | undefined,
    labels: WorkerLabels,
    io: CliIo,
): Promise<WorkerRegisterResponse> {
    const connection = await connectAs(prKeyArg, io.env, freshWorkerId(io.env));
    return requestRegister(connection, labels);
}

/** Session labels from command arguments. `up` and `worker register` declare them the same way. */
function labelsOf(command: Extract<Command, { kind: 'up' | 'worker-register' }>): WorkerLabels {
    return { harness: command.harness, model: command.model };
}

async function workerNext(command: Extract<Command, { kind: 'worker-next' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
    const response = await requestNext(connection);

    switch (response.kind) {
        case 'task':
            io.out(formatTask(response.task));
            return 0;
        case 'idle':
            io.out(response.message);
            return 0;
        case 'done':
            io.out(formatDone(response.message));
            return 0;
    }
}

async function taskComplete(command: Extract<Command, { kind: 'task-complete' }>, io: CliIo): Promise<number> {
    const result = await readResultFile(command.file, command.taskId);

    const connection = await connect(command.prKey, io.env);
    const response = await requestComplete(connection, command.taskId, result);
    io.out(formatCompleteResponse(response, command.taskId));
    return 0;
}

async function taskProgress(command: Extract<Command, { kind: 'task-progress' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
    const response = await requestProgress(connection, command.taskId, command.text);
    io.out(formatProgressResponse(response, command.taskId));
    return 0;
}

async function taskFail(command: Extract<Command, { kind: 'task-fail' }>, io: CliIo): Promise<number> {
    const connection = await connect(command.prKey, io.env);
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
