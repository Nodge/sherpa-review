import type { ReactNode } from 'react';
import { useMemo } from 'react';

import { ShortcutCheatsheet } from '../../components/shortcut-cheatsheet.tsx';
import { ShortcutsProvider } from '../../shortcuts/context.tsx';
import type { Shortcut, ShortcutScope } from '../../shortcuts/registry.js';
import { createShortcutRegistry } from '../../shortcuts/registry.js';

/**
 * M5-T5: `?` shortcuts sheet in 3 scopes. Its registry is separate and complete, with the full SPEC §5 map, while
 * the scope switches for each state: the frames must differ only in the rows
 * available in that scope.
 */

export interface M5T5GalleryState {
    readonly id: string;
    readonly group: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M5_T5_STATES: readonly M5T5GalleryState[] = [
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

/** Full SPEC §5 map as registry declarations, with the same ids as the app. */
const MAP: readonly Omit<Shortcut, 'action'>[] = [
    { id: 'palette.open', keys: ['mod+k'], label: 'Open the command palette', scope: 'global', section: 'navigation' },
    { id: 'view.overview', keys: ['1', 'g o'], label: 'View "Overview"', scope: 'global', section: 'navigation' },
    { id: 'view.route', keys: ['2', 'g r'], label: 'View "Route"', scope: 'global', section: 'navigation' },
    { id: 'view.diff', keys: ['3', 'g d'], label: 'View "Full diff"', scope: 'global', section: 'navigation' },
    { id: 'palette.searchDiff', keys: ['/'], label: 'Search the diff contents', scope: 'global', section: 'navigation' },
    { id: 'help.cheatsheet', keys: ['?'], label: 'Keyboard shortcuts', scope: 'global', section: 'navigation' },
    { id: 'diff.toggleMode', keys: ['d'], label: 'Toggle the diff mode', scope: 'global', section: 'reading' },
    { id: 'agent.ask', keys: ['a'], label: 'Ask the agent about the selection', scope: 'global', section: 'agent' },
    { id: 'route.togglePreset', keys: ['t'], label: 'Toggle the preset (triage / full tour)', scope: 'global', section: 'route' },
    { id: 'review.shipMenu', keys: ['mod+enter'], label: 'Open the ship menu', scope: 'global', section: 'ship' },
    { id: 'review.requestChanges', keys: ['mod+shift+enter'], label: 'Request changes', scope: 'global', section: 'ship' },

    { id: 'route.nextStop', keys: ['j'], label: 'Next stop', scope: 'route', section: 'navigation' },
    { id: 'route.prevStop', keys: ['k'], label: 'Previous stop', scope: 'route', section: 'navigation' },
    { id: 'palette.findFile', keys: ['f'], label: 'Find a file', scope: 'route', section: 'navigation' },
    { id: 'route.toggleStopViewed', keys: ['v'], label: 'Mark the stop viewed', scope: 'route', section: 'reading' },
    { id: 'route.nextUnviewed', keys: ['n'], label: 'Next unviewed stop', scope: 'route', section: 'reading' },
    { id: 'route.prevUnviewed', keys: ['p'], label: 'Previous unviewed stop', scope: 'route', section: 'reading' },
    { id: 'route.expandContext', keys: ['e'], label: 'Expand context around the hunk under the cursor', scope: 'route', section: 'reading' },
    { id: 'route.commentLine', keys: ['c'], label: 'Comment on the line under the cursor', scope: 'route', section: 'comments' },
    { id: 'route.reply', keys: ['r'], label: 'Reply in the thread under the cursor', scope: 'route', section: 'comments' },
    { id: 'route.toggleStopCollapse', keys: ['x'], label: 'Collapse or expand the stop', scope: 'route', section: 'route' },
    { id: 'route.changeFilter', keys: ['w'], label: 'Filter: what is new since the last visit', scope: 'route', section: 'route' },

    { id: 'diff.nextFile', keys: ['j'], label: 'Next file', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.prevFile', keys: ['k'], label: 'Previous file', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.filterFiles', keys: ['f'], label: 'Filter files in the tree', scope: 'full-diff', section: 'navigation' },
    { id: 'diff.markViewed', keys: ['v'], label: 'Mark the file viewed', scope: 'full-diff', section: 'reading' },
    { id: 'diff.nextUnread', keys: ['n'], label: 'Next unviewed file', scope: 'full-diff', section: 'reading' },
    { id: 'diff.prevUnread', keys: ['p'], label: 'Previous unviewed file', scope: 'full-diff', section: 'reading' },
    { id: 'diff.expandContext', keys: ['e'], label: 'Expand context around the hunk under the cursor', scope: 'full-diff', section: 'reading' },
    { id: 'thread.commentLine', keys: ['c'], label: 'Comment on the line under the cursor', scope: 'full-diff', section: 'comments' },
    { id: 'thread.reply', keys: ['r'], label: 'Reply in the thread under the cursor', scope: 'full-diff', section: 'comments' },
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
