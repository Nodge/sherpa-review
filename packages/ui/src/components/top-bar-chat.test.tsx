// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentPillView } from './agent-pill-view.js';
import { AgentPill } from './top-bar.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function clickPill(view: AgentPillView, onToggleChat = vi.fn()) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <AgentPill
                view={view}
                reconnectCommand="/sherpa fixture-medium"
                onToggleChat={onToggleChat}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    act(() => {
        host.querySelector<HTMLButtonElement>('.agent-pill')?.click();
    });
    return { host, onToggleChat };
}

function view(tone: AgentPillView['tone']): AgentPillView {
    return {
        tone,
        workerKind: tone === 'disconnected' ? 'disconnected' : 'connected',
        label: 'Agent',
        title: 'claude-code · opus-5',
    };
}

describe('clicking the agent indicator', () => {
    it('connected agent toggles chat without a scroll target', () => {
        const { onToggleChat } = clickPill(view('connected'));

        expect(onToggleChat).toHaveBeenCalledWith(null);
    });

    it('working agent opens chat at the queue banner', () => {
        const { onToggleChat } = clickPill(view('working'));

        expect(onToggleChat).toHaveBeenCalledWith('queue');
    });

    it('failure opens chat at the error', () => {
        const { onToggleChat } = clickPill(view('failed'));

        expect(onToggleChat).toHaveBeenCalledWith('error');
    });

    it('disconnected agent keeps the reconnect popover and does not toggle chat', () => {
        const { host, onToggleChat } = clickPill(view('disconnected'));

        expect(onToggleChat).not.toHaveBeenCalled();
        expect(host.querySelector<HTMLInputElement>('.command-box__command')?.value).toBe('/sherpa fixture-medium');
    });
});
