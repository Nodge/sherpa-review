import fs from 'node:fs';
import path from 'node:path';

import type {
    ChatAnchor,
    ChatExchange,
    FileContent,
    PrDiff,
    PrMeta,
    ReviewHost,
    UiChatAskAnchor,
    UiChatCancelResponse,
    UiChatRetryResponse,
} from '@sherpa/protocol';

import { buildChatPayload, materializeChatPayload, questionDirIn } from './chat-payload.js';
import type { ChatStore, StoredChatExchange } from './chat-store.js';
import { RpcFailure } from './errors.js';
import type { IterationStore } from './iteration-store.js';
import { rememberIterationDiff } from './iteration-store.js';
import type { EnqueueInput, TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import type { RouteStore } from './route-store.js';
import { voiceErrors } from './route/voice.js';
import type { SharedPayloadStore } from './shared-payload.js';
import { holdsPayload } from './shared-payload.js';

export interface ChatOrchestratorOptions {
    readonly store: ChatStore;
    readonly route: RouteStore;
    readonly queue: TaskQueue;
    readonly host: ReviewHost | null;
    readonly payloadDir: string;
    /** Local storage for iteration patches. `null` means nowhere to save the diff (tests without a database). */
    readonly iterations?: IterationStore | null;
    /** Shared question context: guide, PR diff and file contents at stable paths. */
    readonly shared: SharedPayloadStore;
}

/**
 * Links a chat exchange to one current queue task. Reconciliation restores state,
 * so a restart between operations needs no separate event log.
 */
export class ChatOrchestrator {
    private readonly store: ChatStore;
    private readonly route: RouteStore;
    private readonly queue: TaskQueue;
    private readonly host: ReviewHost | null;
    private readonly payloadDir: string;
    private readonly iterations: IterationStore | null;
    private readonly shared: SharedPayloadStore;
    /**
     * Directories for questions whose tasks have not been enqueued: an await between writing the payload and enqueueing
     * lets cleanup run, which uses queued tasks and would delete the new directory.
     */
    private readonly reservedDirs = new Set<string>();

    private unsubscribeQueue: (() => void) | null = null;
    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: ChatOrchestratorOptions) {
        this.store = options.store;
        this.route = options.route;
        this.queue = options.queue;
        this.host = options.host;
        this.payloadDir = options.payloadDir;
        this.iterations = options.iterations ?? null;
        this.shared = options.shared;
    }

    start(): void {
        this.unsubscribeQueue = this.queue.subscribeChanges(() => {
            this.reconcile();
        });
        this.reconcile();
    }

    close(): void {
        this.closed = true;
        this.unsubscribeQueue?.();
    }

    async ask(question: string, requested: UiChatAskAnchor | null): Promise<ChatExchange> {
        const context = await this.loadPrContext(requested);
        const anchor = resolveAskAnchor(requested, context.diff);
        const taskDir = questionDirIn(this.payloadDir);
        this.reservedDirs.add(taskDir);
        try {
            const input = await this.materialize(taskDir, question, anchor, context);
            return this.store.ask(question, anchor, context.headCommit, () =>
                this.queue.enqueueInTransaction(input),
            );
        } finally {
            this.reservedDirs.delete(taskDir);
        }
    }

    cancel(exchangeId: number): UiChatCancelResponse['outcome'] {
        const stored = this.store.exchange(exchangeId);
        if (stored === null || (stored.exchange.status !== 'queued' && stored.exchange.status !== 'running')) {
            return 'noop';
        }

        if (stored.exchange.taskId !== null) {
            this.queue.cancel(stored.exchange.taskId);
        }
        this.store.cancelExchange(exchangeId);
        return 'cancelled';
    }

    async retry(exchangeId: number): Promise<UiChatRetryResponse['outcome']> {
        const stored = this.store.exchange(exchangeId);
        if (stored === null || (stored.exchange.status !== 'failed' && stored.exchange.status !== 'cancelled')) {
            return 'noop';
        }

        const context = await this.loadPrContext(stored.exchange.anchor);
        const taskDir = questionDirIn(this.payloadDir);
        this.reservedDirs.add(taskDir);
        try {
            const input = await this.materialize(
                taskDir,
                stored.exchange.question,
                stored.exchange.anchor,
                context,
            );
            return this.store.retry(exchangeId, context.headCommit, () => this.queue.enqueueInTransaction(input))
                ? 'retried'
                : 'noop';
        } finally {
            this.reservedDirs.delete(taskDir);
        }
    }

    /** Question-specific files go in the question directory, unchanged files use a shared path (`shared-payload.ts`). */
    private materialize(
        taskDir: string,
        question: string,
        anchor: ChatAnchor | null,
        context: PrContext,
    ): Promise<EnqueueInput> {
        return materializeChatPayload(
            taskDir,
            this.shared,
            buildChatPayload({
                question,
                anchor,
                pr: context.pr,
                diff: context.diff,
                fileContent: context.fileContent,
                route: this.route.read(),
                history: this.store.read().exchanges,
            }),
        );
    }

    /** Other task types return `null`: the composite result handler in `server.ts` continues dispatching. */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'chat') {
            return null;
        }

        const stored = this.store.exchangeForTask(task.id);
        if (
            stored?.exchange.taskId !== task.id ||
            (stored.exchange.status !== 'queued' && stored.exchange.status !== 'running')
        ) {
            return {
                kind: 'rejected',
                errors: ['This chat task no longer belongs to an active reviewer question. Call `worker next`.'],
            };
        }

        const errors = chatResultErrors(result);
        if (errors.length > 0) {
            return { kind: 'rejected', errors };
        }
        return {
            kind: 'accepted',
            onCommitted: () => {
                this.store.completeTask(task.id, result);
            },
        };
    }

    private reconcile(): void {
        if (this.closed) {
            return;
        }
        if (this.reconciling) {
            this.reconcileAgain = true;
            return;
        }

        this.reconciling = true;
        try {
            do {
                this.reconcileAgain = false;
                this.reconcileOnce();
            } while (this.needsAnotherPass());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-server: chat reconciliation failed: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private reconcileOnce(): void {
        const tasks = this.queue.listTasks();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        const boundTaskIds = new Set(
            this.store.openExchanges().flatMap(({ exchange }) => (exchange.taskId === null ? [] : [exchange.taskId])),
        );

        for (const task of tasks) {
            const open = task.status === 'queued' || task.status === 'leased';
            if (task.type === 'chat' && open && !boundTaskIds.has(task.id)) {
                this.queue.cancel(task.id);
            }
        }

        for (const stored of this.store.openExchanges()) {
            const taskId = stored.exchange.taskId;
            this.reconcileExchange(stored, taskId === null ? null : (byId.get(taskId) ?? null));
        }

        this.sweepQuestionDirs(tasks);
    }

    /**
     * A question directory lives exactly as long as its task: a task that is closed and held by no worker
     * no longer reads its context. The first reconciliation runs at server startup, so it also
     * removes directories whose tasks did not survive the restart.
     *
     * The task list is read before this reconciliation's changes: a stale entry keeps the directory for an extra pass,
     * which is the safe side to err on. The context of a live task must never be deleted.
     */
    private sweepQuestionDirs(tasks: readonly TaskRecord[]): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.payloadDir);
        } catch {
            return;
        }

        const keep = new Set(this.reservedDirs);
        for (const task of tasks) {
            if (!holdsPayload(task)) {
                continue;
            }
            for (const file of task.contextFiles) {
                const dir = questionDirOf(this.payloadDir, file);
                if (dir !== null) {
                    keep.add(dir);
                }
            }
        }

        for (const entry of entries) {
            const dir = path.join(this.payloadDir, entry);
            if (!keep.has(dir)) {
                fs.rmSync(dir, { recursive: true, force: true });
            }
        }
    }

    private reconcileExchange(stored: StoredChatExchange, task: TaskRecord | null): void {
        if (task === null) {
            this.store.failExchange(
                stored.exchange.id,
                'The answer task was lost after the server restart. Your question is saved and can be retried.',
            );
            return;
        }

        if (
            (task.status === 'queued' || task.status === 'leased') &&
            task.lastLeaseReturnReason === 'expired'
        ) {
            this.store.failExchange(
                stored.exchange.id,
                'The agent stopped responding during the question. Your question is saved and can be retried.',
            );
            this.queue.cancel(task.id);
            return;
        }

        switch (task.status) {
            case 'queued':
                this.store.syncTask(task.id, 'queued', null, null);
                return;
            case 'leased':
                this.store.syncTask(task.id, 'running', task.progressText, null);
                return;
            case 'failed':
                this.store.syncTask(task.id, 'failed', null, chatFailure(task));
                return;
            case 'cancelled':
                this.store.syncTask(task.id, 'cancelled', null, null);
                return;
            case 'done': {
                const result = task.result ?? '';
                const errors = chatResultErrors(result);
                if (errors.length > 0) {
                    this.store.failExchange(
                        stored.exchange.id,
                        'The saved answer failed validation after the server restart. You can retry the question.',
                    );
                    return;
                }
                this.store.completeTask(task.id, result);
                return;
            }
        }
    }

    private async loadPrContext(anchor: { fileId: string } | null): Promise<PrContext> {
        const host = this.host;
        if (host === null) {
            return { pr: null, diff: null, fileContent: null, headCommit: null };
        }

        const getFileContent = host.getFileContent?.bind(host);
        const [pr, diff, fileContent] = await Promise.all([
            host.getPr().then(
                (value) => value,
                () => null,
            ),
            host.getDiff().then(
                (value) => value,
                () => null,
            ),
            anchor === null || getFileContent === undefined
                ? Promise.resolve(null)
                : getFileContent(anchor.fileId).then(
                      (value) => value,
                      () => null,
                  ),
        ]);
        if (this.iterations !== null && diff !== null) {
            // Store the active iteration diff used to build the question context.
            void rememberIterationDiff(this.iterations, host, diff);
        }
        return { pr, diff, fileContent, headCommit: diff?.headCommit ?? null };
    }
}

