import type { Dispatch, SetStateAction } from 'react';
import { useCallback, useEffect, useRef } from 'react';

import type { ContextExpandRequest, ContextExpandResult } from '../../diff-view/context-expansion.js';
import type { DiffViewStore } from '../../diff-view/store.js';
import { ALL_FILTER_ID } from '../../filters/lens-filters.js';
import type { StopProgressStore } from '../../progress/stop-progress-store.js';
import { buildDigest, resolveAnchor } from '../../route/digest.js';
import type { RouteEntry, RouteModel } from '../../route/route-model.js';
import type { SessionStore } from '../../session/session-store.js';
import { collapsedKey, entryId, routeEntryForLine, routeEntryForShownLine } from './stop-lookup.js';
import type { RequestJump } from './use-route-jump.js';

export interface RouteRevealOptions {
    readonly model: RouteModel;
    /** Files in the lens. `null` means no lens. The view first restores a jump target hidden by the lens. */
    readonly fileIds: ReadonlySet<string> | null;
    readonly matches: (entry: RouteEntry, ids: ReadonlySet<string> | null) => boolean;
    readonly session: SessionStore;
    readonly store: DiffViewStore;
    readonly stopProgress: StopProgressStore;
    readonly setOtherOpen: Dispatch<SetStateAction<boolean>>;
    readonly openedCollapsed: ReadonlySet<string>;
    readonly setOpenedCollapsed: Dispatch<SetStateAction<ReadonlySet<string>>>;
    readonly expand: (fileId: string, request: ContextExpandRequest) => Promise<ContextExpandResult>;
    readonly requestJump: RequestJump;
    readonly initialSelectionTarget: { readonly fileId: string; readonly side: 'old' | 'new'; readonly start: number } | null;
    readonly selectionNavigationRequest: number;
}

export interface RouteReveal {
    readonly expandStop: (stopId: string) => void;
    readonly openFile: (stopId: string, fileId: string) => void;
    readonly anchorReachable: (stopId: string, fileId: string, line: number) => boolean;
    readonly openAnchor: (stopId: string, fileId: string, line: number) => void;
}

/**
 * Make the jump target visible through the lens, collapsed stop, hidden
 * test code and collapsed gap. Jumps from selection links arrive here too: they find the line
 * and expand everything hiding it.
 */
export function useRouteReveal({
    model,
    fileIds,
    matches,
    session,
    store,
    stopProgress,
    setOtherOpen,
    openedCollapsed,
    setOpenedCollapsed,
    expand,
    requestJump,
    initialSelectionTarget,
    selectionNavigationRequest,
}: RouteRevealOptions): RouteReveal {
    /** Expand a stop regardless of why it collapsed: by hand, by tier or by a viewed mark. */
    const expandStop = useCallback(
        (stopId: string) => {
            session.setStopCollapsed(stopId, false);
            if (stopProgress.isViewed(stopId)) {
                session.setViewedStopExpanded(stopId, true);
            } else {
                session.setStopExpanded(stopId, true);
            }
        },
        [session, stopProgress],
    );

    /**
     * Prepare a route entry for a jump: lens, collapsed state and hidden test code. Check the filter
     * against the file itself, not the stop: a lens keeps a stop on screen
     * even when it hides the very file the jump points to.
     */
    const revealTarget = useCallback(
        (entry: RouteEntry, fileId: string | null) => {
            const hidden =
                fileId === null
                    ? !matches(entry, fileIds)
                    : fileIds !== null && !fileIds.has(fileId);
            if (hidden) {
                session.setFilter(ALL_FILTER_ID);
            }
            if (fileId !== null) {
                store.revealFile(fileId);
            }
            if (entry.kind === 'other') {
                setOtherOpen(true);
                return;
            }
            // Expand a collapsed stop first, then scroll to it (docs/design/SPEC-elements.md §2.11).
            expandStop(entry.view.stop.id);
            // A file hidden by the digest behind "Show test code" would otherwise be absent from the markup.
            if (fileId !== null && buildDigest(entry.view.stop)?.testFileIds.has(fileId) === true) {
                session.setStopTestCode(entry.view.stop.id, true);
            }
        },
        [expandStop, fileIds, matches, session, setOtherOpen, store],
    );

    const openFile = useCallback(
        (stopId: string, fileId: string) => {
            const entry = model.entries.find((candidate) => entryId(candidate) === stopId) ?? null;
            if (entry !== null) {
                revealTarget(entry, fileId);
            }
            requestJump(stopId, fileId);
        },
        [model.entries, requestJump, revealTarget],
    );

    const anchorReachable = useCallback(
        (stopId: string, fileId: string, line: number) =>
            resolveAnchor(model.entries, stopId, fileId, line) !== null,
        [model.entries],
    );

    /**
     * Jump to a digest assertion anchor (docs/design/README.md §2). An `uncovered` anchor points to code
     * that has no coverage, and another stop or "Other" explains that code:
     * jump to where the line actually renders, not where the click came from.
     */
    const openAnchor = useCallback(
        (stopId: string, fileId: string, line: number) => {
            const target = resolveAnchor(model.entries, stopId, fileId, line);
            const entry =
                target === null
                    ? null
                    : (model.entries.find((candidate) => entryId(candidate) === target.stopId) ?? null);
            if (target === null || entry === null) {
                return;
            }
            revealTarget(entry, fileId);
            requestJump(target.stopId, fileId, line, target.side);
        },
        [model.entries, requestJump, revealTarget],
    );
    const openedSelectionTarget = useRef<string | null>(null);
    useEffect(() => {
        if (initialSelectionTarget === null) {
            openedSelectionTarget.current = null;
            return;
        }
        const key = `${initialSelectionTarget.fileId}:${initialSelectionTarget.side}:${String(initialSelectionTarget.start)}:${String(selectionNavigationRequest)}`;
        if (openedSelectionTarget.current === key) {
            return;
        }
        let cancelled = false;
        const open = async (): Promise<void> => {
            let target = routeEntryForLine(
                model.entries,
                initialSelectionTarget.fileId,
                initialSelectionTarget.side,
                initialSelectionTarget.start,
            );
            if (target === null) {
                await expand(initialSelectionTarget.fileId, { kind: 'file' });
                if (cancelled) {
                    return;
                }
                target = routeEntryForShownLine(
                    model.entries,
                    initialSelectionTarget.fileId,
                    initialSelectionTarget.side,
                    initialSelectionTarget.start,
                    store.getSnapshot(),
                    openedCollapsed,
                );
            }
            if (target === null || cancelled) {
                return;
            }
            openedSelectionTarget.current = key;
            revealTarget(target.entry, initialSelectionTarget.fileId);
            if (target.collapsedAnchor) {
                setOpenedCollapsed((previous) =>
                    new Set(previous).add(collapsedKey(target.entry.view.stop.id, initialSelectionTarget.fileId)),
                );
            }
            store.openFile(initialSelectionTarget.fileId);
            store.showWhitespace(initialSelectionTarget.fileId);
            requestJump(
                target.entry.view.stop.id,
                initialSelectionTarget.fileId,
                initialSelectionTarget.start,
                initialSelectionTarget.side,
                false,
            );
        };
        void open();
        return () => {
            cancelled = true;
        };
    }, [
        expand,
        initialSelectionTarget,
        model.entries,
        openedCollapsed,
        requestJump,
        revealTarget,
        selectionNavigationRequest,
        setOpenedCollapsed,
        store,
    ]);

    return { expandStop, openFile, anchorReachable, openAnchor };
}
