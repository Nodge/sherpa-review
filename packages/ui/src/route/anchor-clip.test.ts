import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffGap, DiffHunk, DiffLine } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { FileExpansion } from '../diff-view/expand.js';
import {
    expandAllGaps,
    expandFileContext,
    expandGap,
    gapKeyOf,
    remainingHiddenLines,
} from '../diff-view/expand.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { AnchorSpan, ClippedModel } from './anchor-clip.js';
import {
    ANCHOR_CONTEXT,
    clipModelToAnchors,
    coveredChangedLines,
    coveredChangedRanges,
    droppedWhitespaceLines,
    spanLines,
    uncoveredRanges,
} from './anchor-clip.js';

/** Clipping by anchors must leave exactly the content the stop covers. */

const DATA = fixtureIteration('medium');
const READY = routeFixtures('medium')?.states.ready ?? null;

function fileOf(path: string): FileDiff {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`medium fixture has no file ${path}`);
    }
    return file;
}

function modelOf(path: string): DiffFileModel {
    return parseFileDiff(toParseRequest(fileOf(path)));
}

function hunks(model: DiffFileModel): DiffHunk[] {
    return model.content.kind === 'text'
        ? model.content.blocks.filter((block): block is DiffHunk => block.kind === 'hunk')
        : [];
}

function lines(model: DiffFileModel): DiffLine[] {
    return hunks(model).flatMap((hunk) => hunk.lines);
}

function gapsOf(clipped: ClippedModel): DiffGap[] {
    return clipped.model.content.kind === 'text'
        ? clipped.model.content.blocks.filter((block): block is DiffGap => block.kind === 'gap')
        : [];
}

/** Gaps at one edge of the slice. Only `edge` distinguishes edge gaps from internal ones. */
function gapsAt(clipped: ClippedModel, edge: DiffGap['edge']): DiffGap[] {
    return gapsOf(clipped).filter((gap) => gap.edge === edge);
}

const POLICY = 'services/orders/src/domain/policies/edit-policy.ts';
const WINDOW = 'services/orders/src/domain/edit-window.ts';

