/**
 * Three views of the PR workspace (README §0, SPEC §2.1). The order in `VIEWS` determines tab order
 * and the order of keys 1/2/3.
 */

import type { MessageKey } from '../i18n/ru.js';

export type ViewId = 'overview' | 'route' | 'diff';

export interface ViewDescriptor {
    readonly id: ViewId;
    /** Tab label key in the dictionary. */
    readonly label: MessageKey;
    /** Label key for the matching palette command ("Overview view"). */
    readonly command: MessageKey;
}

export const VIEWS: readonly ViewDescriptor[] = [
    { id: 'overview', label: 'view.overview', command: 'shortcut.view.overview' },
    { id: 'route', label: 'view.route', command: 'shortcut.view.route' },
    { id: 'diff', label: 'view.diff', command: 'shortcut.view.diff' },
];

/** Always start in Overview (decision log, #2): the route is not ready when opened, so there is nothing to show. */
export const DEFAULT_VIEW: ViewId = 'overview';

/** `null` means the string is not a view identifier (invalid URL value). */
export function parseViewId(value: string | null): ViewId | null {
    return VIEWS.find((view) => view.id === value)?.id ?? null;
}