/** A UI anchor without `diffId` refers to the active iteration. Its id comes from the loaded diff. */
function resolveAskAnchor(anchor: UiChatAskAnchor | null, diff: PrDiff | null): ChatAnchor | null {
    if (anchor === null) {
        return null;
    }
    if (anchor.diffId !== undefined) {
        return { ...anchor, diffId: anchor.diffId };
    }
    if (diff === null) {
        throw new RpcFailure('bad_request', 'Question anchor has no diffId and there is no active iteration: the host is unavailable.');
    }
    return { ...anchor, diffId: diff.diffId };
}

/** What the host supplied for this question. Failure of any part narrows the context without cancelling the question. */
interface PrContext {
    readonly pr: PrMeta | null;
    readonly diff: PrDiff | null;
    readonly fileContent: FileContent | null;
    readonly headCommit: string | null;
}

function chatResultErrors(result: string): string[] {
    if (result.trim() === '') {
        return ['The chat answer is empty. Return a non-empty Markdown answer.'];
    }
    return voiceErrors('answer', result);
}

/** Question directory that owns the path. `null` means the path is outside question directories (a shared file). */
function questionDirOf(payloadDir: string, file: string): string | null {
    const relative = path.relative(payloadDir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    const [name] = relative.split(path.sep);
    return name === undefined || name === '' ? null : path.join(payloadDir, name);
}

function chatFailure(task: TaskRecord): string {
    const reason = (task.failReason ?? '').trim();
    return reason === '' ? 'The agent did not answer or give a reason.' : `The agent did not answer: ${reason}`;
}
