// @vitest-environment jsdom
import type { UiFeedbackRequest } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackButton, SHERPA_CHAT_URL } from './feedback-button.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

const CONTEXT = {
    uiVersion: '0.6.0',
    prKey: 'github-quillmart--quillmart--4821',
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
    availability: { available: boolean; reason: string | null },
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
        root.render(<FeedbackButton availability={availability} context={CONTEXT} onSend={onSend} />);
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
    it('without credentials shows the reason and keeps the text available to copy', () => {
        const reason = 'You can send feedback directly to project issues.';
        const host = mountFeedback(
            { available: false, reason },
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

    it('restores sending after closing the form following an unavailable response and preserves the text', async () => {
        const responses = [
            { outcome: 'unavailable' as const, issueKey: null, issueUrl: null, message: 'Cannot obtain a token.' },
            {
                outcome: 'created' as const,
                issueKey: '#7',
                issueUrl: 'https://github.com/quillmart/quillmart/issues/7',
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
        const host = mountFeedback({ available: true, reason: null }, onSend);
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
        expect(host.querySelector('a[href="https://github.com/quillmart/quillmart/issues/7"]')).not.toBeNull();
    });

    it('includes a link to the Sherpa discussion in the form', () => {
        const host = mountFeedback({ available: true, reason: null }, () => Promise.reject(new Error('not called')));

        act(() => {
            button(host, 'Feedback').click();
        });

        const link = host.querySelector<HTMLAnchorElement>('.feedback-popover__chat a');
        expect(link?.href).toBe(SHERPA_CHAT_URL);
        expect(link?.target).toBe('_blank');
        expect(link?.textContent).toBe('Sherpa chat');
    });

    it('shows a link to the created issue after successful submission', async () => {
        const onSend = vi.fn((_request: UiFeedbackRequest) =>
            Promise.resolve({
                outcome: 'created' as const,
                issueKey: '#123456',
                issueUrl: 'https://github.com/quillmart/quillmart/issues/123456',
                message: null,
            }),
        );
        const host = mountFeedback({ available: true, reason: null }, onSend);
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
        const link = host.querySelector<HTMLAnchorElement>('a[href="https://github.com/quillmart/quillmart/issues/123456"]');
        expect(link?.textContent).toBe('#123456');
    });
});
