// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { TOUR_CARD_BODY_ID } from './tour-card.tsx';
import { TourLayer } from './tour-layer.tsx';
import type { TourStep } from './tour-model.js';
import { tourSteps } from './tour-model.js';

/**
 * Tour layer anchor selection. Geometry cannot be checked here, since jsdom gives everything zero rectangles,
 * but the chosen target is visible: the layer lends it `aria-describedby` pointing to the card body (§7).
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PROGRESS: TourStep = step('progress');

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    document.body.innerHTML = '';
});

function step(id: TourStep['id']): TourStep {
    const found = tourSteps(true).find((candidate) => candidate.id === id);
    if (found === undefined) {
        throw new Error(`no step ${id}`);
    }
    return found;
}

/** Page markup beneath the layer: anchors appear in document order. */
function page(html: string): void {
    document.body.innerHTML = html;
}

async function mountLayer(current: TourStep): Promise<() => void> {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<TourLayer step={current} index={0} total={8} epoch="test" {...NOOPS} />);
    });
    // The first measurement waits a tick so the step markup is in place before it is measured.
    await act(async () => {
        await new Promise((resolve) => {
            setTimeout(resolve, 5);
        });
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return unmount;
}

const NOOPS = {
    onNext: (): void => undefined,
    onBack: (): void => undefined,
    onSkip: (): void => undefined,
};

function described(id: string): boolean {
    return document.getElementById(id)?.getAttribute('aria-describedby') === TOUR_CARD_BODY_ID;
}

describe('step anchor', () => {
    it('uses the tour scaffold anchor when it sits above a view with the same anchor', async () => {
        // The generation skeleton and tour placeholder each have a coverage bar. The latter is visible.
        page(`
            <div class="route-skeleton__bar"><div id="under" data-tour="progress"></div></div>
            <div class="tour-scaffold"><div id="scaffold" data-tour="progress"></div></div>
        `);

        await mountLayer(PROGRESS);

        expect(described('scaffold')).toBe(true);
        expect(described('under')).toBe(false);
    });

    it('uses the view anchor when there is no scaffold', async () => {
        page('<div class="route-toolbar"><div id="under" data-tour="progress"></div></div>');

        await mountLayer(PROGRESS);

        expect(described('under')).toBe(true);
    });

    it('removes the borrowed `aria-describedby` with the layer', async () => {
        page('<div id="under" data-tour="progress"></div>');

        const unmount = await mountLayer(PROGRESS);
        expect(described('under')).toBe(true);

        unmount();
        expect(document.getElementById('under')?.hasAttribute('aria-describedby')).toBe(false);
    });
});
