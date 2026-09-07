import type { DiffFileModel } from '../../diff/model.js';
import type { FileExpansion } from '../../diff-view/expand.js';
import type { DiffViewSnapshot } from '../../diff-view/store.js';
import type { RouteEntry } from '../../route/route-model.js';
import { uncoveredAsGroup } from '../../route/route-model.js';
import { stopFileShownModel } from './stop-file-card.tsx';

/**
 * Route entry lookup by file line, and keys the route uses to distinguish card states:
 * the same file lives in several stops, so fileId alone is insufficient here.
 */

/** Empty gap expansion, shared across the route for memo dependency comparisons. */
export const EMPTY_EXPANSION: FileExpansion = new Map();

/** Route entry identifier. Stops and Other use their slot id. */
export function entryId(entry: RouteEntry): string {
    return entry.view.stop.id;
}

/** Key for manually expanding a collapsed card. The same file in different stops gets different keys. */
export function collapsedKey(stopId: string, fileId: string): string {
    return `${stopId}\u0000${fileId}`;
}

/** Expanded file gaps in the layout key determine how many lines the card holds. */
export function expansionKey(expansion: FileExpansion | undefined): string {
    if (expansion === undefined || expansion.size === 0) {
        return '';
    }
    return [...expansion]
        .map(([gap, value]) => `${gap}:${String(value.up)}:${String(value.down)}:${value.all ? 'a' : ''}`)
        .join(',');
}

export function routeEntryForShownLine(
    entries: readonly RouteEntry[],
    fileId: string,
    side: 'old' | 'new',
    line: number,
    snapshot: DiffViewSnapshot,
    openedCollapsed: ReadonlySet<string>,
): { readonly entry: RouteEntry; readonly collapsedAnchor: boolean } | null {
    for (const entry of entries) {
        const groups = entry.kind === 'stop' ? entry.view.files : entry.view.files.map((file) => uncoveredAsGroup(file));
        for (const group of groups) {
            if (group.fileId !== fileId) {
                continue;
            }
            const key = collapsedKey(entry.view.stop.id, fileId);
            const shown = stopFileShownModel(
                group,
                snapshot.models.get(fileId) ?? null,
                snapshot.content.get(fileId) ?? null,
                snapshot.expansion.get(fileId) ?? EMPTY_EXPANSION,
                openedCollapsed.has(key),
            );
            if (modelHasLine(shown, side, line)) {
                return { entry, collapsedAnchor: false };
            }
            if (entry.kind === 'stop' && !openedCollapsed.has(key) && group.collapsedAnchors.length > 0) {
                const opened = stopFileShownModel(
                    group,
                    snapshot.models.get(fileId) ?? null,
                    snapshot.content.get(fileId) ?? null,
                    snapshot.expansion.get(fileId) ?? EMPTY_EXPANSION,
                    true,
                );
                if (modelHasLine(opened, side, line)) {
                    return { entry, collapsedAnchor: true };
                }
            }
        }
    }
    return null;
}

function modelHasLine(model: DiffFileModel | null, side: 'old' | 'new', line: number): boolean {
    if (model?.content.kind !== 'text') {
        return false;
    }
    return model.content.blocks.some(
        (block) =>
            block.kind === 'hunk' &&
            block.lines.some((candidate) => (side === 'old' ? candidate.oldLine : candidate.newLine) === line),
    );
}

export function routeEntryForLine(
    entries: readonly RouteEntry[],
    fileId: string,
    side: 'old' | 'new',
    line: number,
): { readonly entry: RouteEntry; readonly collapsedAnchor: boolean } | null {
    for (const entry of entries) {
        const group = entry.view.files.find((file) => file.fileId === fileId);
        if (group === undefined) {
            continue;
        }
        if (group.anchors.some((anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end)) {
            return { entry, collapsedAnchor: false };
        }
        if (side === 'old' ? group.contextLines.old.has(line) : group.contextLines.new.has(line)) {
            return { entry, collapsedAnchor: false };
        }
        if (entry.kind === 'stop') {
            const stopGroup = entry.view.files.find((file) => file.fileId === fileId);
            if (
                stopGroup?.collapsedAnchors.some(
                    (anchor) => anchor.side === side && line >= anchor.start && line <= anchor.end,
                ) === true
            ) {
                return { entry, collapsedAnchor: true };
            }
        }
    }
    return null;
}
