import type {
    ChatAnchor,
    ChatExchange,
    FileContent,
    PrDiff,
    PrMeta,
    ReviewHost,
    UiChatCancelResponse,
    UiChatRetryResponse,
} from '@sherpa/protocol';

import { buildChatPayload, materializeChatPayload } from './chat-payload.js';
import type { ChatStore, StoredChatExchange } from './chat-store.js';
import type { TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import type { RouteStore } from './route-store.js';
import { voiceErrors } from './route/voice.js';

export interface ChatOrchestratorOptions {
    readonly store: ChatStore;
    readonly route: RouteStore;
    readonly queue: TaskQueue;
    readonly host: ReviewHost | null;
    readonly payloadDir: string;
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

    async ask(question: string, anchor: ChatAnchor | null): Promise<ChatExchange> {
        const context = await this.loadPrContext(anchor);
        const input = await materializeChatPayload(
            this.payloadDir,
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
        return this.store.ask(question, anchor, context.headCommit, () => this.queue.enqueueInTransaction(input));
    }

    cancel(exchangeId: number): UiChatCancelResponse['outcome'] {
        const stored = this.store.exchange(exchangeId);
        if (stored === null || (stored.exchange.status !== 'queued' && stored.exchange.status !== 'running')) {
            return 'noop';
        }

        if (stored.taskId !== null) {
            this.queue.cancel(stored.taskId);
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
        const input = await materializeChatPayload(
            this.payloadDir,
            buildChatPayload({
                question: stored.exchange.question,
                anchor: stored.exchange.anchor,
                pr: context.pr,
                diff: context.diff,
                fileContent: context.fileContent,
                route: this.route.read(),
                history: this.store.read().exchanges,
            }),
        );
        return this.store.retry(exchangeId, context.headCommit, () => this.queue.enqueueInTransaction(input))
            ? 'retried'
            : 'noop';
    }

    /** Other task types return `null`: the composite result handler in `server.ts` continues dispatching. */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'chat') {
            return null;
        }

        const stored = this.store.exchangeForTask(task.id);
        if (
            stored?.taskId !== task.id ||
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
            this.store
                .openExchanges()
                .flatMap((stored) => (stored.taskId === null ? [] : [stored.taskId])),
        );

        for (const task of tasks) {
            const open = task.status === 'queued' || task.status === 'leased';
            if (task.type === 'chat' && open && !boundTaskIds.has(task.id)) {
                this.queue.cancel(task.id);
            }
        }

        for (const stored of this.store.openExchanges()) {
            this.reconcileExchange(stored, stored.taskId === null ? null : (byId.get(stored.taskId) ?? null));
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

    private async loadPrContext(anchor: ChatAnchor | null): Promise<{
        pr: PrMeta | null;
        diff: PrDiff | null;
        fileContent: FileContent | null;
        headCommit: string | null;
    }> {
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
        return { pr, diff, fileContent, headCommit: diff?.headCommit ?? null };
    }
}

function chatResultErrors(result: string): string[] {
    if (result.trim() === '') {
        return ['The chat answer is empty. Return a non-empty Markdown answer.'];
    }
    return voiceErrors('answer', result);
}

function chatFailure(task: TaskRecord): string {
    const reason = (task.failReason ?? '').trim();
    return reason === '' ? 'The agent did not answer or give a reason.' : `The agent did not answer: ${reason}`;
}
