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
        answer: status === 'done' ? 'Answer from the **agent**.' : null,
        progressText: status === 'running' ? 'Reading related calls' : null,
        error: status === 'failed' ? 'The model returned no answer.' : null,
        createdAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        updatedAt: `2026-09-01T10:00:0${String(id)}.000Z`,
        ...overrides,
    };
}

function task(id: number, type: UiTask['type'], status: UiTask['status']): UiTask {
    return {
        id,
        type,
        priority: 'interactive',
        status,
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
            commit: 'abcdef1',
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
        expect(queueBannerText([task(1, 'route.section', 'leased')])).toBe(
            'Generating the route · your question is next',
        );
        expect(queueBannerText([task(1, 'echo', 'leased')])).toBe('Agent busy · your question is next');
        expect(queueBannerText([task(1, 'chat', 'leased')])).toBe('Agent busy · your question is next');
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

    it('links a live lease for a cancelled task to the cancelled exchange even when a queued one follows', () => {
        const { host } = mountPanel({
            tasks: [task(10, 'chat', 'leased')],
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
