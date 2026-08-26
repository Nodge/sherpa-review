import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel, DiffHunk, DiffLine } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { changedLinesOf } from '../progress/read-state.js';
import type { AnchorSpan } from './anchor-clip.js';
import {
    ANCHOR_CONTEXT,
    clipModelToAnchors,
    coveredChangedLines,
    spanLines,
    uncoveredRanges,
} from './anchor-clip.js';

/** Clipping by anchors must leave exactly the content the stop covers. */

const DATA = fixtureData('medium');
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
        expect(clipModelToAnchors(model, collapsed).changedLines).toBe(289);
    });

    it('merges uncovered ranges to cover the remaining changed lines', () => {
        const model = modelOf('services/orders/src/payments/generated/psp-schema.ts');
        const changed = changedLinesOf(model);
        const total = (changed?.old.size ?? 0) + (changed?.new.size ?? 0);
        const anchors: readonly AnchorSpan[] = [{ side: 'new', start: 3, end: 8 }];
        const covered = coveredChangedLines(model, anchors);
        const rest = uncoveredRanges(model, anchors);

        expect(spanLines(rest) + covered.additions + covered.deletions).toBe(total);
        // Ranges are sorted and do not touch. Adjacent line numbers have already been merged.
        for (const [index, span] of rest.entries()) {
            const previous = rest[index - 1];
            if (previous?.side === span.side) {
                expect(span.start).toBeGreaterThan(previous.end + 1);
            }
        }
    });

    it('returns non-text content unchanged because there is nothing to clip', () => {
        const binary = fixtureData('edge').diff.files.find((file) => file.binary);
        if (binary === undefined) {
            throw new Error('edge fixture must contain a binary file');
        }
        const model = parseFileDiff(toParseRequest(binary));
        const clipped = clipModelToAnchors(model, [{ side: 'new', start: 1, end: 10 }]);

        expect(clipped.model).toBe(model);
        expect(clipped.hunks).toBe(0);
    });
});
