// @vitest-environment jsdom
import type { UiFeedbackRequest } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FeedbackButton } from './feedback-button.tsx';

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

describe('Feedback form', () => {
    it('without credentials shows the reason and keeps the text available to copy', () => {
        const reason = 'You can send feedback directly to issue #2300 or to Alice Ingram.';
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
