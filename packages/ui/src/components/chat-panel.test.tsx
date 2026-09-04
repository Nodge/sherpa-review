// @vitest-environment jsdom
import type { AgentNote, ChatAnchor, ChatExchange, UiTask, WorkerStatus } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ChatPanelProps } from './chat-panel.tsx';
import {
    chatActivityState,
    chatAnchorLabel,
    ChatPanel,
    expandChatExchanges,
    queueBannerText,
    sameChatAnchor,
} from './chat-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');

const CONNECTED: WorkerStatus = {
    kind: 'connected',
    workerId: 'worker-1',
    harness: 'claude-code',
    model: 'opus-5',
    registeredAt: '2026-09-01T09:00:00.000Z',
    lastSeenAt: '2026-09-01T10:00:00.000Z',
};
const ANCHOR: ChatAnchor = {
    diffId: 'iter-1',
    fileId: 'file-1',
    path: 'src/cache.ts',
    side: 'new',
    start: 41,
    end: 43,
};

function exchange(id: number, status: ChatExchange['status'], overrides: Partial<ChatExchange> = {}): ChatExchange {
    return {
        id,
        question: `Question ${String(id)}`,
        anchor: null,
        status,
        taskId: id,
        answer: status === 'done' ? 'Answer from the **agent**.' : null,
        progressText: status === 'running' ? 'Reading related calls' : null,
        error: status === 'failed' ? 'The model returned no answer.' : null,
        locale: null,
        createdAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        updatedAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        ...overrides,
    };
}

function task(
    id: number,
    type: UiTask['type'],
    status: UiTask['status'],
    heldByWorker = status === 'leased',
): UiTask {
    return {
        id,
        type,
        priority: 'interactive',
        status,
        heldByWorker,
        attempt: 1,
        instructions: 'task',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-09-01T10:00:00.000Z',
        updatedAt: '2026-09-01T10:00:00.000Z',
    };
}

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    vi.useRealTimers();
    vi.restoreAllMocks();
    if (originalScrollIntoView === undefined) {
        delete (HTMLElement.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    } else {
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', originalScrollIntoView);
    }
});

function mountPanel(overrides: Partial<ChatPanelProps> = {}) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    let props: ChatPanelProps = {
        prKey: 'github-quillmart--quillmart--4821',
        worker: CONNECTED,
        tasks: [],
        exchanges: [],
        notes: [],
        loading: false,
        error: null,
        reconnectCommand: '/sherpa github-quillmart--quillmart--4821',
        anchor: null,
        focusRequest: 0,
        scrollRequest: null,
        onScrollRequestHandled: () => undefined,
        onClose: () => undefined,
        onRemoveAnchor: () => undefined,
        onAsk: () => Promise.resolve(exchange(99, 'queued')),
        onCancel: () => Promise.resolve(),
        onRetry: () => Promise.resolve(),
        onNavigate: () => undefined,
        onNavigateToNote: () => undefined,
        ...overrides,
    };
    const render = (next: Partial<ChatPanelProps> = {}): void => {
        props = { ...props, ...next };
        act(() => {
            root.render(<ChatPanel {...props} />);
        });
    };
    render();
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, render };
}

