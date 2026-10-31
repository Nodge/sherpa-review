import fs from 'node:fs';
import path from 'node:path';

import type { Locale, ReviewUser } from '@sherpa/protocol';
import { reviewFeedbackResultSchema } from '@sherpa/protocol';

import { buildFeedbackPayload, materializeFeedbackPayload } from './feedback-payload.js';
import type { FeedbackStore } from './feedback-store.js';
import { resolveGenerationLocale } from './generation-locale.js';
import type { FeedbackHost, FeedbackReply } from './hosts/plugin.js';
import type { TaskQueue, TaskRecord, TaskResultAcceptance } from './queue.js';
import { voiceErrors } from './route/voice.js';
import { holdsPayload } from './shared-payload.js';
import type { SettingsStore } from './settings-store.js';
import type { WorkerRegistry } from './worker-registry.js';

/**
 * A local review publication round becomes a `review.feedback` agent task. The agent edits code,
 * replies to threads, and its replies become regular comments. Working-tree polling then closes
 * the loop: agent edits create a new iteration, making the route stale.
 *
 * The host owns round state, while SQLite (`feedback-store.ts`) stores the link to the queue.
 * Reconciliation restores that link. There is no event log.
 */

export interface FeedbackOrchestratorOptions {
    readonly host: FeedbackHost;
    readonly queue: TaskQueue;
    readonly store: FeedbackStore;
    /** Round payload root, with one subdirectory per round. */
    readonly payloadDir: string;
    /** UI settings supply the language the agent uses to reply to the reviewer. */
    readonly settings?: Pick<SettingsStore, 'read'> | null;
    /** Worker registry: its harness and model sign agent replies, and `lang` is part of language resolution. */
    readonly registry?: Pick<WorkerRegistry, 'status'> | null;
}

/** What acceptance knows about a round without asking the host: validation is synchronous, inside a transaction. */
interface BoundRound {
    readonly roundId: string;
    readonly threadIds: ReadonlySet<string>;
}

export class FeedbackOrchestrator {
    private readonly host: FeedbackHost;
    private readonly queue: TaskQueue;
    private readonly store: FeedbackStore;
    private readonly payloadDir: string;
    private readonly settings: Pick<SettingsStore, 'read'> | null;
    private readonly registry: Pick<WorkerRegistry, 'status'> | null;

    /** Threads for live tasks: acceptance is synchronous, while the host returns a promise. */
    private readonly boundTasks = new Map<number, BoundRound>();

    private closed = false;
    private reconciling = false;
    private reconcileAgain = false;

    constructor(options: FeedbackOrchestratorOptions) {
        this.host = options.host;
        this.queue = options.queue;
        this.store = options.store;
        this.payloadDir = options.payloadDir;
        this.settings = options.settings ?? null;
        this.registry = options.registry ?? null;
    }

    close(): void {
        this.closed = true;
    }

