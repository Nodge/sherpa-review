import type { AgentNote, ChatAnchor, ChatExchange, UiChatAskAnchor, UiTask, WorkerStatus } from '@sherpa/protocol';
import type { KeyboardEvent, RefObject } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessageKey, Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import { breadcrumbFromPrKey } from '../pr-key.js';
import { Markdown } from '../markdown/markdown.tsx';
import { NOTE_LOST_ANCHOR_REASON, noteAnchorForIteration, noteVisibleInIteration } from '../notes/model.js';
import { CHAT_EXAMPLE_QUESTIONS } from './chat-prompts.js';
import { CommandBox } from './command-box.tsx';
import './chat-panel.css';

export type ChatActivityState = 'empty' | 'queued' | 'answering' | 'failed' | 'disconnected' | 'idle';
export type ChatScrollTarget = 'queue' | 'error' | { readonly kind: 'exchange'; readonly exchangeId: number };

export interface ChatPanelProps {
    readonly prKey: string;
    readonly worker: WorkerStatus;
    readonly tasks: readonly UiTask[];
    readonly exchanges: readonly ChatExchange[];
    readonly notes: readonly AgentNote[];
    readonly loading: boolean;
    readonly error: string | null;
    readonly reconnectCommand: string;
    readonly anchor: UiChatAskAnchor | null;
    readonly focusRequest: number;
    /**
     * Prefill the composer (docs/design/README.md §2, §10) without sending the question. The reviewer reads, edits and
     * sends it. A request with a new `id` takes effect even with the same text.
     */
    readonly prefillRequest?: { readonly id: number; readonly text: string } | null;
    readonly scrollRequest: { readonly id: number; readonly target: ChatScrollTarget } | null;
    readonly onScrollRequestHandled: (id: number) => void;
    readonly onClose: () => void;
    readonly onRemoveAnchor: () => void;
    readonly onAsk: (text: string, anchor?: UiChatAskAnchor) => Promise<ChatExchange>;
    readonly onCancel: (exchangeId: number) => Promise<void>;
    readonly onRetry: (exchangeId: number) => Promise<void>;
    readonly onNavigate: (anchor: ChatAnchor) => void;
    readonly onNavigateToNote: (note: AgentNote) => void;
    /**
     * The iteration shown in the tab determines whether a note with a lost anchor has a navigation target.
     * null means the iteration is unknown and navigation is unavailable.
     */
    readonly viewDiffId?: string | null;
    /** Fixed clock for the gallery and tests. */
    readonly now?: number;
}

export interface ChatFeedEntry {
    readonly exchange: ChatExchange;
    readonly note: AgentNote | null;
}

/** An exchange remains the status unit, while the feed receives the question and its linked answer/note. */
export function expandChatExchanges(
    exchanges: readonly ChatExchange[],
    notes: readonly AgentNote[],
): readonly ChatFeedEntry[] {
    const notesByExchange = new Map(notes.map((note) => [note.exchangeId, note]));
    return [...exchanges]
        .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt) || left.id - right.id)
        .map((exchange) => ({ exchange, note: notesByExchange.get(exchange.id) ?? null }));
}

export function chatActivityState(
    worker: WorkerStatus,
    exchanges: readonly ChatExchange[],
): ChatActivityState {
    if (worker.kind !== 'connected') {
        return 'disconnected';
    }
    if (exchanges.some((exchange) => exchange.status === 'running')) {
        return 'answering';
    }
    if (exchanges.some((exchange) => exchange.status === 'queued')) {
        return 'queued';
    }
    if (exchanges.some((exchange) => exchange.status === 'failed' || exchange.status === 'cancelled')) {
        return 'failed';
    }
    return exchanges.length === 0 ? 'empty' : 'idle';
}

/**
 * The queue banner names route generation and review feedback separately, and uses generic wording
 * for any other busy task. A held task counts as busy, so a cancelled task still running on the worker also stands
 * ahead of the question. A cancelled task gets generic wording because the work is gone and the route view
 * shows its stops as cancelled. "Generating route" would contradict that view.
 */
export function queueBannerText(tasks: readonly UiTask[]): MessageKey | null {
    const current = tasks.find((task) => task.heldByWorker);
    if (current === undefined) {
        return null;
    }
    if (current.status === 'cancelled') {
        return 'chat.queue.busy';
    }
    if (current.type === 'route.skeleton' || current.type === 'route.section') {
        return 'chat.queue.route';
    }
    return current.type === 'review.feedback' ? 'chat.queue.feedback' : 'chat.queue.busy';
}

