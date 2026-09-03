import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { Locale } from '@sherpa/protocol';

const execFileAsync = promisify(execFile);

/** Result of one shell invocation of the bundle, exactly what the model sees in the harness. */
export interface WorkerRun {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** `worker next` output plus the parsed header of the assigned task, if present. */
export interface NextRun extends WorkerRun {
    /** null means no task was issued (idle, error or server refusal). */
    readonly taskId: number | null;
    /** Task type from the header (`route.skeleton`, `route.section`, `echo`, …). null means no task was assigned. */
    readonly type: string | null;
    /** Attempt number from the header. null means no task was assigned. */
    readonly attempt: number | null;
    /**
     * Planned stop numbers that `route.section` asks to fill.
     * Empty for other task types, whose instructions have no targets.
     */
    readonly planIndexes: readonly number[];
}

export interface FakeWorkerOptions {
    /** Built `dist/sherpa.mjs`. The session uses the same artifact as production. */
    readonly bundlePath: string;
    readonly sherpaDir: string;
    readonly prKey: string;
    /** Where the session puts result files before `task complete`. */
    readonly workDir: string;
    /** Debug identity override. Simulates the "old" session after reconnection. */
    readonly workerId?: string;
}

/**
 * Worker session emulator for protocol tests. Each command is a separate plain
 * node process running the CLI bundle, with only state files retaining data between calls (rpc-design §1).
 * Stopping calls simulates session "death", and a new `register` simulates reconnection.
 */
export class FakeWorker {
    private readonly options: FakeWorkerOptions;
    private resultFiles = 0;

    constructor(options: FakeWorkerOptions) {
        this.options = options;
    }

    /** Same session with an explicit identity, so the "old" session keeps making calls after reconnection. */
    as(workerId: string): FakeWorker {
        return new FakeWorker({ ...this.options, workerId });
    }

    /** id used by this session's commands: the override or the file written by `register`. */
    async workerId(): Promise<string> {
        if (this.options.workerId !== undefined) {
            return this.options.workerId;
        }
        const file = path.join(this.options.sherpaDir, 'prs', this.options.prKey, 'worker-id');
        return (await fs.readFile(file, 'utf8')).trim();
    }

    /** Session labels, the same as in the real skill. Each is optional. */
    async register(harness?: string, lang?: Locale): Promise<WorkerRun> {
        return this.run(
            'worker',
            'register',
            ...(harness === undefined ? [] : ['--harness', harness]),
            ...(lang === undefined ? [] : ['--lang', lang]),
        );
    }

    /** `waitSeconds` is the same as the `--wait-seconds` flag. Without it, the server sets the window. */
    async next(waitSeconds?: number): Promise<NextRun> {
        const argv =
            waitSeconds === undefined
                ? (['worker', 'next'] as const)
                : (['worker', 'next', '--wait-seconds', String(waitSeconds)] as const);
        const run = await this.run(...argv);
        return { ...run, ...parseTaskHead(run.stdout), planIndexes: parsePlanIndexes(run.stdout) };
    }

    /** Submits a result. Writes the file automatically, as the model does before calling the command. */
    async complete(taskId: number, content: string): Promise<WorkerRun> {
        this.resultFiles += 1;
        const file = path.join(this.options.workDir, `result-${String(this.resultFiles)}.md`);
        await fs.writeFile(file, content);
        return this.run('task', 'complete', String(taskId), '--file', file);
    }

    async progress(taskId: number, text: string): Promise<WorkerRun> {
        return this.run('task', 'progress', String(taskId), '--text', text);
    }

    async fail(taskId: number, reason: string): Promise<WorkerRun> {
        return this.run('task', 'fail', String(taskId), '--reason', reason);
    }

    /** Arbitrary bundle invocation. All scenario commands go through here. */
    async run(...argv: string[]): Promise<WorkerRun> {
        const env: Record<string, string> = {
            ...(process.env as Record<string, string>),
            SHERPA_DIR: this.options.sherpaDir,
            SHERPA_PR: this.options.prKey,
        };
        if (this.options.workerId === undefined) {
            // Otherwise an inherited developer override would replace the session identity.
            delete env.SHERPA_WORKER_ID;
        } else {
            env.SHERPA_WORKER_ID = this.options.workerId;
        }

        try {
            const { stdout, stderr } = await execFileAsync(process.execPath, [this.options.bundlePath, ...argv], {
                env,
                cwd: this.options.workDir,
                encoding: 'utf8',
            });
            return { code: 0, stdout, stderr };
        } catch (error) {
            return failedRun(error);
        }
    }
}

/**
 * The `TASK sherpa/<id> (<type>), attempt <n>` header from the prompt format (`format.ts`).
 * This is a test format with no strict contract.
 */
function parseTaskHead(stdout: string): Pick<NextRun, 'taskId' | 'type' | 'attempt'> {
    const match = /TASK sherpa\/(\d+) \(([^)]+)\), attempt (\d+)/.exec(stdout);
    if (match?.[1] === undefined || match[2] === undefined || match[3] === undefined) {
        return { taskId: null, type: null, attempt: null };
    }
    return { taskId: Number(match[1]), type: match[2], attempt: Number(match[3]) };
}

/**
 * Target stops for a fill task from its instructions (`sectionInstructions`). The loop submits exactly
 * the requested numbers without relying on the order tasks enter the queue.
 */
function parsePlanIndexes(stdout: string): readonly number[] {
    const match = /Fill in (?:this stop|these stops) of the review route: ([\d, ]+)\./.exec(stdout);
    if (match?.[1] === undefined) {
        return [];
    }
    return match[1]
        .split(',')
        .map((part) => Number(part.trim()))
        .filter((value) => Number.isInteger(value));
}

interface ExecFileFailure {
    code?: number;
    stdout?: string;
    stderr?: string;
}

/** A nonzero code is a normal protocol outcome (`sherpa` reports rejections this way), not a test failure. */
function failedRun(error: unknown): WorkerRun {
    if (!(error instanceof Error)) {
        throw new Error(`sherpa invocation failed with a non-error: ${String(error)}`);
    }

    const failure = error as Error & ExecFileFailure;
    if (typeof failure.stdout !== 'string' || typeof failure.stderr !== 'string') {
        throw error;
    }
    return { code: failure.code ?? 1, stdout: failure.stdout, stderr: failure.stderr };
}
