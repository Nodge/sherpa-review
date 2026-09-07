import type { Thread } from '@sherpa/protocol';
import type { RefObject } from 'react';
import { useCallback } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { HunkExpandRequest } from '../../diff-view/hunk-expansion.js';
import { hunkContextRequests } from '../../diff-view/hunk-expansion.js';
import type { DiffViewSnapshot } from '../../diff-view/store.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import type { RouteEntry, RouteFileGroup, RouteModel } from '../../route/route-model.js';
import { changeFilterAvailable, entryParseFailed, entryPending } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { useShortcut } from '../../shortcuts/context.tsx';
import { neighbourId, unreadNeighbourId } from '../../shortcuts/navigation.js';
import type { ThreadStore } from '../../threads/store.js';
import { openReply } from '../../threads/thread-list.tsx';
import { stopFileShownModel } from './stop-file-card.tsx';
import { EMPTY_EXPANSION, entryId } from './stop-lookup.js';
import type { StopViewed } from './use-stop-viewed.js';

export interface RouteShortcutsOptions {
    readonly model: RouteModel;
    /** Entries left after applying the lens and filter: keys navigate only these. */
    readonly shown: readonly RouteEntry[];
    /** Previous iterations are read-only and have no marks at all (M4 scope). */
    readonly readOnly: boolean;
    readonly stopProgress: StopProgressStore;
    readonly unfilledEntry: StopViewed['unfilledEntry'];
    readonly markStop: StopViewed['markStop'];
    readonly toggleCollapse: (entry: RouteEntry) => void;
    readonly focusedLine: { readonly fileId: string; readonly side: 'old' | 'new'; readonly line: number } | null;
    readonly focusedThreadId: string | null;
    readonly threads: readonly Thread[];
    readonly threadStore: ThreadStore;
    readonly commentLine: (fileId: string, side: 'old' | 'new', line: number) => void;
    readonly session: SessionStore;
    readonly changeFilterOn: boolean;
    readonly keyboardStopRef: RefObject<string | null>;
    readonly topStopRef: RefObject<{ stopId: string; offset: number } | null>;
    readonly jumpToStop: (stopId: string) => void;
    readonly diffSnapshot: DiffViewSnapshot;
    readonly openedCollapsed: ReadonlySet<string>;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
}

/**
 * Route shortcuts (SPEC §5): mark and collapse the focused stop, comment and reply,
 * move between stops, filter by "what is new" and expand the bridge. The hook only registers
 * commands and returns nothing.
 */
