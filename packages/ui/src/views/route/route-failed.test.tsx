// @vitest-environment jsdom
import { routeFixtures } from '@sherpa/fixtures';
import type { UiRouteFailure } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { RouteFailedCard } from './generation-card.tsx';

/**
 * Real clicks on the failure card (README §12): "Retry" actually calls generation,
 * and "Show the raw output" expands the model output itself.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FAILURE: UiRouteFailure = (() => {
    const failure = routeFixtures('medium')?.states.failed?.failure ?? null;
    if (failure === null) {
        throw new Error('the medium fixture needs a generation failure state');
    }
    return failure;
})();

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

interface Mounted {
    readonly host: HTMLElement;
    readonly retries: number[];
    readonly opens: number[];
}

function mount(
    options: { failure?: UiRouteFailure; retrying?: boolean; initialRawShown?: boolean } = {},
): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const retries: number[] = [];
    const opens: number[] = [];
    const root = createRoot(host);

    act(() => {
        root.render(
            <RouteFailedCard
                failure={options.failure ?? FAILURE}
                retrying={options.retrying ?? false}
                initialRawShown={options.initialRawShown ?? false}
                onRetry={() => {
                    retries.push(retries.length + 1);
                }}
                onOpenDiff={() => {
                    opens.push(opens.length + 1);
                }}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, retries, opens };
}

function button(scope: HTMLElement, text: string): HTMLButtonElement {
    const found = [...scope.querySelectorAll('button')].find((element) => element.textContent.trim() === text);
    if (found === undefined) {
        throw new Error(`button "${text}" is missing from the markup`);
    }
    return found;
}

function click(element: HTMLElement): void {
    act(() => {
        element.click();
    });
}

describe('generation failure card', () => {
    it('"Retry" starts generation on every click', () => {
        const { host, retries } = mount();

        click(button(host, 'Retry'));
        click(button(host, 'Retry'));

        expect(retries).toHaveLength(2);
    });

    it('the loading button blocks a second request while its glyph spins', () => {
        const { host, retries } = mount({ retrying: true });
        const retry = button(host, 'Retry');

        expect(retry.disabled).toBe(true);
        expect(host.querySelector('.gen-retry__glyph.is-spinning')).not.toBeNull();

        click(retry);

        expect(retries).toHaveLength(0);
    });

    it('"Show the raw output" expands the model output and collapses it again', () => {
        const { host } = mount();
        const toggle = button(host, 'Show the raw output');

        expect(host.querySelector('.gen-failed__raw')).toBeNull();
        expect(toggle.getAttribute('aria-expanded')).toBe('false');

        click(toggle);

        const raw = host.querySelector('.gen-failed__raw');
        expect(raw?.textContent).toBe(FAILURE.rawOutput);
        expect(button(host, 'Hide the raw output').getAttribute('aria-expanded')).toBe('true');

        click(button(host, 'Hide the raw output'));

        expect(host.querySelector('.gen-failed__raw')).toBeNull();
    });

    it('output expanded from the start provides a state gallery frame', () => {
        const { host } = mount({ initialRawShown: true });

        expect(host.querySelector('.gen-failed__raw')?.textContent).toBe(FAILURE.rawOutput);
        expect(button(host, 'Hide the raw output').getAttribute('aria-expanded')).toBe('true');
    });

    it('omits the raw output button entirely when the model returned nothing', () => {
        const { host } = mount({ failure: { message: FAILURE.message, rawOutput: null } });

        expect([...host.querySelectorAll('button')].map((element) => element.textContent.trim())).toEqual([
            'Retry',
            'Read the full diff',
        ]);
    });

    it('the footer opens the reader, which generation failure leaves intact', () => {
        const { host, opens } = mount();

        expect(host.textContent).toContain('The reader below is untouched — the full diff is available.');
        click(button(host, 'Read the full diff'));

        expect(opens).toHaveLength(1);
    });
});