    /**
     * Reconciles rounds with the queue: enqueues a task for each `pending` round without a live task.
     *
     * A failed task leaves its round `pending`, but it is not retried,
     * otherwise the loop would keep running the same impossible task. The reviewer still has a way forward:
     * the next publication opens a new round that includes the old comments.
     *
     * Idempotent, called on each event: server start and successful publication.
     */
    async reconcile(): Promise<void> {
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
                await this.reconcileOnce();
            } while (this.needsAnotherPass());
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(`sherpa-review-server: review round reconciliation failed: ${message}\n`);
        } finally {
            this.reconciling = false;
        }
    }

    /** Reads flags through a method so type narrowing does not hide changes made by other calls. */
    private needsAnotherPass(): boolean {
        return this.reconcileAgain && !this.closed;
    }

    private async reconcileOnce(): Promise<void> {
        const rounds = await this.host.pendingRounds();
        if (this.closed) {
            return;
        }

        const tasks = this.queue.listTasks();
        const byId = new Map(tasks.map((task) => [task.id, task]));
        this.cancelOrphanTasks(tasks);
        // Clean up before enqueuing: directories from this pass are absent from the task list snapshot,
        // so reconciliation would delete the context just written.
        this.sweepRoundDirs(tasks);

        for (const round of rounds) {
            const binding = this.store.ofRound(round.id);
            // Do not enqueue failures or accepted results again: the next publication sends the round
            // to the agent, while a retry would loop or duplicate replies.
            if (binding !== null && binding.state !== 'open') {
                continue;
            }

            const task = binding === null ? null : (byId.get(binding.taskId) ?? null);
            if (task !== null && (task.status === 'queued' || task.status === 'leased')) {
                // The task is live, so acceptance must have its round threads even after restart.
                this.boundTasks.set(task.id, { roundId: round.id, threadIds: new Set(round.threadIds) });
                continue;
            }
            if (task !== null && task.status !== 'done') {
                this.store.setState(round.id, 'failed');
                continue;
            }
            await this.enqueueRound(round.id);
        }
    }

    /**
     * A round task with no open binding means the process crashed between
     * enqueuing the task and writing its binding. The agent no longer needs this task because acceptance
     * would reject its result.
     */
    private cancelOrphanTasks(tasks: readonly TaskRecord[]): void {
        const open = new Set(
            this.store
                .list()
                .filter((binding) => binding.state === 'open')
                .map((binding) => binding.taskId),
        );
        for (const task of tasks) {
            const live = task.status === 'queued' || task.status === 'leased';
            if (task.type === 'review.feedback' && live && !open.has(task.id)) {
                this.queue.cancel(task.id);
            }
        }
    }

    /**
     * A round directory lives exactly as long as its task: a closed task that no one holds
     * no longer reads its context (docs/protocol.md §4). The first reconciliation runs when the server
     * starts and removes directories whose tasks did not survive restart.
     */
    private sweepRoundDirs(tasks: readonly TaskRecord[]): void {
        let entries: string[];
        try {
            entries = fs.readdirSync(this.payloadDir);
        } catch {
            return;
        }

        const keep = new Set<string>();
        for (const task of tasks) {
            if (!holdsPayload(task)) {
                continue;
            }
            for (const file of task.contextFiles) {
                const dir = roundDirOf(this.payloadDir, file);
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

    private async enqueueRound(roundId: string): Promise<void> {
        const context = await this.host.roundContext(roundId);
        if (this.closed) {
            return;
        }

        // Fix the language here: the task requests replies in this language, and acceptance validates
        // their voice against it. Settings changes before submission cannot alter validation.
        const locale = this.locale();
        const payload = buildFeedbackPayload(context, locale);
        const input = await materializeFeedbackPayload(path.join(this.payloadDir, roundId), payload);
        const task = this.queue.enqueue(input);
        this.store.bind(roundId, task.id, locale);
        this.boundTasks.set(task.id, {
            roundId,
            threadIds: new Set(context.threads.map((thread) => thread.threadId)),
        });
    }

    /** Other task types return `null`: the composite result handler in `server.ts` continues dispatching. */
    acceptResult(task: TaskRecord, result: string): TaskResultAcceptance | null {
        if (task.type !== 'review.feedback') {
            return null;
        }

        const binding = this.store.ofTask(task.id);
        if (binding?.state !== 'open') {
            return {
                kind: 'rejected',
                errors: ['This task no longer belongs to an open review round. Call `worker next`.'],
            };
        }

        const bound = this.boundTasks.get(task.id);
        if (bound === undefined) {
            // The round threads are not loaded yet (restart during a task), so validation is impossible.
            // This is the server's fault, and rejection must not spend the model's retry budget.
            void this.reconcile();
            return {
                kind: 'deferred',
                errors: ['The server has not loaded this review round yet. Call `complete` again in a moment.'],
            };
        }

        const parsed = parseResult(result, bound.threadIds, binding.locale);
        if (!parsed.ok) {
            return { kind: 'rejected', errors: parsed.errors };
        }

        const author = this.agentUser(binding.locale);
        const { replies, summary } = parsed.value;
        return {
            kind: 'accepted',
            onCommitted: () => {
                void this.commitRound(task.id, bound, { replies, summary }, author);
            },
        };
    }

    /**
     * Writes agent replies to threads and closes the round. Order matters: set `done` only after
     * a successful write, otherwise a host failure (no space, permissions, a failed VCS command) would close the round
     * forever, because reconciliation never enqueues accepted or failed rounds again. A failure
     * leaves the binding open, and the next reconciliation enqueues the round for the agent again.
     */
    private async commitRound(
        taskId: number,
        bound: BoundRound,
        result: { readonly replies: readonly FeedbackReply[]; readonly summary: string },
        author: ReviewUser,
    ): Promise<void> {
        try {
            await this.host.completeRound(bound.roundId, result, author);
            this.store.setState(bound.roundId, 'done');
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            process.stderr.write(
                `sherpa-review-server: could not write agent replies to round ${bound.roundId}: ${message}\n`,
            );
            await this.reconcile();
        } finally {
            this.boundTasks.delete(taskId);
        }
    }

    /**
     * Agent reply signature: the login is the session harness, and the name is "Agent" in the round language,
     * with the model if known.
     */
    private agentUser(locale: Locale): ReviewUser {
        const status = this.registry?.status();
        const connected = status !== undefined && status.kind !== 'never' ? status : null;
        const model = connected?.model;
        const name = locale === 'ru' ? 'Агент' : 'Agent';
        return {
            login: connected?.harness ?? 'agent',
            displayName: model === undefined ? name : `${name} · ${model}`,
            bot: true,
            avatarUrl: null,
        };
    }

    /**
     * Reviewer reply language: the same resolution order as routes and chat, without a tab request.
     * Resolved once at task creation, then stored in the round binding.
     */
    private locale(): Locale {
        const status = this.registry?.status();
        return resolveGenerationLocale({
            setting: this.settings?.read().locale,
            agentLang: status === undefined || status.kind === 'never' ? undefined : status.lang,
        });
    }
}

/** Round directory containing the path. Returns null for paths outside the round directories. */
function roundDirOf(payloadDir: string, file: string): string | null {
    const relative = path.relative(payloadDir, file);
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
        return null;
    }
    const [name] = relative.split(path.sep);
    return name === undefined || name === '' ? null : path.join(payloadDir, name);
}

type ParsedResult =
    | { readonly ok: true; readonly value: { readonly replies: FeedbackReply[]; readonly summary: string } }
    | { readonly ok: false; readonly errors: string[] };

/** Fail-closed result parsing: schema, round threads, duplicates and reply voice. */
function parseResult(result: string, threadIds: ReadonlySet<string>, locale: Locale): ParsedResult {
    let raw: unknown;
    try {
        raw = JSON.parse(result);
    } catch {
        return { ok: false, errors: ['The result is not valid JSON. Follow the schema from the task.'] };
    }

    const parsed = reviewFeedbackResultSchema.safeParse(raw);
    if (!parsed.success) {
        return {
            ok: false,
            errors: parsed.error.issues.map(
                (issue) => `${issue.path.join('.') || 'result'}: ${issue.message}`,
            ),
        };
    }

    const errors: string[] = [];
    const seen = new Set<string>();
    for (const reply of parsed.data.replies) {
        if (!threadIds.has(reply.threadId)) {
            errors.push(
                `replies: thread ${reply.threadId} is not in this review round — reply only to the threads listed in feedback.md.`,
            );
        }
        if (seen.has(reply.threadId)) {
            errors.push(`replies: thread ${reply.threadId} is answered twice — one reply per thread.`);
        }
        seen.add(reply.threadId);
        errors.push(...voiceErrors(`replies.${reply.threadId}`, reply.body, locale));
    }
    if (parsed.data.summary.trim() === '') {
        errors.push('summary: write one line about what you did in this round.');
    }
    errors.push(...voiceErrors('summary', parsed.data.summary, locale));

    return errors.length > 0
        ? { ok: false, errors }
        : { ok: true, value: { replies: [...parsed.data.replies], summary: parsed.data.summary } };
}