export function useRouteShortcuts({
    model,
    shown,
    readOnly,
    stopProgress,
    unfilledEntry,
    markStop,
    toggleCollapse,
    focusedLine,
    focusedThreadId,
    threads,
    threadStore,
    commentLine,
    session,
    changeFilterOn,
    keyboardStopRef,
    topStopRef,
    jumpToStop,
    diffSnapshot,
    openedCollapsed,
    expand,
}: RouteShortcutsOptions): void {
    /** The focused stop contains the focused element: its section has `data-stop` (SPEC §5). */
    const focusedEntry = useCallback((): RouteEntry | null => {
        if (typeof document === 'undefined') {
            return null;
        }
        const active = document.activeElement;
        const stopId = active instanceof Element ? (active.closest<HTMLElement>('[data-stop]')?.dataset.stop ?? null) : null;
        return stopId === null ? null : (shown.find((entry) => entryId(entry) === stopId) ?? null);
    }, [shown]);

    /**
     * A mark can be set only after the stop's ranges have been counted. It can always be cleared.
     * Previous iterations have no viewed marks at all (M4 scope).
     */
    const canToggleViewed = useCallback(
        (entry: RouteEntry): boolean =>
            !readOnly &&
            (stopProgress.isViewed(entryId(entry)) ||
                (!entryPending(entry, model.totals) &&
                    !entryParseFailed(entry, model.totals) &&
                    !unfilledEntry(entry))),
        [model.totals, readOnly, stopProgress, unfilledEntry],
    );
    useShortcut({
        id: 'route.toggleStopViewed',
        keys: ['v'],
        label: 'shortcut.route.toggleStopViewed',
        scope: 'route',
        section: 'reading',
        when: () => {
            const entry = focusedEntry();
            return entry !== null && canToggleViewed(entry);
        },
        action: () => {
            const entry = focusedEntry();
            if (entry !== null) {
                void markStop(entryId(entry), !stopProgress.isViewed(entryId(entry)));
            }
        },
    });
    useShortcut({
        id: 'route.toggleStopCollapse',
        keys: ['x'],
        label: 'shortcut.route.toggleStopCollapse',
        scope: 'route',
        section: 'route',
        when: () => focusedEntry() !== null,
        action: () => {
            const entry = focusedEntry();
            if (entry !== null) {
                toggleCollapse(entry);
            }
        },
    });

    useShortcut({
        id: 'route.commentLine',
        keys: ['c'],
        label: 'shortcut.thread.commentLine',
        scope: 'route',
        section: 'comments',
        when: () => focusedLine !== null,
        action: () => {
            if (focusedLine !== null) {
                commentLine(focusedLine.fileId, focusedLine.side, focusedLine.line);
            }
        },
    });
    useShortcut({
        id: 'route.reply',
        keys: ['r'],
        label: 'shortcut.thread.reply',
        scope: 'route',
        section: 'comments',
        when: () => focusedThreadId !== null,
        action: () => {
            const thread = threads.find((candidate) => candidate.id === focusedThreadId);
            if (thread !== undefined) {
                openReply(threadStore, thread);
            }
        },
    });

    // --- Route navigation keys (SPEC §5) ---

    /** Navigation keys count from the previous jump target, otherwise from the top visible stop. */
    const anchorStopId = useCallback(
        (): string | null => keyboardStopRef.current ?? topStopRef.current?.stopId ?? null,
        [keyboardStopRef, topStopRef],
    );
    const jumpFromKeyboard = useCallback(
        (target: string | null) => {
            if (target === null) {
                return;
            }
            keyboardStopRef.current = target;
            jumpToStop(target);
        },
        [jumpToStop, keyboardStopRef],
    );
    const stepToStop = useCallback(
        (direction: 1 | -1) => {
            jumpFromKeyboard(neighbourId(shown, anchorStopId(), direction, entryId));
        },
        [anchorStopId, jumpFromKeyboard, shown],
    );
    const stepToUnviewedStop = useCallback(
        (direction: 1 | -1) => {
            jumpFromKeyboard(
                unreadNeighbourId(
                    shown,
                    anchorStopId(),
                    direction,
                    entryId,
                    (entry) => !stopProgress.isViewed(entryId(entry)),
                ),
            );
        },
        [anchorStopId, jumpFromKeyboard, shown, stopProgress],
    );
    useShortcut({
        id: 'route.nextStop',
        keys: ['j'],
        label: 'shortcut.route.nextStop',
        scope: 'route',
        section: 'navigation',
        action: () => {
            stepToStop(1);
        },
    });
    useShortcut({
        id: 'route.prevStop',
        keys: ['k'],
        label: 'shortcut.route.prevStop',
        scope: 'route',
        section: 'navigation',
        action: () => {
            stepToStop(-1);
        },
    });
    useShortcut({
        id: 'route.nextUnviewed',
        keys: ['n'],
        label: 'shortcut.route.nextUnviewed',
        scope: 'route',
        section: 'reading',
        action: () => {
            stepToUnviewedStop(1);
        },
    });
    useShortcut({
        id: 'route.prevUnviewed',
        keys: ['p'],
        label: 'shortcut.route.prevUnviewed',
        scope: 'route',
        section: 'reading',
        action: () => {
            stepToUnviewedStop(-1);
        },
    });
    useShortcut({
        id: 'route.changeFilter',
        keys: ['w'],
        label: 'shortcut.route.changeFilter',
        scope: 'route',
        section: 'route',
        consequence: changeFilterOn ? 'shortcut.route.changeFilter.off' : 'shortcut.route.changeFilter.on',
        when: () => changeFilterAvailable(model.entries),
        action: () => {
            session.setRouteFilter(changeFilterOn ? 'all' : 'new');
        },
    });

    /**
     * The focused card: the section (`data-stop`) gives the stop, the focused row gives the file.
     * The same file appears in several stops, so `fileId` alone cannot identify
     * the card.
     */
    const focusedCard = useCallback((): { readonly stopId: string; readonly group: RouteFileGroup } | null => {
        if (focusedLine === null || typeof document === 'undefined') {
            return null;
        }
        const active = document.activeElement;
        const stopId = active instanceof Element ? (active.closest<HTMLElement>('[data-stop]')?.dataset.stop ?? null) : null;
        if (stopId === null) {
            return null;
        }
        const entry = shown.find((candidate) => entryId(candidate) === stopId);
        if (entry?.kind !== 'stop') {
            return null;
        }
        const group = entry.view.files.find((candidate) => candidate.fileId === focusedLine.fileId);
        return group === undefined ? null : { stopId, group };
    }, [focusedLine, shown]);
    const focusedHunkRequests = useCallback((): readonly HunkExpandRequest[] => {
        const card = focusedCard();
        if (card === null || focusedLine === null) {
            return [];
        }
        const model = stopFileShownModel(
            card.group,
            diffSnapshot.models.get(card.group.fileId) ?? null,
            diffSnapshot.content.get(card.group.fileId) ?? null,
            diffSnapshot.expansion.get(card.group.fileId) ?? EMPTY_EXPANSION,
            openedCollapsed.has(`${card.stopId}\u0000${card.group.fileId}`),
        );
        return model === null ? [] : hunkContextRequests(model, focusedLine.side, focusedLine.line);
    }, [diffSnapshot, focusedCard, focusedLine, openedCollapsed]);
    useShortcut({
        id: 'route.expandContext',
        keys: ['e'],
        label: 'shortcut.diff.expandContext',
        scope: 'route',
        section: 'reading',
        when: () => focusedHunkRequests().length > 0,
        action: () => {
            const card = focusedCard();
            if (card === null) {
                return;
            }
            for (const request of focusedHunkRequests()) {
                void expand(card.group.fileId, { kind: 'gap', ...request });
            }
        },
    });
}
