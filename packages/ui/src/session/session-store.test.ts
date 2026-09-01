import { describe, expect, it, vi } from 'vitest';

import {
    createSessionStore,
    DEFAULT_THREADS_SHOW,
    EMPTY_NOTE_STACKS_EXPANDED,
    EMPTY_NOTES_EXPANDED,
    EMPTY_STOPS,
    isNoteExpanded,
    isNoteStackExpanded,
    parsePreset,
} from './session-store.js';
import { DEFAULT_VIEW, parseViewId } from './views.js';

describe('session store', () => {
    it('starts in Overview: the route is not ready when opened (decision #2)', () => {
        expect(DEFAULT_VIEW).toBe('overview');

        // This is how main.tsx chooses the view at startup. The URL overrides the default, but invalid URL values do not.
        const fromUrl = (value: string | null) =>
            createSessionStore({ initial: { view: parseViewId(value) ?? DEFAULT_VIEW, filter: 'all' } })
                .getSnapshot().view;

        expect(fromUrl(null)).toBe('overview');
        expect(fromUrl('garbage')).toBe('overview');
        expect(fromUrl('route')).toBe('route');
    });

    it('returns a stable snapshot and changes it on setView', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const first = store.getSnapshot();

        expect(store.getSnapshot()).toBe(first);

        store.setView('diff');
        expect(store.getSnapshot()).toEqual({
            view: 'diff',
            filter: 'all',
            preset: 'triage',
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
            chatOpen: false,
            notesExpanded: EMPTY_NOTES_EXPANDED,
            noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
            stops: EMPTY_STOPS,
        });
    });

    it('defaults the preset to triage, allows changes and preserves it through fragment parsing', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' }, persist });

        expect(store.getSnapshot().preset).toBe('triage');

        store.setPreset('tour');
        store.setPreset('tour');

        expect(store.getSnapshot().preset).toBe('tour');
        expect(persist).toHaveBeenCalledTimes(1);
        expect(parsePreset('tour')).toBe('tour');
        expect(parsePreset('garbage')).toBeNull();
        expect(createSessionStore({ initial: { view: 'route', filter: 'all', preset: 'tour' } }).getSnapshot().preset).toBe(
            'tour',
        );
    });

    it('notifies subscribers of changes and stays silent when the same value repeats', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        store.subscribe(listener);

        store.setView('route');
        store.setView('route');

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reports each view selection separately, even when selecting the current view', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });
        const listener = vi.fn();
        store.subscribeViewSelection(listener);

        store.setView('diff');
        store.setView('route');

        expect(store.getViewSelectionSnapshot()).toBe(2);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('stops notifications after unsubscribing', () => {
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' } });
        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);

        unsubscribe();
        store.setView('diff');

        expect(listener).not.toHaveBeenCalled();
    });

    it('calls persist on each change with the new state', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'overview', filter: 'all' }, persist });

        store.setView('diff');
        store.setView('diff');

        expect(persist.mock.calls).toEqual([
            [
                {
                    view: 'diff',
                    filter: 'all',
                    preset: 'triage',
                    threadsShow: DEFAULT_THREADS_SHOW,
                    paletteOpen: false,
                    chatOpen: false,
                    notesExpanded: EMPTY_NOTES_EXPANDED,
                    noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
                    stops: EMPTY_STOPS,
                },
            ],
        ]);
    });

    it('keeps the snapshot unchanged when nothing changes so useSyncExternalStore skips unnecessary renders', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const before = store.getSnapshot();

        store.setView('route');
        store.setFilter('all');

        expect(store.getSnapshot()).toBe(before);
    });

    it('changes the filter independently of the view and persists it too', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all', threadsShow: DEFAULT_THREADS_SHOW }, persist });

        store.setFilter('pci');

        const expected = {
            view: 'diff',
            filter: 'pci',
            preset: 'triage',
            threadsShow: DEFAULT_THREADS_SHOW,
            paletteOpen: false,
            chatOpen: false,
            notesExpanded: EMPTY_NOTES_EXPANDED,
            noteStacksExpanded: EMPTY_NOTE_STACKS_EXPANDED,
            stops: EMPTY_STOPS,
        };

        expect(store.getSnapshot()).toEqual(expected);
        expect(persist.mock.calls).toEqual([[expected]]);
    });

    it('keeps palette open state in the session without changing other fields', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        store.setPaletteOpen(true);

        expect(store.getSnapshot()).toMatchObject({ view: 'diff', filter: 'all', paletteOpen: true });
    });

    it('keeps chat open state in the session without separate storage', () => {
        const persist = vi.fn();
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' }, persist });

        store.setChatOpen(true);
        store.setChatOpen(true);

        expect(store.getSnapshot().chatOpen).toBe(true);
        expect(persist).toHaveBeenCalledTimes(1);
    });

    it('shares note expansion between both views and keeps it only in the session', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
        store.toggleNoteExpanded(31);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);

        store.setView('diff');
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);
        store.expandNote(31);
        expect(store.getSnapshot().notesExpanded).toEqual(new Set(['31']));

        store.toggleNoteExpanded(31);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
    });

    it('preserves stack expansion across view changes and closes its notes when collapsed', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });
        const stackKey = 'file-1:new:41:43';

        store.setNoteStackExpanded(stackKey, true);
        store.expandNote(31);
        store.setView('diff');

        expect(isNoteStackExpanded(store.getSnapshot(), stackKey)).toBe(true);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(true);

        store.collapseNoteStack(stackKey, [31, 32]);

        expect(isNoteStackExpanded(store.getSnapshot(), stackKey)).toBe(false);
        expect(isNoteExpanded(store.getSnapshot(), 31)).toBe(false);
    });

    it('preserves previous expansion when clearing a stop mark but removes temporary expansion', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopExpanded('s05', true);
        store.setViewedStopExpanded('s05', true);

        expect(store.getSnapshot().stops).toEqual({
            expanded: new Set(['s05']),
            expandedViewed: new Set(['s05']),
            collapsed: new Set(),
            testCode: new Set(),
        });

        store.forgetViewedExpansion('s05');

        expect(store.getSnapshot().stops).toEqual({
            expanded: new Set(['s05']),
            expandedViewed: new Set(),
            collapsed: new Set(),
            testCode: new Set(),
        });
    });

    it('keeps expanded digest test code separate from expansions and collapses', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopTestCode('s04', true);

        expect(store.getSnapshot().stops.testCode).toEqual(new Set(['s04']));
        expect(store.getSnapshot().stops.expanded).toEqual(new Set());
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set());

        store.setStopTestCode('s04', false);
        expect(store.getSnapshot().stops.testCode).toEqual(new Set());
    });

    it('keeps manual stop collapse separate from expansions', () => {
        const store = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        store.setStopCollapsed('s01', true);
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set(['s01']));

        store.setStopCollapsed('s01', false);
        expect(store.getSnapshot().stops.collapsed).toEqual(new Set());
    });

    it('thread filters change in a single session write', () => {
        const store = createSessionStore({ initial: { view: 'diff', filter: 'all' } });

        store.setThreadsShow({ people: true, bots: true, resolved: false });

        expect(store.getSnapshot().threadsShow).toEqual({ people: true, bots: true, resolved: false });
    });

    it('pins the URL view immediately and the default view only after the reviewer chooses', () => {
        const fromUrl = createSessionStore({ initial: { view: 'route', filter: 'all' }, viewPinned: true });
        const byDefault = createSessionStore({ initial: { view: 'route', filter: 'all' } });

        expect(fromUrl.viewPinned()).toBe(true);
        expect(byDefault.viewPinned()).toBe(false);

        // Selecting the same view again still counts as a choice. The application no longer replaces it.
        byDefault.setView('route');
        expect(byDefault.viewPinned()).toBe(true);
    });
});
