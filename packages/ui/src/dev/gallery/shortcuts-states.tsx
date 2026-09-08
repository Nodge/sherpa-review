import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ShortcutCheatsheet } from '../../components/shortcut-cheatsheet.tsx';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import type { Shortcut, ShortcutScope } from '../../shortcuts/registry.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';

/**
 * The `?` shortcuts sheet in three scopes. It has its own complete registry, the whole map from docs/design/SPEC-elements.md §5, and
 * the scope switches for each state: the frames must differ only in the rows
 * available in that scope.
 */

export interface ShortcutGalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const SHORTCUT_STATES: readonly ShortcutGalleryState[] = [
    {
        id: 'cheatsheet-overview',
        group: 'Keyboard shortcuts',
        title: 'shortcuts sheet on Overview (global only)',
        render: () => <CheatsheetState key="cheatsheet-overview" scope="overview" />,
    },
    {
        id: 'cheatsheet-route',
        group: 'Keyboard shortcuts',
        title: 'shortcuts sheet on Route',
        render: () => <CheatsheetState key="cheatsheet-route" scope="route" />,
    },
    {
        id: 'cheatsheet-full-diff',
        group: 'Keyboard shortcuts',
        title: 'shortcuts sheet on Full diff',
        render: () => <CheatsheetState key="cheatsheet-full-diff" scope="full-diff" />,
    },
];

/** The full docs/design/SPEC-elements.md §5 map as registry declarations, with the same ids as the app. */
const MAP: readonly Omit<Shortcut, 'action'>[] = [
    { id: 'palette.open', keys: ['mod+k'], label: 'shortcut.palette.open', scope: 'global', section: 'navigation' },
    { id: 'view.overview', keys: ['1', 'g o'], label: 'shortcut.view.overview', scope: 'global', section: 'navigation' },
    { id: 'view.route', keys: ['2', 'g r'], label: 'shortcut.view.route', scope: 'global', section: 'navigation' },
    { id: 'view.diff', keys: ['3', 'g d'], label: 'shortcut.view.diff', scope: 'global', section: 'navigation' },
    { id: 'palette.searchDiff', keys: ['/'], label: 'shortcut.palette.searchDiff', scope: 'global', section: 'navigation' },
    { id: 'help.cheatsheet', keys: ['?'], label: 'shortcut.help.cheatsheet', scope: 'global', section: 'navigation' },
    { id: 'diff.toggleMode', keys: ['d'], label: 'shortcut.diff.toggleMode', scope: 'global', section: 'reading' },
    { id: 'agent.ask', keys: ['a'], label: 'shortcut.agent.ask', scope: 'global', section: 'agent' },
    { id: 'route.togglePreset', keys: ['t'], label: 'shortcut.route.togglePreset', scope: 'global', section: 'route' },
    { id: 'review.shipMenu', keys: ['mod+enter'], label: 'shortcut.review.shipMenu', scope: 'global', section: 'ship' },
    { id: 'review.requestChanges', keys: ['mod+shift+enter'], label: 'shortcut.review.requestChanges', scope: 'global', section: 'ship' },

    { id: 'route.nextStop', keys: ['j'], label: 'shortcut.route.nextStop', scope: 'route', section: 'navigation' },
    { id: 'route.prevStop', keys: ['k'], label: 'shortcut.route.prevStop', scope: 'route', section: 'navigation' },
    { id: 'palette.findFile', keys: ['f'], label: 'shortcut.palette.findFile', scope: 'route', section: 'navigation' },
    { id: 'route.toggleStopViewed', keys: ['v'], label: 'shortcut.route.toggleStopViewed', scope: 'route', section: 'reading' },
    { id: 'route.nextUnviewed', keys: ['n'], label: 'shortcut.route.nextUnviewed', scope: 'route', section: 'reading' },
    { id: 'route.prevUnviewed', keys: ['p'], label: 'shortcut.route.prevUnviewed', scope: 'route', section: 'reading' },
    { id: 'route.expandContext', keys: ['e'], label: 'shortcut.diff.expandContext', scope: 'route', section: 'reading' },
    { id: 'route.commentLine', keys: ['c'], label: 'shortcut.thread.commentLine', scope: 'route', section: 'comments' },
    { id: 'route.reply', keys: ['r'], label: 'shortcut.thread.reply', scope: 'route', section: 'comments' },
    { id: 'route.toggleStopCollapse', keys: ['x'], label: 'shortcut.route.toggleStopCollapse', scope: 'route', section: 'route' },
    { id: 'route.changeFilter', keys: ['w'], label: 'shortcut.route.changeFilter', scope: 'route', section: 'route' },

    { id: 'diff.nextFile', keys: ['j'], label: 'shortcut.diff.nextFile', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.prevFile', keys: ['k'], label: 'shortcut.diff.prevFile', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.filterFiles', keys: ['f'], label: 'shortcut.diff.filterFiles', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.markViewed', keys: ['v'], label: 'shortcut.diff.markViewed', scope: 'full-diff', section: 'reading' },
    { id: 'diff.nextUnread', keys: ['n'], label: 'shortcut.diff.nextUnread', scope: 'full-diff', section: 'reading' },
    { id: 'diff.prevUnread', keys: ['p'], label: 'shortcut.diff.prevUnread', scope: 'full-diff', section: 'reading' },
    { id: 'diff.expandContext', keys: ['e'], label: 'shortcut.diff.expandContext', scope: 'full-diff', section: 'reading' },
    { id: 'thread.commentLine', keys: ['c'], label: 'shortcut.thread.commentLine', scope: 'full-diff', section: 'comments' },
    { id: 'thread.reply', keys: ['r'], label: 'shortcut.thread.reply', scope: 'full-diff', section: 'comments' },
];

function CheatsheetState({ scope }: { scope: ShortcutScope }) {
    const registry = useMemo(() => {
        const created = createShortcutRegistry();
        for (const shortcut of MAP) {
            created.register({ ...shortcut, action: () => undefined });
        }
        created.setActiveScope(scope);
        return created;
    }, [scope]);

    return (
        <ShortcutsProvider registry={registry}>
            <ShortcutCheatsheet onClose={() => undefined} />
        </ShortcutsProvider>
    );
}
