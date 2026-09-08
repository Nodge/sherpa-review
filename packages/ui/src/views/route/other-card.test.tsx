// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RouteOtherView } from '../../route/route-model.js';
import { OtherCard, RegenerateBanner } from './other-card.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

describe('insufficiently explained route banner', () => {
    it('keeps the advice without a dead button when generation is unavailable', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.textContent).toContain('consider regenerating');
        expect(host.querySelector('button')).toBeNull();
    });

    it('offers an enabled regeneration button that calls the same entry point', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const onGenerate = vi.fn();
        const root = createRoot(host);
        act(() => {
            root.render(<RegenerateBanner onGenerate={onGenerate} />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        const button = host.querySelector('button');
        expect(button?.textContent).toBe('Regenerate');
        expect(button?.getAttribute('type')).toBe('button');
        act(() => {
            button?.click();
        });
        expect(onGenerate).toHaveBeenCalledOnce();
    });
});

const OTHER_VIEW: RouteOtherView = {
    stop: {
        id: 'other',
        planIndex: 6,
        tier: 'other',
        title: 'Other: the model did not place these lines',
        paragraph: null,
        bridge: null,
        anchors: [],
        tests: [],
        validationNotes: [],
        droppedClaims: 0,
        status: 'ready',
        provenance: null,
        change: null,
    },
    planLabel: '07',
    files: [],
    lines: 34,
    conflictFiles: 0,
};

function renderCard(patch: Partial<Parameters<typeof OtherCard>[0]> = {}): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <OtherCard
                view={OTHER_VIEW}
                stopCount={7}
                opened={false}
                onOpen={() => undefined}
                diff={null}
                pending={false}
                {...patch}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function askButton(host: HTMLElement): HTMLButtonElement | null {
    return (
        [...host.querySelectorAll<HTMLButtonElement>('.route-other__action')].find((button) =>
            button.textContent.startsWith('Ask the agent'),
        ) ?? null
    );
}

describe('Other\'s "ask the agent to place them" entry point', () => {
    it('omits the button entirely without a handler', () => {
        const host = renderCard();

        expect(askButton(host)).toBeNull();
        expect(host.textContent).not.toContain('the answer lands in the chat');
    });

    it('calls the handler when the agent is connected and warns that the route will stay unchanged', () => {
        const onAskToPlace = vi.fn();
        const host = renderCard({ onAskToPlace, agentConnected: true });

        const button = askButton(host);
        expect(button?.disabled).toBe(false);
        expect(host.textContent).toContain('the answer lands in the chat, the route does not change');
        act(() => {
            button?.click();
        });

        expect(onAskToPlace).toHaveBeenCalledOnce();
    });

    it('disables the action when the agent disconnects, with the same wording as the popover', () => {
        const host = renderCard({ onAskToPlace: () => undefined, agentConnected: false });

        const button = askButton(host);
        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe('Reconnect the agent to ask about these lines');
    });

    it('has no ranges to list in the question while they are being counted', () => {
        const pending = renderCard({ onAskToPlace: () => undefined, agentConnected: true, pending: true });
        expect(askButton(pending)?.disabled).toBe(true);
        expect(askButton(pending)?.title).toBe('Counting the uncovered lines…');

        const filling = renderCard({ onAskToPlace: () => undefined, agentConnected: true, filling: true });
        expect(askButton(filling)?.disabled).toBe(true);
        expect(askButton(filling)?.title).toBe('Waiting for the route to fill');
    });
});

describe('conflict line in Other', () => {
    it('stays silent when there are no conflicts', () => {
        expect(renderCard().querySelector('.route-other__conflicts')).toBeNull();
    });

    it('shows the file count and directs the reviewer to resolve conflicts in the host (docs/design/SPEC-elements.md §4.1)', () => {
        const host = renderCard({ view: { ...OTHER_VIEW, conflictFiles: 2 } });
        const line = host.querySelector('.route-other__conflicts');

        expect(line?.textContent).toContain('2 files have conflicts');
        expect(line?.textContent).toContain('they are out of coverage');
    });

    it('shows only conflicts without "0 lines in 0 files" or buttons acting on nothing', () => {
        const host = renderCard({
            view: { ...OTHER_VIEW, files: [], lines: 0, conflictFiles: 2 },
            onAskToPlace: () => undefined,
            agentConnected: true,
        });

        expect(host.textContent).not.toContain('were left without a stop');
        expect(host.textContent).not.toContain('Open 0');
        expect(host.querySelector('.route-other__actions')).toBeNull();
        expect(askButton(host)).toBeNull();
        expect(host.textContent).toContain('Not a single changed line was left without a stop');
        expect(host.querySelector('.route-other__conflicts')?.textContent).toContain('2 files have conflicts');
    });
});
