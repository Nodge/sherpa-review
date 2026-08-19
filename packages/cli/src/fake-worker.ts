import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Result of one shell invocation of the bundle, exactly what the model sees in the harness. */
export interface WorkerRun {
    readonly code: number;
    readonly stdout: string;
    readonly stderr: string;
}

/** `worker next` output and the issued task number, if present. */
export interface NextRun extends WorkerRun {
    /** null means no task was issued (idle, error or server refusal). */
    readonly taskId: number | null;
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

    async register(harness?: string): Promise<WorkerRun> {
        return harness === undefined
            ? this.run('worker', 'register')
            : this.run('worker', 'register', '--harness', harness);
    }

    async next(): Promise<NextRun> {
        const run = await this.run('worker', 'next');
        return { ...run, taskId: parseTaskId(run.stdout) };
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

/** `TASK sherpa/<id>` from the prompt format (`format.ts`). Test-only format, no strict contract. */
function parseTaskId(stdout: string): number | null {
    const match = /TASK sherpa\/(\d+)/.exec(stdout);
    return match?.[1] === undefined ? null : Number(match[1]);
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