export function sameChatAnchor(left: UiChatAskAnchor | null, right: UiChatAskAnchor | null): boolean {
    return (
        left?.fileId === right?.fileId &&
        left?.side === right?.side &&
        left?.start === right?.start &&
        left?.end === right?.end &&
        left?.selectedText === right?.selectedText
    );
}

export function chatAnchorLabel(anchor: UiChatAskAnchor): string {
    const basename = anchor.path.split('/').at(-1) ?? anchor.path;
    return `${basename}:${String(anchor.start)}–${String(anchor.end)}`;
}

function chatAnchorTitle(anchor: UiChatAskAnchor): string {
    return `${anchor.path}:${String(anchor.start)}–${String(anchor.end)}`;
}

export function ChatPanel(props: ChatPanelProps) {
    const {
        worker,
        tasks,
        exchanges,
        notes,
        loading,
        error,
        anchor,
        focusRequest,
        prefillRequest = null,
        scrollRequest,
        onScrollRequestHandled,
        onClose,
        onRemoveAnchor,
        onAsk,
        onCancel,
        onRetry,
        onNavigate,
        onNavigateToNote,
        viewDiffId = null,
    } = props;
    const t = useT();
    const feed = useMemo(() => expandChatExchanges(exchanges, notes), [exchanges, notes]);
    const feedVersion = feed
        .map(({ exchange, note }) =>
            [exchange.id, exchange.status, exchange.updatedAt, note?.id ?? ''].join(':'),
        )
        .join('|');
    const activity = chatActivityState(worker, exchanges);
    const queued = activity === 'queued' ? queueBannerText(tasks) : null;
    const running = [...exchanges].reverse().find((exchange) => exchange.status === 'running') ?? null;
    const failedExchangeId = [...feed]
        .reverse()
        .find(({ exchange }) => exchange.status === 'failed' || exchange.status === 'cancelled')?.exchange.id;
    // Show "still busy" only under its own exchange, whose task is cancelled but still held by the worker.
    const cancelledLeaseExchangeIds = useMemo(
        () =>
            new Set(
                exchanges
                    .filter(
                        (exchange) =>
                            exchange.status === 'cancelled' &&
                            tasks.some(
                                (task) =>
                                    task.id === exchange.taskId &&
                                    task.status === 'cancelled' &&
                                    task.heldByWorker,
                            ),
                    )
                    .map((exchange) => exchange.id),
            ),
        [exchanges, tasks],
    );
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const feedRef = useRef<HTMLDivElement | null>(null);
    const queueRef = useRef<HTMLDivElement | null>(null);
    const errorRef = useRef<HTMLDivElement | null>(null);
    const handledScrollRequest = useRef<number | null>(null);
    const [sending, setSending] = useState(false);
    const [composerError, setComposerError] = useState<string | null>(null);
    const [clock, setClock] = useState(() => props.now ?? Date.now());
    /**
     * Derive composer text from the prefill and subsequent edits. `handled` records which
     * request has already been applied, so the same request does not overwrite typed text, while a new request
     * with the same text takes effect.
     */
    const [composer, setComposer] = useState<{ readonly handled: number; readonly text: string }>({
        handled: 0,
        text: '',
    });
    const text =
        prefillRequest !== null && prefillRequest.id !== composer.handled ? prefillRequest.text : composer.text;
    const handledPrefill = prefillRequest?.id ?? composer.handled;
    const setText = (value: string): void => {
        setComposer({ handled: handledPrefill, text: value });
    };
    // Move the caret to the end of the prefilled text. React restores the focused input's selection
    // after commit and would otherwise move it back to the start.
    const focusComposerEnd = useCallback(() => {
        const textarea = textareaRef.current;
        if (textarea === null) {
            return;
        }
        textarea.focus();
        textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    }, []);

    useEffect(() => {
        textareaRef.current?.focus();
    }, [focusRequest]);

    // The app request text is visible in this render already because it is derived from the request itself.
    const appliedPrefill = useRef(0);
    useEffect(() => {
        if (prefillRequest === null || prefillRequest.id === appliedPrefill.current) {
            return;
        }
        appliedPrefill.current = prefillRequest.id;
        focusComposerEnd();
    }, [focusComposerEnd, prefillRequest]);

    // The handler prefills the example, so its text reaches the DOM only in the next render.
    const exampleCaret = useRef(false);
    useEffect(() => {
        if (!exampleCaret.current) {
            return;
        }
        exampleCaret.current = false;
        focusComposerEnd();
    });

    useEffect(() => {
        if (scrollRequest !== null) {
            const target =
                scrollRequest.target === 'queue'
                    ? queueRef.current
                    : scrollRequest.target === 'error'
                      ? errorRef.current
                      : feedRef.current?.querySelector<HTMLElement>(
                            `[data-exchange="${String(scrollRequest.target.exchangeId)}"]`,
                        ) ?? null;
            if (target === null) {
                return;
            }
            target.scrollIntoView({ block: 'center' });
            handledScrollRequest.current = scrollRequest.id;
            onScrollRequestHandled(scrollRequest.id);
            return;
        }
        if (handledScrollRequest.current !== null) {
            handledScrollRequest.current = null;
            return;
        }
        const element = feedRef.current;
        if (element !== null) {
            element.scrollTop = element.scrollHeight;
        }
    }, [error, failedExchangeId, feedVersion, loading, onScrollRequestHandled, queued, scrollRequest]);

    useEffect(() => {
        if (props.now !== undefined || running === null) {
            return;
        }
        const now = Date.now();
        const elapsed = now - Date.parse(running.createdAt);
        const timers = [0, 300, 60_001]
            .filter((threshold) => threshold === 0 || threshold > elapsed)
            .map((threshold) =>
                window.setTimeout(
                    () => {
                        setClock(Date.now());
                    },
                    Math.max(0, threshold - elapsed),
                ),
            );
        return () => {
            for (const timer of timers) {
                window.clearTimeout(timer);
            }
        };
    }, [props.now, running]);

    const connected = worker.kind === 'connected';
    const submit = (): void => {
        const question = text.trim();
        if (!connected || sending || question === '') {
            return;
        }
        setSending(true);
        setComposerError(null);
        void onAsk(question, anchor ?? undefined).then(
            () => {
                setSending(false);
                setText('');
            },
            (error: unknown) => {
                setSending(false);
                setComposerError(error instanceof Error ? error.message : String(error));
            },
        );
    };

    // `updatedAt` changes with every progress line. `createdAt` is a stable starting point that survives reload.
    const now = props.now ?? clock;
    const runningFor = running === null ? 0 : now - Date.parse(running.createdAt);
    const typingVisible = running !== null && runningFor >= 300;
    const longRunning = running !== null && runningFor > 60_000;
    const prLabel = breadcrumbFromPrKey(props.prKey).at(-1) ?? props.prKey;

    return (
        // `data-tour="chat"` is the target for step 06 of the first-pass tour.
        <aside className="chat-panel" aria-label={t('chat.aria')} data-tour="chat">
            <header className="chat-panel__header">
                <div>
                    <div className="chat-panel__title">Agent</div>
                    <div className="chat-panel__identity">{workerIdentity(worker, t)}</div>
                </div>
                <div className="chat-panel__header-actions">
                    {notes.length === 0 ? null : (
                        <span className="chat-panel__notes">{t('chat.notes', notes.length)}</span>
                    )}
                    <button type="button" className="ctl ctl--toolbar-icon chat-panel__close" aria-label={t('app.closeChat')} onClick={onClose}>
                        ×
                    </button>
                </div>
            </header>

            {queued === null ? null : (
                <div className="chat-panel__queue" ref={queueRef} role="status">
                    {t(queued)}
                </div>
            )}

            <div className="chat-panel__feed" ref={feedRef}>
                <div className="chat-panel__feed-content">
                    {loading && feed.length === 0 ? (
                        <p className="chat-panel__history-status" role="status">
                            {t('chat.history.loading')}
                        </p>
                    ) : null}
                    {error === null ? null : (
                        <p className="chat-panel__history-error" role="alert">
                            {t('chat.history.failed', error)}
                        </p>
                    )}
                    {!loading && error === null && activity === 'empty' ? (
                        <EmptyChat
                            onPick={(question) => {
                                exampleCaret.current = true;
                                setText(question);
                            }}
                        />
                    ) : null}
                    {feed.map(({ exchange, note }) => (
                        <ChatExchangeView
                            key={exchange.id}
                            exchange={exchange}
                            note={note}
                            {...(exchange.id === failedExchangeId ? { errorRef } : {})}
                            cancelledLease={cancelledLeaseExchangeIds.has(exchange.id)}
                            onCancel={onCancel}
                            onRetry={onRetry}
                            onNavigate={onNavigate}
                            onNavigateToNote={onNavigateToNote}
                            viewDiffId={viewDiffId}
                            typingVisible={running?.id === exchange.id && typingVisible}
                            longRunning={running?.id === exchange.id && longRunning}
                        />
                    ))}
                    {activity === 'disconnected' ? (
                        <div className="chat-panel__disconnected">
                            <p>{t('chat.disconnected')}</p>
                            <CommandBox command={props.reconnectCommand} hint={t('command.hint')} />
                        </div>
                    ) : null}
                </div>
            </div>

            <div className="chat-panel__composer">
                <div className="chat-panel__contexts">
                    <span className="chat-panel__context">{prLabel}</span>
                    {anchor === null ? null : (
                        <span
                            className="chat-panel__context chat-panel__context--anchor"
                            title={chatAnchorTitle(anchor)}
                        >
                            <span className="chat-panel__context-label">{chatAnchorLabel(anchor)}</span>
                            <button type="button" aria-label={t('chat.anchor.remove')} onClick={onRemoveAnchor}>
                                ×
                            </button>
                        </span>
                    )}
                </div>
                {anchor?.selectedText === undefined ? null : <blockquote className="chat-panel__selection-quote">{anchor.selectedText}</blockquote>}
                <textarea
                    ref={textareaRef}
                    className="chat-panel__textarea"
                    aria-label={t('chat.composer.aria')}
                    value={text}
                    disabled={!connected || sending}
                    placeholder={t('chat.composer.placeholder')}
                    onChange={(event) => {
                        setText(event.target.value);
                    }}
                    onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                        if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                            event.preventDefault();
                            submit();
                        }
                    }}
                />
                <div className="chat-panel__composer-footer">
                    <span>{t('chat.composer.hint')}</span>
                    <button
                        type="button"
                        className="ctl ctl--primary"
                        disabled={!connected || sending || text.trim() === ''}
                        onClick={submit}
                    >
                        {t('chat.composer.send')}
                    </button>
                </div>
                {composerError === null ? null : (
                    <div className="chat-panel__composer-error" role="alert">
                        {composerError}
                    </div>
                )}
            </div>
        </aside>
    );
}