describe('chat panel model', () => {
    it('expands exchanges in time order and links the note by exchangeId', () => {
        const note: AgentNote = {
            id: 8,
            exchangeId: 2,
            anchor: ANCHOR,
            text: 'Answer',
            lostAnchor: false,
            origin: { commit: 'abcdef1', anchor: ANCHOR },
            createdAt: '2026-09-01T10:01:00.000Z',
        };

        expect(expandChatExchanges([exchange(2, 'done'), exchange(1, 'done')], [note])).toEqual([
            { exchange: exchange(1, 'done'), note: null },
            { exchange: exchange(2, 'done'), note },
        ]);
    });

    it('selects the 5 contract states and idle history', () => {
        expect(chatActivityState(CONNECTED, [])).toBe('empty');
        expect(chatActivityState(CONNECTED, [exchange(1, 'queued')])).toBe('queued');
        expect(chatActivityState(CONNECTED, [exchange(1, 'running')])).toBe('answering');
        expect(chatActivityState(CONNECTED, [exchange(1, 'failed')])).toBe('failed');
        expect(chatActivityState({ kind: 'never' }, [])).toBe('disconnected');
        expect(chatActivityState(CONNECTED, [exchange(1, 'done')])).toBe('idle');
    });

    it('distinguishes route generation from another busy task in the banner', () => {
        expect(queueBannerText([task(1, 'route.section', 'leased')])).toBe('chat.queue.route');
        expect(queueBannerText([task(1, 'echo', 'leased')])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'chat', 'leased')])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'chat', 'done')])).toBeNull();
    });

    it('does not present a held cancelled route task as ongoing generation', () => {
        expect(queueBannerText([task(1, 'route.section', 'cancelled', true)])).toBe('chat.queue.busy');
        expect(queueBannerText([task(1, 'route.section', 'cancelled', false)])).toBeNull();
    });

    it('compares anchors by range instead of object reference', () => {
        expect(sameChatAnchor(ANCHOR, { ...ANCHOR })).toBe(true);
        expect(sameChatAnchor(ANCHOR, { ...ANCHOR, end: 44 })).toBe(false);
        expect(sameChatAnchor(null, null)).toBe(true);
    });

    it('shows the basename and keeps the full path for the tooltip', () => {
        expect(chatAnchorLabel({ ...ANCHOR, path: 'services/cache/src/cache.ts' })).toBe('cache.ts:41–43');
    });
});

