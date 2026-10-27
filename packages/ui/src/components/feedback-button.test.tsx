// @vitest-environment jsdom
import type { UiFeedbackChannel, UiFeedbackRequest } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackButton } from './feedback-button.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

const CHAT_URL = 'https://chat.example/sherpa';
const AVAILABLE: UiFeedbackChannel = { kind: 'issues', available: true, reason: null, discussionUrl: CHAT_URL };

const CONTEXT = {
    uiVersion: '0.6.0',
    prKey: 'fixture-4821',
    view: 'overview',
    routePhase: 'ready',
    worker: {
        kind: 'connected',
        workerId: 'w-1',
        harness: 'claude-code',
        model: 'claude-opus-5',
        registeredAt: '2026-08-27T10:00:00.000Z',
        lastSeenAt: '2026-08-27T10:01:00.000Z',
    },
} as const;

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mountFeedback(
    channel: UiFeedbackChannel,
    onSend: (request: UiFeedbackRequest) => Promise<{
        outcome: 'created' | 'unavailable';
        issueKey: string | null;
        issueUrl: string | null;
        message: string | null;
    }>,
): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<FeedbackButton channel={channel} context={CONTEXT} onSend={onSend} />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function button(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll('button')].find((item) => item.textContent.trim() === label);
    if (found === undefined) {
        throw new Error(`no button ${label}`);
    }
    return found;
}

