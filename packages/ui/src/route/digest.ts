import type { RouteStop, RouteTestClaim, RouteTestClaimKind } from '@sherpa/protocol';

import type { MessageKey, Translate } from '../i18n/index.js';
import type { AnchorSpan } from './anchor-clip.js';
import { anchorSpans } from './anchor-clip.js';
import type { ContextLines, RouteEntry } from './route-model.js';

/**
 * Behavioural test digest (README §2, brief §6): a stop replaces line-by-line reading of
 * test code, with the test code itself hidden behind Show test code.
 *
 * This pure module takes a snapshot stop and returns what to render and which stop files
 * count as test code. No React or diff. The view and tests use the same input.
 *
 * Row layout rule: assertions keep their model order without sorting. Only
 * `uncovered` moves to the bottom as the footer row "changed behaviour without an assertion"
 * (the inverse digest), not another category in the main list.
 */

export interface DigestAnchorView {
    readonly fileId: string;
    readonly path: string;
    /** Filename without its path. The link displays as `edit-window.test.ts:41`. */
    readonly name: string;
    readonly line: number;
}

export interface DigestClaimView {
    readonly kind: RouteTestClaimKind;
    readonly text: string;
    /** `null` means no anchor. `uncovered` may have none by design (`route.ts` contract). */
    readonly anchor: DigestAnchorView | null;
}

export interface DigestModel {
    /** Total assertions, the header denominator, calculated from data instead of hardcoded. */
    readonly total: number;
    /** List rows in model order, excluding `uncovered`. */
    readonly rows: readonly DigestClaimView[];
    /** Footer rows for changed behaviour left without an assertion. */
    readonly footer: readonly DigestClaimView[];
    /** Number of assertions discarded by the validator (SPEC §4.3). */
    readonly dropped: number;
    /**
     * Assertion anchor files are candidates for hiding. The digest only hides their
     * intersection with its own stop files after the current lens (`buildDigestTestCode`).
     * `uncovered` is excluded because its anchor points to uncovered code, not a test.
     */
    readonly testFileIds: ReadonlySet<string>;
}

/** `null` means a regular stop with no assertions. */
export function buildDigest(stop: RouteStop): DigestModel | null {
    if (stop.tests.length === 0) {
        return null;
    }

    const rows: DigestClaimView[] = [];
    const footer: DigestClaimView[] = [];
    const testFileIds = new Set<string>();
    for (const claim of stop.tests) {
        const view = claimView(claim);
        if (claim.kind === 'uncovered') {
            footer.push(view);
            continue;
        }
        rows.push(view);
        if (view.anchor !== null) {
            testFileIds.add(view.anchor.fileId);
        }
    }

    return { total: stop.tests.length, rows, footer, dropped: stop.droppedClaims, testFileIds };
}

export interface DigestAnchorTarget {
    readonly stopId: string;
    /**
     * Gutter side on which the line is rendered in this entry's slice. `null` means the file
     * is in the route but the line is absent from its slices, so the jump only reaches the card.
     */
    readonly side: 'old' | 'new' | null;
}

export type DigestTestCodeLocation =
    | {
          readonly kind: 'anchor';
          readonly label: string;
          /** First resolvable anchor. The view resolves it again against the current route before jumping. */
          readonly anchor: DigestAnchorView;
          readonly target: DigestAnchorTarget;
      }
    | {
          readonly kind: 'hidden-by-lens';
          readonly label: string;
          /** First anchor in the same stop. Following it resets the lens and expands test code. */
          readonly anchor: DigestAnchorView;
      };

export interface DigestTestCodeModel {
    /** Files in the current stop that the toggle can actually hide. */
    readonly hiddenFileIds: ReadonlySet<string>;
    /** What to show instead of the toggle when its intersection with stop files is empty. */
    readonly location: DigestTestCodeLocation | null;
}

/**
 * Digest test code behaviour after applying the lens: what is actually hidden and where to link when there is
 * nothing to hide. Only regular assertions supply the link. `uncovered` explains its own footer.
 */