function ChatExchangeView({
    exchange,
    note,
    errorRef,
    cancelledLease,
    onCancel,
    onRetry,
    onNavigate,
    onNavigateToNote,
    viewDiffId,
    typingVisible,
    longRunning,
}: {
    readonly exchange: ChatExchange;
    readonly note: AgentNote | null;
    readonly errorRef?: RefObject<HTMLDivElement | null>;
    readonly cancelledLease: boolean;
    readonly onCancel: (exchangeId: number) => Promise<void>;
    readonly onRetry: (exchangeId: number) => Promise<void>;
    readonly onNavigate: (anchor: ChatAnchor) => void;
    readonly onNavigateToNote: (note: AgentNote) => void;
    readonly viewDiffId: string | null;
    readonly typingVisible: boolean;
    readonly longRunning: boolean;
}) {
    const t = useT();
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionPending, setActionPending] = useState(false);
    const run = (action: (exchangeId: number) => Promise<void>): void => {
        if (actionPending) {
            return;
        }
        setActionPending(true);
        setActionError(null);
        void action(exchange.id).then(
            () => {
                setActionPending(false);
            },
            (error: unknown) => {
                setActionPending(false);
                setActionError(error instanceof Error ? error.message : String(error));
            },
        );
    };

    return (
        <article className="chat-message-pair" data-exchange={exchange.id}>
            <div className="chat-message chat-message--you">
                <div className="chat-message__author">you</div>
                <div className="chat-message__body chat-message__body--plain">{exchange.question}</div>
                {exchange.anchor === null ? null : (
                    <button
                        type="button"
                        className="chat-message__anchor"
                        title={chatAnchorTitle(exchange.anchor)}
                        onClick={() => {
                            if (exchange.anchor !== null) {
                                onNavigate(exchange.anchor);
                            }
                        }}
                    >
                        ↳ {chatAnchorLabel(exchange.anchor)}
                    </button>
                )}
            </div>

            {exchange.status === 'done' && exchange.answer !== null ? (
                <div className="chat-message chat-message--agent">
                    <div className="chat-message__author">agent</div>
                    <div className="chat-message__body">
                        <Markdown text={exchange.answer} profile="comment" />
                    </div>
                    {note === null ? null : (
                        <div className="chat-message__note-row">
                            <button
                                type="button"
                                className="chat-message__note"
                                disabled={!noteVisibleInIteration(note, viewDiffId)}
                                title={
                                    noteVisibleInIteration(note, viewDiffId)
                                        ? chatAnchorTitle(noteAnchorForIteration(note, viewDiffId))
                                        : t(NOTE_LOST_ANCHOR_REASON)
                                }
                                onClick={() => {
                                    onNavigateToNote(note);
                                }}
                            >
                                {t('chat.note.pinned', chatAnchorLabel(noteAnchorForIteration(note, viewDiffId)))}
                            </button>
                            {note.lostAnchor ? (
                                <span className="chat-message__note-lost" title={chatAnchorTitle(note.anchor)}>
                                    {t('chat.note.lostAnchor', chatAnchorLabel(note.anchor))}
                                </span>
                            ) : null}
                        </div>
                    )}
                </div>
            ) : exchange.status === 'running' ? (
                <div className="chat-message chat-message--agent" role="status">
                    <div className="chat-message__author">agent</div>
                    {typingVisible ? (
                        <div className="chat-message__activity">
                            <span className="chat-message__typing" aria-hidden="true">
                                <i />
                                <i />
                                <i />
                            </span>
                            <span>{longRunning ? t('chat.answering.long') : t('chat.answering')}</span>
                        </div>
                    ) : null}
                    {exchange.progressText === null ? null : (
                        <div className="chat-message__progress">{exchange.progressText}</div>
                    )}
                    <button
                        type="button"
                        className="ctl ctl--ghost chat-message__action"
                        disabled={actionPending}
                        onClick={() => {
                            run(onCancel);
                        }}
                    >
                        {t('chat.stop')}
                    </button>
                </div>
            ) : exchange.status === 'failed' || exchange.status === 'cancelled' ? (
                <div className="chat-message chat-message--agent chat-message--failed" ref={errorRef} role="alert">
                    <div className="chat-message__author">agent</div>
                    <div className="chat-message__body chat-message__body--plain">
                        {exchange.status === 'failed'
                            ? (exchange.error ?? t('chat.answer.missing'))
                            : t('chat.answer.cancelled')}
                    </div>
                    <button
                        type="button"
                        className="ctl ctl--ghost chat-message__action"
                        disabled={actionPending}
                        onClick={() => {
                            run(onRetry);
                        }}
                    >
                        {t('chat.retry')}
                    </button>
                </div>
            ) : null}
            {cancelledLease ? (
                <p className="chat-panel__cancelled-lease" role="status">
                    {t('chat.cancelledLease')}
                </p>
            ) : null}
            {actionError === null ? null : (
                <div className="chat-message__action-error" role="alert">
                    {actionError}
                </div>
            )}
        </article>
    );
}

/**
 * Empty state (docs/design/SPEC-elements.md §2.18). Examples are clickable: a click prefills the question in the composer and
 * sends nothing. The `empty` state only occurs with a connected agent, so
 * it never offers a clickable action while the agent is disconnected.
 */
function EmptyChat({ onPick }: { readonly onPick: (question: string) => void }) {
    const t = useT();
    return (
        <div className="chat-panel__empty">
            <p>{t('chat.empty')}</p>
            <ul>
                {CHAT_EXAMPLE_QUESTIONS.map((key) => (
                    <li key={key}>
                        <button
                            type="button"
                            className="ctl ctl--link-muted chat-panel__example"
                            onClick={() => {
                                onPick(t(key));
                            }}
                        >
                            {t(key)}
                        </button>
                    </li>
                ))}
            </ul>
        </div>
    );
}

function workerIdentity(worker: WorkerStatus, t: Translate): string {
    if (worker.kind === 'never') {
        return t('chat.worker.never');
    }
    return [worker.harness, worker.model].filter((value): value is string => value !== undefined).join(' · ') || worker.workerId;
}