function typeText(host: HTMLElement, value: string): void {
    const textarea = host.querySelector('textarea');
    if (textarea === null) {
        throw new Error('no feedback field');
    }
    act(() => {
        Object.defineProperty(textarea, 'value', { configurable: true, value, writable: true });
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
}

describe('Feedback form', () => {
    it('shows reason for an unavailable channel and keeps the text available for copying', () => {
        const reason = 'Feedback can be sent directly to the project issue queue.';
        const host = mountFeedback(
            { kind: 'issues', available: false, reason, discussionUrl: CHAT_URL },
            () => Promise.reject(new Error('sending unavailable')),
        );

        act(() => {
            button(host, 'Feedback').click();
        });

        expect(host.textContent).toContain(reason);
        expect(button(host, 'Copy the text').disabled).toBe(true);
        expect(host.querySelector('textarea')).not.toBeNull();
        expect([...host.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Send')).toBe(false);
    });

    it('keeps a channel unavailable without a reason, with generic text and no send action', () => {
        const host = mountFeedback(
            { kind: 'issues', available: false, reason: null, discussionUrl: CHAT_URL },
            () => Promise.reject(new Error('sending unavailable')),
        );

        act(() => {
            button(host, 'Feedback').click();
        });

        expect(host.textContent).toContain('The feedback channel is unavailable right now.');
        expect([...host.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Send')).toBe(false);
    });

    it('restores sending after closing the form following an unavailable response and preserves the text', async () => {
        const responses = [
            { outcome: 'unavailable' as const, issueKey: null, issueUrl: null, message: 'Cannot obtain a token.' },
            {
                outcome: 'created' as const,
                issueKey: '#7',
                issueUrl: 'https://github.com/example/sherpa/issues/7',
                message: null,
            },
        ];
        const onSend = vi.fn((_request: UiFeedbackRequest) => {
            const next = responses.shift();
            if (next === undefined) {
                throw new Error('unexpected onSend call');
            }
            return Promise.resolve(next);
        });
        const host = mountFeedback(AVAILABLE, onSend);
        act(() => {
            button(host, 'Feedback').click();
        });
        typeText(host, 'Keep this');

        await act(async () => {
            button(host, 'Send').click();
            await Promise.resolve();
        });
        expect(host.textContent).toContain('Cannot obtain a token.');
        expect([...host.querySelectorAll('button')].some((item) => item.textContent.trim() === 'Send')).toBe(false);

        act(() => {
            button(host, 'Cancel').click();
        });
        act(() => {
            button(host, 'Feedback').click();
        });
        expect(host.querySelector('textarea')?.value).toBe('Keep this');
        await act(async () => {
            button(host, 'Send').click();
            await Promise.resolve();
        });

        expect(onSend).toHaveBeenCalledTimes(2);
        expect(host.querySelector('a[href="https://github.com/example/sherpa/issues/7"]')).not.toBeNull();
    });

    it('shows the discussion link supplied by the channel', () => {
        const host = mountFeedback(AVAILABLE, () => Promise.reject(new Error('not called')));

        act(() => {
            button(host, 'Feedback').click();
        });

        const link = host.querySelector<HTMLAnchorElement>('.feedback-popover__chat a');
        expect(link?.href).toBe(CHAT_URL);
        expect(link?.target).toBe('_blank');
        expect(link?.textContent).toBe('Sherpa chat');
    });

    it('omits the chat line without a discussion link', () => {
        const host = mountFeedback({ ...AVAILABLE, discussionUrl: null }, () => Promise.reject(new Error('not called')));

        act(() => {
            button(host, 'Feedback').click();
        });

        expect(host.querySelector('textarea')).not.toBeNull();
        expect(host.querySelector('.feedback-popover__chat')).toBeNull();
    });

    it('opens a link channel in a new tab without a form', () => {
        const url = 'https://github.com/example/sherpa/issues';
        const host = mountFeedback({ kind: 'link', url }, () => Promise.reject(new Error('not called')));

        const link = host.querySelector<HTMLAnchorElement>('a.feedback-button');
        expect(link?.href).toBe(url);
        expect(link?.target).toBe('_blank');
        expect(link?.rel).toBe('noreferrer');
        expect(link?.className).toBe('ctl ctl--ghost ctl--topbar feedback-button');
        expect(link?.textContent).toBe('Feedback');
        expect(host.querySelector('button')).toBeNull();
        expect(host.querySelector('.feedback-popover')).toBeNull();
    });

    it('shows a link to the created issue after successful submission', async () => {
        const onSend = vi.fn((_request: UiFeedbackRequest) =>
            Promise.resolve({
                outcome: 'created' as const,
                issueKey: '#123456',
                issueUrl: 'https://github.com/example/sherpa/issues/123456',
                message: null,
            }),
        );
        const host = mountFeedback(AVAILABLE, onSend);
        act(() => {
            button(host, 'Feedback').click();
        });
        const textarea = host.querySelector('textarea');
        if (textarea === null) {
            throw new Error('no feedback field');
        }
        act(() => {
            Object.defineProperty(textarea, 'value', {
                configurable: true,
                value: 'Publication status is not visible',
                writable: true,
            });
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
        });

        await act(async () => {
            button(host, 'Send').click();
            await Promise.resolve();
        });

        expect(onSend).toHaveBeenCalledWith({
            text: 'Publication status is not visible',
            includeContext: true,
            context: { view: 'overview', routePhase: 'ready', uiVersion: '0.6.0' },
        });
        const link = host.querySelector<HTMLAnchorElement>('a[href="https://github.com/example/sherpa/issues/123456"]');
        expect(link?.textContent).toBe('#123456');
    });

    it.each([
        { issueKey: null, issueUrl: null, summary: 'Issue created.' },
        { issueKey: 'SH-1', issueUrl: null, summary: 'Issue created SH-1.' },
    ])('treats success without a link ($issueKey) as success without resubmission', async ({ issueKey, issueUrl, summary }) => {
        const onSend = vi.fn((_request: UiFeedbackRequest) =>
            Promise.resolve({ outcome: 'created' as const, issueKey, issueUrl, message: null }),
        );
        const host = mountFeedback(AVAILABLE, onSend);
        act(() => {
            button(host, 'Feedback').click();
        });
        typeText(host, 'No link');

        await act(async () => {
            button(host, 'Send').click();
            await Promise.resolve();
        });

        const success = host.querySelector('.feedback-popover__success');
        expect(success?.querySelector('p')?.textContent).toBe(summary);
        expect(success?.querySelector('a')).toBeNull();
        expect(host.querySelector('textarea')).toBeNull();
        expect(host.querySelector('[role="alert"]')).toBeNull();
        expect(onSend).toHaveBeenCalledTimes(1);

        act(() => {
            button(host, 'Close').click();
        });
        act(() => {
            button(host, 'Feedback').click();
        });
        expect(host.querySelector('textarea')?.value).toBe('');
    });
});