describe('clipping the model by anchors', () => {
    it('returns an empty slice for an empty anchor set, not the whole file', () => {
        const clipped = clipModelToAnchors(modelOf(WINDOW), []);

        expect(clipped.hunks).toBe(0);
        expect(clipped.changedLines).toBe(0);
        expect(lines(clipped.model)).toHaveLength(0);
    });

    it('keeps only anchor lines and their surrounding context', () => {
        const model = modelOf(POLICY);
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 30, end: 43 }];
        const clipped = clipModelToAnchors(model, anchors);

        const kept = lines(clipped.model);
        expect(kept.length).toBeGreaterThan(0);
        // The slice has no changed lines outside the anchor. Expansion only includes unchanged lines.
        for (const line of kept.filter((candidate) => candidate.kind !== 'context')) {
            expect(line.newLine ?? 0).toBeGreaterThanOrEqual(30);
            expect(line.newLine ?? 0).toBeLessThanOrEqual(43);
        }
        expect(kept.filter((line) => line.kind === 'context').length).toBeLessThanOrEqual(2 * ANCHOR_CONTEXT);
        // Changed lines in the slice are exactly the lines within the anchor.
        expect(clipped.changedLines).toBe(
            coveredChangedLines(model, anchors).additions + coveredChangedLines(model, anchors).deletions,
        );
    });

    it('counts both sides, taking deleted lines for an old-side anchor', () => {
        const model = modelOf(POLICY);
        const old: readonly AnchorSpan[] = [{ side: 'old', start: 28, end: 34 }];
        const clipped = clipModelToAnchors(model, old);
        const deletions = lines(clipped.model).filter(
            (line) => line.kind === 'del' && (line.oldLine ?? 0) >= 28 && (line.oldLine ?? 0) <= 34,
        );

        expect(deletions.length).toBeGreaterThan(0);
        expect(clipped.changedLines).toBe(deletions.length);
        expect(coveredChangedLines(model, old).additions).toBe(0);
    });

    it('includes both range boundaries', () => {
        const model = modelOf(POLICY);
        const changed = changedLinesOf(model);
        const first = [...(changed?.new ?? [])].sort((a, b) => a - b)[0] ?? 0;

        expect(clipModelToAnchors(model, [{ side: 'new', start: first, end: first }]).changedLines).toBe(1);
        expect(clipModelToAnchors(model, [{ side: 'new', start: first + 1, end: first }]).changedLines).toBe(0);
    });

    it('creates a gap with accurate counts between chunks', () => {
        const model = modelOf(WINDOW);
        const changed = [...(changedLinesOf(model)?.new ?? [])].sort((a, b) => a - b);
        const first = changed[0] ?? 1;
        const last = changed.at(-1) ?? 1;
        const clipped = clipModelToAnchors(model, [
            { side: 'new', start: first, end: first },
            { side: 'new', start: last, end: last },
        ]);

        const gaps =
            clipped.model.content.kind === 'text'
                ? clipped.model.content.blocks.filter((block) => block.kind === 'gap')
                : [];
        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.kind === 'gap' ? (gaps[0].hiddenChanged ?? 0) : 0).toBeGreaterThan(0);
        expect(clipped.changedLines).toBe(2);
    });

    it('keeps file edges as gaps instead of silently dropping the start and end', () => {
        // Matches a real README with a single hunk in the middle of the file and an additions-only anchor.
        const fileLines = Array.from({ length: 17 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = {
            oldText: fileLines.slice(0, 12).join('\n'),
            newText: fileLines.join('\n'),
        };
        const model = parseFileDiff({
            fileId: 'route-edges',
            path: 'README.md',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: [
                '@@ -10,3 +10,8 @@',
                ' line-10',
                ' line-11',
                ' line-12',
                '+line-13',
                '+line-14',
                '+line-15',
                '+line-16',
                '+line-17',
                '',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 13, end: 17 }];
        const clipped = clipModelToAnchors(model, anchors);

        expect(gapsAt(clipped, 'leading')[0]).toMatchObject({ hiddenLines: 9 });
        // The patch cannot give the file tail length. Content supplies it, as in Full diff.
        expect(gapsAt(clipped, 'trailing')[0]).toMatchObject({ hiddenLines: null });
        expect(remainingHiddenLines(clipped.model, content)).toBe(9);

        // "Expand file" uses the original model and expands the whole file, leaving no edges.
        const expansion = expandAllGaps(model, new Map());
        const whole = clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);
        expect(lines(whole.model)).toHaveLength(17);
        expect(remainingHiddenLines(whole.model, content)).toBe(0);
    });

    it('expands only the selected slice gap and preserves its key', () => {
        const context = Array.from({ length: 17 }, (_, index) => ` line-${String(index + 3)}`);
        const model = parseFileDiff({
            fileId: 'route-gap',
            path: 'src/route-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,20 +1,20 @@', ' line-1', '-old-2', '+new-2', ...context, '-old-20', '+new-20'].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [
            { side: 'new', start: 2, end: 2 },
            { side: 'new', start: 20, end: 20 },
        ];
        const initial = clipModelToAnchors(model, anchors);
        const gap = gapsAt(initial, 'inner')[0];
        if (gap === undefined) {
            throw new Error('slice has no gap');
        }
        const key = gapKeyOf(gap);
        const expansion = expandGap(new Map(), key, 'up', 2);
        const expanded = clipModelToAnchors(model, anchors, ANCHOR_CONTEXT, expansion);
        const nextGap = gapsAt(expanded, 'inner')[0];

        expect(lines(expanded.model).filter((line) => line.kind === 'context')).toHaveLength(
            lines(initial.model).filter((line) => line.kind === 'context').length + 2,
        );
        expect(nextGap?.sourceKey).toBe(key);
        expect(nextGap?.hiddenChanged).toBe(gap.hiddenChanged);
    });

    it('expansion skips changed lines from other stops at the gap boundary', () => {
        const context = Array.from({ length: 25 }, (_, index) => ` line-${String(index + 8)}`);
        const model = parseFileDiff({
            fileId: 'route-foreign',
            path: 'src/route-foreign.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            // Another stop's change follows the anchor context. Unchanged lines follow that change.
            patch: [
                '@@ -1,32 +1,32 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                ' line-6',
                '-old-7',
                '+new-7',
                ...context,
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 3 }];
        const initial = clipModelToAnchors(model, anchors);
        const gap = gapsAt(initial, 'trailing')[0];
        if (gap === undefined) {
            throw new Error('slice has no trailing gap');
        }
        const key = gapKeyOf(gap);
        expect(gap.hiddenChanged).toBe(2);

        const expanded = clipModelToAnchors(model, anchors, ANCHOR_CONTEXT, expandGap(new Map(), key, 'down', 20));
        const revealed = lines(expanded.model).filter((line) => line.kind === 'context');

        expect(revealed.length).toBe(lines(initial.model).filter((line) => line.kind === 'context').length + 20);
        // The other stop's change stays hidden as its own gap. The chunks share expansion.
        for (const line of lines(expanded.model)) {
            expect(line.kind === 'context' || (line.newLine ?? 0) === 3).toBe(true);
        }
        expect(gapsOf(expanded).map((block) => gapKeyOf(block))).toContain(key);
        expect(gapsOf(expanded).filter((block) => (block.hiddenChanged ?? 0) > 0)).toHaveLength(2);
    });

    it('a hunk tail made only of changes from other stops gives its target to the merged model gap', () => {
        const fileLines = Array.from({ length: 60 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: fileLines.join('\n'), newText: fileLines.join('\n') };
        const model = parseFileDiff({
            fileId: 'route-merged-gap',
            path: 'src/route-merged-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            // After the anchor context, the hunk ends with another stop's additions, followed by a model gap.
            patch: [
                '@@ -1,6 +1,9 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                ' line-6',
                '+new-7',
                '+new-8',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 3 }];
        const show = (expansion: FileExpansion): ClippedModel =>
            clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);

        const initial = show(new Map());
        const tail = gapsAt(initial, 'trailing')[0];
        if (tail === undefined) {
            throw new Error('slice has no trailing gap');
        }
        // The slice itself has nothing to expand. The real model gap got the key, so the target works.
        expect(tail.hiddenChanged).toBe(2);
        expect(gapKeyOf(tail).startsWith('clip:')).toBe(false);

        const expanded = show(expandGap(new Map(), gapKeyOf(tail), 'down'));
        expect(lines(expanded.model).length).toBe(lines(initial.model).length + 20);
    });

    it('keeps expanded context from the original gap visible and preserves its key until it disappears', () => {
        const contentLines = Array.from({ length: 60 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: contentLines.join('\n'), newText: contentLines.join('\n') };
        const model = parseFileDiff({
            fileId: 'route-source-gap',
            path: 'src/route-source-gap.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: [
                '@@ -1,5 +1,5 @@',
                ' line-1',
                ' line-2',
                '-old-3',
                '+new-3',
                ' line-4',
                ' line-5',
                '@@ -50,5 +50,5 @@',
                ' line-50',
                ' line-51',
                '-old-52',
                '+new-52',
                ' line-53',
                ' line-54',
            ].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [
            { side: 'new', start: 3, end: 3 },
            { side: 'new', start: 52, end: 52 },
        ];
        const sourceGap =
            model.content.kind === 'text'
                ? model.content.blocks.find((block): block is DiffGap => block.kind === 'gap' && block.edge === 'inner')
                : undefined;
        if (sourceGap === undefined) {
            throw new Error('original model has no internal gap');
        }
        const key = gapKeyOf(sourceGap);
        const show = (expansion: ReturnType<typeof expandGap>) =>
            clipModelToAnchors(expandFileContext(model, content, expansion), anchors, ANCHOR_CONTEXT, expansion);
        const visibleNewLines = (clipped: ClippedModel): number =>
            new Set(lines(clipped.model).flatMap((line) => (line.newLine === null ? [] : [line.newLine]))).size;

        const initial = show(new Map());
        const onceExpansion = expandGap(new Map(), key, 'up');
        const once = show(onceExpansion);
        const twiceExpansion = expandGap(onceExpansion, key, 'up');
        const twice = show(twiceExpansion);

        expect(visibleNewLines(once)).toBe(visibleNewLines(initial) + 20);
        expect(gapsAt(once, 'inner')[0]?.sourceKey).toBe(key);
        expect(gapsAt(twice, 'inner')[0]?.sourceKey).toBe(key);

        const fullyExpanded = show(expandGap(twiceExpansion, key, 'up'));
        expect(visibleNewLines(fullyExpanded)).toBe(visibleNewLines(initial) + 46);
        expect(gapsAt(fullyExpanded, 'inner')[0]).toMatchObject({
            sourceKey: key,
            hiddenLines: 0,
            hiddenChanged: 1,
        });

        const allExpansion = expandAllGaps(model, new Map());
        const all = show(allExpansion);
        expect(visibleNewLines(all)).toBe(60);
        expect(remainingHiddenLines(all.model, content)).toBe(0);
    });

    it('counts collapsed anchors separately from displayed anchors', () => {
        const snapshot = READY?.snapshot;
        if (snapshot == null) {
            throw new Error('medium fixture needs a ready route snapshot');
        }
        const lock = snapshot.stops.find((stop) => stop.id === 's06');
        const model = modelOf('pnpm-lock.yaml');
        const collapsed = (lock?.anchors ?? []).map(({ side, start, end }) => ({ side, start, end }));

        expect(collapsed).toHaveLength(2);
        expect(clipModelToAnchors(model, []).changedLines).toBe(0);
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        expect(clipModelToAnchors(model, collapsed).changedLines).toBe(total);
    });

    it('merges uncovered ranges to cover the remaining changed lines', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 8 }];
        const covered = coveredChangedLines(model, anchors);
        const rest = uncoveredRanges(model, anchors);

        // Whitespace lines outside anchors are excluded from the statistics. They account for the difference from `total`.
        const dropped = droppedWhitespaceLines(model, anchors);
        expect(dropped).toBe(2);
        expect(spanLines(rest) + covered.additions + covered.deletions).toBe(total - dropped);
        // Ranges are sorted and do not touch. Adjacent line numbers have already been merged.
        for (const [index, span] of rest.entries()) {
            const previous = rest[index - 1];
            if (previous?.side === span.side) {
                expect(span.start).toBeGreaterThan(previous.end + 1);
            }
        }
    });

    it('excludes whitespace lines outside anchors from uncovered ranges and counts those inside', () => {
        // alpha=old1/new1. Empty add=new2 and beta=new3 are inside an anchor. Whitespace add=new5 and
        // deletion of a single tab at old3 are outside anchors. delta=new6 is the only uncovered line.
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,4 +1,7 @@', ' alpha', '+', '+beta', ' gamma', '+  ', '+delta', '-\t', ' omega', ''].join('\n'),
        });
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 2, end: 3 }];
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        const covered = coveredChangedLines(model, anchors);

        expect(total).toBe(5);
        expect(uncoveredRanges(model, anchors)).toEqual([{ side: 'new', start: 6, end: 6 }]);
        expect(droppedWhitespaceLines(model, anchors)).toBe(2);
        // The anchor explains an empty line just like a text line. The rule applies only outside anchors.
        expect(covered).toEqual({ additions: 2, deletions: 0 });
        expect(coveredChangedRanges(model, anchors)).toEqual([{ side: 'new', start: 2, end: 3 }]);
        expect(spanLines(uncoveredRanges(model, anchors)) + covered.additions + covered.deletions).toBe(
            total - droppedWhitespaceLines(model, anchors),
        );
    });

    it('counts whitespace lines in slice gaps because the whitespace rule applies to statistics, not slices', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,6 @@', ' alpha', '+one', '+', '+two', '+three', ' omega', ''].join('\n'),
        });
        // The slice contains new lines 2 and 5. Empty new line 3 and text new line 4 remain between them.
        const gaps = gapsAt(
            clipModelToAnchors(model, [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 5, end: 5 },
            ]),
            'inner',
        );

        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.hiddenChanged).toBe(2);
        expect(gaps[0]?.hiddenLines).toBe(0);
    });

    it('creates a gap even for one whitespace line between chunks instead of silently merging them', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,5 @@', ' alpha', '+one', '+', '+two', ' omega', ''].join('\n'),
        });
        const gaps = gapsAt(
            clipModelToAnchors(model, [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 4, end: 4 },
            ]),
            'inner',
        );

        expect(gaps).toHaveLength(1);
        expect(gaps[0]?.hiddenChanged).toBe(1);
    });

    it('excludes whitespace lines from uncovered ranges when there are no anchors', () => {
        const model = parseFileDiff({
            fileId: 'f',
            path: 'src/a.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,4 @@', ' alpha', '+', '+   ', ' omega', ''].join('\n'),
        });

        expect(uncoveredRanges(model, [])).toEqual([]);
        expect(droppedWhitespaceLines(model, [])).toBe(2);
    });

    it('returns non-text content unchanged because there is nothing to clip', () => {
        const binary = fixtureIteration('edge').diff.files.find((file) => file.binary);
        if (binary === undefined) {
            throw new Error('edge fixture must contain a binary file');
        }
        const model = parseFileDiff(toParseRequest(binary));
        const clipped = clipModelToAnchors(model, [{ side: 'new', start: 1, end: 10 }]);

        expect(clipped.model).toBe(model);
        expect(clipped.hunks).toBe(0);
    });
});