export function buildDigestTestCode(
    digest: DigestModel,
    entries: readonly RouteEntry[],
    fromStopId: string,
    stopFileIds: readonly string[],
    t: Translate,
): DigestTestCodeModel {
    const hiddenFileIds = new Set(stopFileIds.filter((fileId) => digest.testFileIds.has(fileId)));
    if (hiddenFileIds.size > 0) {
        return { hiddenFileIds, location: null };
    }

    const otherEntries = entries.filter((entry) => entry.view.stop.id !== fromStopId);
    const resolved = digest.rows.flatMap((claim) => {
        if (claim.anchor === null) {
            return [];
        }
        const target = resolveAnchor(otherEntries, fromStopId, claim.anchor.fileId, claim.anchor.line);
        return target === null ? [] : [{ anchor: claim.anchor, target }];
    });
    const first = resolved[0];
    if (first === undefined) {
        const ownEntry = entries.find((entry) => entry.view.stop.id === fromStopId);
        const ownFileIds = new Set(ownEntry?.view.files.map((file) => file.fileId) ?? []);
        const anchor = digest.rows.find((claim) =>
            claim.anchor === null ? false : ownFileIds.has(claim.anchor.fileId),
        )?.anchor;
        return {
            hiddenFileIds,
            location:
                anchor === undefined || anchor === null
                    ? null
                    : { kind: 'hidden-by-lens', label: t('digest.testCode.hiddenByLens'), anchor },
        };
    }

    const targetIds = new Set(resolved.map(({ target }) => target.stopId));
    const targetEntry = entries.find((entry) => entry.view.stop.id === first.target.stopId);
    if (targetEntry === undefined) {
        return { hiddenFileIds, location: null };
    }
    const label =
        targetIds.size > 1
            ? t('digest.testCode.elsewhere')
            : targetEntry.kind === 'other'
              ? t('digest.testCode.inOther')
              : t('digest.testCode.inStop', targetEntry.view.planLabel);

    return {
        hiddenFileIds,
        location: { kind: 'anchor', label, anchor: first.anchor, target: first.target },
    };
}

/**
 * Assertion anchor destination. Selection uses the line, not just the file. The route usually splits a single
 * file into ranges across several stops, so an entry without the required
 * line is not a target. Preference order: the same stop containing the line (digest test code belongs to
 * its files) → any entry containing the line in render order (an `uncovered` anchor points to uncovered
 * code explained by another stop or "Other") → an entry that at least renders the file.
 *
 * An assertion anchor has no side (`route.ts` contract), so the slice supplies it.
 * The new side takes precedence over the old because it holds added and retained tests. The old side is for
 * deleted tests. `null` means the file is entirely absent from the route. The link is then disabled, so the view does not imply
 * a jump is possible.
 */
export function resolveAnchor(
    entries: readonly RouteEntry[],
    fromStopId: string,
    fileId: string,
    line: number,
): DigestAnchorTarget | null {
    let onLine: DigestAnchorTarget | null = null;
    let ownFile: DigestAnchorTarget | null = null;
    let anyFile: DigestAnchorTarget | null = null;
    for (const entry of entries) {
        const drawn = drawnFile(entry, fileId);
        if (drawn === null) {
            continue;
        }
        const stopId = entry.view.stop.id;
        const side = sideOf(drawn, line);
        if (side !== null) {
            if (stopId === fromStopId) {
                return { stopId, side };
            }
            onLine ??= { stopId, side };
            continue;
        }
        if (stopId === fromStopId) {
            ownFile ??= { stopId, side: null };
        } else {
            anyFile ??= { stopId, side: null };
        }
    }
    return onLine ?? ownFile ?? anyFile;
}

/** What a route entry renders for this file: anchor ranges and surrounding unchanged lines. */
interface DrawnFile {
    readonly spans: readonly AnchorSpan[];
    readonly context: ContextLines;
}

/**
 * Collapsed anchors (`collapsedAnchors`) are excluded. The card renders them as a summary row,
 * with no actual lines in the markup to jump to.
 */
function drawnFile(entry: RouteEntry, fileId: string): DrawnFile | null {
    if (entry.kind === 'stop') {
        const group = entry.view.files.find((candidate) => candidate.fileId === fileId);
        return group === undefined
            ? null
            : { spans: anchorSpans(group.anchors), context: group.contextLines };
    }
    const file = entry.view.files.find((candidate) => candidate.fileId === fileId);
    return file === undefined ? null : { spans: file.anchors, context: file.contextLines };
}

function sideOf(drawn: DrawnFile, line: number): 'old' | 'new' | null {
    for (const side of ['new', 'old'] as const) {
        const inSpan = drawn.spans.some(
            (span) => span.side === side && line >= span.start && line <= span.end,
        );
        if (inSpan || drawn.context[side].has(line)) {
            return side;
        }
    }
    return null;
}

/** Category chip label key. Semantics follow README §2. */
export function claimLabel(kind: RouteTestClaimKind): MessageKey {
    switch (kind) {
        case 'new':
            return 'digest.kind.new';
        case 'changed':
            return 'digest.kind.changed';
        case 'weakened':
            return 'digest.kind.weakened';
        default:
            return 'digest.kind.uncovered';
    }
}

/** Link to a test line: `edit-window.test.ts:41` (README §2, 11px mono). */
export function anchorLabel(anchor: DigestAnchorView): string {
    return `${anchor.name}:${String(anchor.line)}`;
}

function claimView(claim: RouteTestClaim): DigestClaimView {
    const anchor = claim.anchor;
    return {
        kind: claim.kind,
        text: claim.text,
        anchor:
            anchor === null
                ? null
                : { fileId: anchor.fileId, path: anchor.path, name: baseName(anchor.path), line: anchor.line },
    };
}

function baseName(path: string): string {
    return path.slice(path.lastIndexOf('/') + 1);
}