describe('chat panel feed', () => {
    it('shows the indicator after 300 ms and long-running status after 60 s from createdAt', () => {
        vi.useFakeTimers();
        vi.setSystemTime('2026-09-01T10:00:00.000Z');
        const running = exchange(1, 'running', {
            createdAt: '2026-09-01T10:00:00.000Z',
            updatedAt: '2026-09-01T10:00:00.000Z',
        });
        const { host, render } = mountPanel({ exchanges: [running] });

        expect(host.textContent).not.toContain('Answering');
        act(() => {
            vi.advanceTimersByTime(299);
        });
        expect(host.textContent).not.toContain('Answering');
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(host.textContent).toContain('Answering');

        render({
            exchanges: [
                {
                    ...running,
                    progressText: 'Checking one more call',
                    updatedAt: '2026-09-01T10:00:30.000Z',
                },
            ],
        });
        expect(host.textContent).toContain('Answering');
        act(() => {
            vi.advanceTimersByTime(59_700);
        });
        expect(host.textContent).toContain('Answering');
        act(() => {
            vi.advanceTimersByTime(1);
        });
        expect(host.textContent).toContain('Still working');
    });

    it('places the held cancelled task message under its exchange and queues the new question behind it', () => {
        const { host } = mountPanel({
            // Exchange 1 is cancelled, but the worker still holds its task. Exchange 2 is waiting its turn.
            tasks: [task(1, 'chat', 'cancelled', true)],
            exchanges: [exchange(1, 'cancelled'), exchange(2, 'queued')],
        });

        expect(host.textContent).toContain('Agent busy · your question is next');
        expect(host.querySelector('[data-exchange="1"]')?.textContent).toContain(
            'The agent is still busy with the cancelled task',
        );
        expect(host.querySelector('[data-exchange="2"]')?.textContent).not.toContain(
            'The agent is still busy with the cancelled task',
        );
    });

    it('does not show a message under a cancelled exchange for another active lease', () => {
        const { host, render } = mountPanel({
            // The worker has responded for task 1 and taken the task for another question.
            tasks: [task(1, 'chat', 'cancelled', false), task(2, 'chat', 'leased')],
            exchanges: [exchange(1, 'cancelled'), exchange(2, 'running')],
        });

        expect(host.textContent).not.toContain('The agent is still busy with the cancelled task');

        // The lease ended while the exchange stayed cancelled. The message disappears even without an exchange change.
        render({ tasks: [task(1, 'chat', 'cancelled', true)], exchanges: [exchange(1, 'cancelled')] });
        expect(host.textContent).toContain('The agent is still busy with the cancelled task');
        render({ tasks: [task(1, 'chat', 'cancelled', false)], exchanges: [exchange(1, 'cancelled')] });
        expect(host.textContent).not.toContain('The agent is still busy with the cancelled task');
    });

    it('shows history loading and errors instead of a false empty chat', () => {
        const { host, render } = mountPanel({ loading: true });

        expect(host.textContent).toContain('Loading the chat history');
        expect(host.textContent).not.toContain('Ask about the PR');

        render({ loading: false, error: 'Server responded 500' });
        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
            'Could not load the chat history: Server responded 500',
        );
        expect(host.textContent).not.toContain('Ask about the PR');
    });

    it('scrolls down as the feed grows but gives an explicit target priority after waiting for the DOM', () => {
        const targets: string[] = [];
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value(this: HTMLElement) {
                targets.push(this.closest('[data-exchange]')?.getAttribute('data-exchange') ?? 'none');
            },
        });
        const onScrollRequestHandled = vi.fn();
        const running = exchange(1, 'running');
        const { host, render } = mountPanel({ exchanges: [running], onScrollRequestHandled });
        const feed = host.querySelector<HTMLElement>('.chat-panel__feed');
        if (feed === null) {
            throw new Error('chat feed not found');
        }
        Object.defineProperty(feed, 'scrollHeight', { configurable: true, value: 500 });
        feed.scrollTop = 0;

        render({ exchanges: [{ ...running, updatedAt: '2026-09-01T10:00:30.000Z' }] });
        expect(feed.scrollTop).toBe(500);

        feed.scrollTop = 0;
        render({ exchanges: [], scrollRequest: { id: 7, target: 'error' } });
        expect(targets).toEqual([]);
        expect(onScrollRequestHandled).not.toHaveBeenCalled();

        render({ exchanges: [exchange(2, 'failed'), exchange(3, 'cancelled')] });
        expect(targets).toEqual(['3']);
        expect(feed.scrollTop).toBe(0);
        expect(onScrollRequestHandled).toHaveBeenCalledWith(7);

        render({
            exchanges: [exchange(9, 'done')],
            scrollRequest: { id: 8, target: { kind: 'exchange', exchangeId: 9 } },
        });
        expect(targets).toEqual(['3', '9']);
        expect(onScrollRequestHandled).toHaveBeenCalledWith(8);
    });

    it('does not scroll to an old error without a request and keeps the full path in title', () => {
        const scrollIntoView = vi.fn();
        Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
            configurable: true,
            value: scrollIntoView,
        });
        const anchor = { ...ANCHOR, path: 'services/cache/src/cache.ts' };
        const { host } = mountPanel({
            anchor,
            exchanges: [exchange(1, 'failed', { anchor })],
        });

        expect(scrollIntoView).not.toHaveBeenCalled();
        expect(host.textContent).toContain('cache.ts:41–43');
        expect(host.querySelector('[title="services/cache/src/cache.ts:41–43"]')).not.toBeNull();
    });

    it('navigates to the note itself and clears its mark after removal from the shared list', () => {
        const attached: AgentNote = {
            id: 31,
            exchangeId: 1,
            anchor: ANCHOR,
            text: 'Answer',
            lostAnchor: false,
            origin: { commit: 'abcdef1', anchor: ANCHOR },
            createdAt: '2026-09-01T10:01:00.000Z',
        };
        const onNavigate = vi.fn();
        const onNavigateToNote = vi.fn();
        const { host, render } = mountPanel({
            exchanges: [exchange(1, 'done')],
            notes: [attached],
            onNavigate,
            onNavigateToNote,
        });

        act(() => {
            host.querySelector<HTMLButtonElement>('.chat-message__note')?.click();
        });
        expect(onNavigateToNote).toHaveBeenCalledWith(attached);
        expect(onNavigate).not.toHaveBeenCalled();
        expect(host.textContent).toContain('Pinned by a note');
        expect(host.textContent).toContain('Notes 1');

        render({ notes: [] });
        expect(host.textContent).not.toContain('Pinned by a note');
        expect(host.textContent).not.toContain('Notes 1');
    });
});

