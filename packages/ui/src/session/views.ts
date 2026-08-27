/**
 * Three views of the PR workspace (README §0, SPEC §2.1). The order in `VIEWS` determines tab order
 * and the order of keys 1/2/3.
 */

export type ViewId = 'overview' | 'route' | 'diff';

export interface ViewDescriptor {
    readonly id: ViewId;
    /** Tab label. The English handoff copy is translated (decision log: the UI is in Russian). */
    readonly label: string;
}

export const VIEWS: readonly ViewDescriptor[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'route', label: 'Route' },
    { id: 'diff', label: 'Full diff' },
];

/** Always start in Overview (decision log, #2): the route is not ready when opened, so there is nothing to show. */
export const DEFAULT_VIEW: ViewId = 'overview';

/** `null` means the string is not a view identifier (invalid URL value). */
export function parseViewId(value: string | null): ViewId | null {
    return VIEWS.find((view) => view.id === value)?.id ?? null;
}
