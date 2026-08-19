import fs from 'node:fs/promises';

import { RESULT_MAX_BYTES } from '@sherpa/protocol';

import type { Command } from './args.js';
import { parseArgs } from './args.js';
import { requestComplete, requestFail, requestNext, requestProgress } from './client.js';
import { connect } from './discovery.js';
import { CliError, userMessage } from './errors.js';
import {
    formatCompleteResponse,
    formatDone,
    formatFailResponse,
    formatOversizedResult,
    formatProgressResponse,
    formatTask,
    helpText,
} from './format.js';
import { CLI_VERSION } from './version.js';

/** Invocation environment. Tests supply their own to run commands as functions instead of processes. */
export interface CliIo {
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly out: (text: string) => void;
    readonly err: (text: string) => void;
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
            `sherpa: file ${file} does not exist.\nSave the result to a file and call ` +
                `\`sherpa task complete ${String(taskId)} --file <path>\` again.`,
        );
    }
    if (!stats.isFile()) {
        throw new CliError(`sherpa: ${file} is not a file.\nProvide the path to the file with the task result.`);
    }
    if (stats.size > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, stats.size));
    }

    let result: string;
    try {
        result = await fs.readFile(file, 'utf8');
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new CliError(`sherpa: cannot read ${file}: ${detail}.\nCheck the path and file permissions.`);
    }

    // File size and string length differ with invalid encoding. Count again using what will go into the body.
    const bytes = Buffer.byteLength(result, 'utf8');
    if (bytes > RESULT_MAX_BYTES) {
        throw new CliError(formatOversizedResult(taskId, file, bytes));
    }
    return result;
}