describe('chat panel composer', () => {
    it('sends on Enter, keeps the newline on Shift+Enter and removes the range chip separately', async () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(3, 'queued', { anchor: ANCHOR })));
        const onRemoveAnchor = vi.fn();
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ChatPanel
                    prKey="github-quillmart--quillmart--4821"
                    worker={CONNECTED}
                    tasks={[]}
                    exchanges={[]}
                    notes={[]}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa github-quillmart--quillmart--4821"
                    anchor={ANCHOR}
                    focusRequest={0}
                    scrollRequest={null}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={onRemoveAnchor}
                    onAsk={onAsk}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('PR 4821');
        expect(host.textContent).toContain('cache.ts:41–43');
        const textarea = host.querySelector('textarea');
        if (textarea === null) {
            throw new Error('no question field');
        }
        act(() => {
            Object.defineProperty(textarea, 'value', {
                configurable: true,
                value: 'Why is there a separate check here?',
                writable: true,
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
        });
        expect(onAsk).not.toHaveBeenCalled();

        await act(async () => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            await Promise.resolve();
        });
        expect(onAsk).toHaveBeenCalledWith('Why is there a separate check here?', ANCHOR);

        act(() => {
            host.querySelector<HTMLButtonElement>('[aria-label="Remove the range from the context"]')?.click();
        });
        expect(onRemoveAnchor).toHaveBeenCalledTimes(1);
    });

    it('disables the input and shows the reconnect command when the agent is disconnected', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <ChatPanel
                    prKey="fixture-medium"
                    worker={{ kind: 'never' }}
                    tasks={[]}
                    exchanges={[]}
                    notes={[]}
                    loading={false}
                    error={null}
                    reconnectCommand="/sherpa fixture-medium"
                    anchor={null}
                    focusRequest={0}
                    scrollRequest={null}
                    onScrollRequestHandled={() => undefined}
                    onClose={() => undefined}
                    onRemoveAnchor={() => undefined}
                    onAsk={() => Promise.resolve(exchange(1, 'queued'))}
                    onCancel={() => Promise.resolve()}
                    onRetry={() => Promise.resolve()}
                    onNavigate={() => undefined}
                    onNavigateToNote={() => undefined}
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.querySelector<HTMLTextAreaElement>('textarea')?.disabled).toBe(true);
        expect(host.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe('/sherpa fixture-medium');
    });
});

describe('prefilling a question in the composer', () => {
    it('sets the request text without sending it', () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(99, 'queued')));
        const { host } = mountPanel({ prefillRequest: { id: 1, text: 'Place these ranges' }, onAsk });

        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.value).toBe('Place these ranges');
        expect(textarea?.selectionStart).toBe('Place these ranges'.length);
        expect(onAsk).not.toHaveBeenCalled();
    });

    it('applies a repeated request with the same text again after an edit', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 1, text: 'Place these ranges' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('no question field');
        }

        act(() => {
            setTextareaValue(textarea, 'my edit');
        });
        expect(textarea.value).toBe('my edit');

        render({ prefillRequest: { id: 2, text: 'Place these ranges' } });
        expect(textarea.value).toBe('Place these ranges');
    });

    it('does not overwrite typed text again for the same request', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 1, text: 'Place these ranges' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('no question field');
        }

        act(() => {
            setTextareaValue(textarea, 'my edit');
        });
        render({ focusRequest: 1 });

        expect(textarea.value).toBe('my edit');
    });

    it('does not clear typed text when the request is removed', () => {
        const { host, render } = mountPanel({ prefillRequest: { id: 7, text: 'Question' } });
        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        if (textarea === null) {
            throw new Error('no question field');
        }

        act(() => {
            setTextareaValue(textarea, 'Question with clarification');
        });
        render({ prefillRequest: null });

        expect(textarea.value).toBe('Question with clarification');
    });
});

describe('sample questions in the empty state', () => {
    it('prefills the composer on click without sending anything', () => {
        const onAsk = vi.fn(() => Promise.resolve(exchange(99, 'queued')));
        const { host } = mountPanel({ onAsk });

        const example = host.querySelector<HTMLButtonElement>('.chat-panel__example');
        expect(example?.textContent).toBe('What are the riskiest changes here?');
        act(() => {
            example?.click();
        });

        const textarea = host.querySelector<HTMLTextAreaElement>('textarea');
        expect(textarea?.value).toBe('What are the riskiest changes here?');
        expect(textarea?.selectionStart).toBe('What are the riskiest changes here?'.length);
        expect(onAsk).not.toHaveBeenCalled();
    });

    it('shows no examples when the agent is disconnected so the panel offers no unavailable action', () => {
        const { host } = mountPanel({ worker: { kind: 'never' } });

        expect(host.querySelector('.chat-panel__example')).toBeNull();
        expect(host.textContent).toContain('Agent disconnected. New questions are unavailable.');
    });
});

/** Set a controlled input through the native setter, otherwise React will not see the input. */
function setTextareaValue(textarea: HTMLTextAreaElement, value: string): void {
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoke the prototype setter through call
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
}
