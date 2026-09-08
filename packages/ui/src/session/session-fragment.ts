import { filterFragmentValue } from '../filters/lens-filters.js';
import type { Viewing } from '../iterations/viewing.js';
import { viewingFragmentPatch } from '../iterations/viewing.js';
import type { SessionState } from './session-store.js';
import { DEFAULT_PRESET, DEFAULT_ROUTE_FILTER } from './session-store.js';

/**
 * What session state writes to the URL fragment. Defaults stay out of the URL. The route preset and
 * filter appear in the URL only when changed.
 *
 * `fragment` contains keys set explicitly by the call ("show at the old commit" sets
 * `thread`). They take precedence over `viewingFragmentPatch` removing anchors from another diff.
 */
export function sessionFragmentPatch(
    state: SessionState,
    previousViewing: Viewing,
    fragment?: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string | null>> {
    return {
        view: state.view,
        filter: filterFragmentValue(state.filter),
        preset: state.preset === DEFAULT_PRESET ? null : state.preset,
        routeFilter: state.routeFilter === DEFAULT_ROUTE_FILTER ? null : state.routeFilter,
        ...viewingFragmentPatch(state.viewing, previousViewing),
        ...fragment,
    };
}
