import { describe, expect, it } from 'vitest';

import type { StopBox } from './scroll.js';
import { pickTopStop } from './scroll.js';

/**
 * Scroll anchor selection (docs/design/SPEC-elements.md §2.5) controls both keeping a stop on screen during a filter change
 * and restoring position during a preset change. Coordinates are used as given, so no DOM is needed here.
 */

/** Container starts at 100px. The 99px sticky toolbar covers the strip up to 199px. */
const CONTAINER_TOP = 100;
const LINE = 199;

function boxes(...rows: readonly [string, number, number][]): StopBox[] {
    return rows.map(([stopId, top, bottom]) => ({ stopId, top, bottom }));
}

describe('pickTopStop', () => {
    it('selects the first stop visible below the toolbar', () => {
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s01', -400, 250], ['s02', 250, 900]));

        expect(anchor).toEqual({ stopId: 's01', offset: -500 });
    });

    it('skips a stop whose tail is entirely hidden under the toolbar', () => {
        // The tail of s01 (30px) is visible only within the toolbar strip. The reviewer is already reading s02.
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s01', -400, 169], ['s02', 169, 900]));

        expect(anchor).toEqual({ stopId: 's02', offset: 69 });
    });

    it('measures the offset from the container edge, not the toolbar', () => {
        const anchor = pickTopStop(CONTAINER_TOP, LINE, boxes(['s03', 140, 800]));

        // The stop starts under the toolbar. Restoring places it at exactly the same 40px.
        expect(anchor).toEqual({ stopId: 's03', offset: 40 });
    });

    it('keeps the previous anchor when no stops are visible', () => {
        expect(pickTopStop(CONTAINER_TOP, LINE, boxes())).toBeNull();
        expect(pickTopStop(CONTAINER_TOP, LINE, boxes(['s07', -900, 150]))).toBeNull();
    });
});
