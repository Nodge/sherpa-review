import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { RouteMarginFile } from './margin-model.js';
import {
    buildRouteMargin,
    marginBadgeLabel,
    marginBadgeShown,
    marginBadgeTitle,
    marginFooterNote,
    marginStripSummary,
    marginStripText,
    marginTargetStopId,
    treeBadgeLabel,
} from './margin-model.js';

/**
 * Route margins count the same totals as the route view: 34 uncovered lines in 3 files
 * of the `medium` fixture (CODEOWNERS 5, ci.yml 12, psp-schema.ts tail 17). If the counts diverge,
 * this test catches it before anyone has to spot it in a screenshot.
 */

const DATA = fixtureData('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();

const MODELS = new Map<string, DiffFileModel>(
    DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]),
);

function build(snapshot: RouteSnapshot = SNAPSHOT, models = MODELS) {
    return buildRouteMargin({ snapshot, files: DATA.diff.files, models });
}

function fileOf(path: string): RouteMarginFile {
    const file = DATA.diff.files.find((candidate) => candidate.path === path);
    if (file === undefined) {
        throw new Error(`fixture has no file ${path}`);
    }
    const margin = build().files.get(file.fileId);
    if (margin === undefined) {
        throw new Error(`margin model has no file ${path}`);
    }
    return margin;
}

describe('route in full diff margins', () => {
    it('uncovered totals match the route: 34 lines in 3 files', () => {
        const model = build();

        expect(model.uncoveredLines).toBe(34);
        expect(model.uncoveredFiles).toBe(3);
        expect(model.pendingFiles).toBe(0);
        expect(model.failedFiles).toBe(0);

        const uncovered = DATA.diff.files
            .map((file) => ({ name: file.path, lines: model.files.get(file.fileId)?.uncoveredLines ?? 0 }))
            .filter((entry) => entry.lines > 0)
            .map((entry) => [entry.name.slice(entry.name.lastIndexOf('/') + 1), entry.lines]);

        expect(uncovered).toEqual([
            ['psp-schema.ts', 17],
            ['CODEOWNERS', 5],
            ['ci.yml', 12],
        ]);
    });

    it('builds the file→stops map from anchors in plan order', () => {
        const model = build();
        const placed = [...model.files.values()].filter((file) => file.stops.length > 0);

        expect(placed.length).toBeGreaterThan(0);
        for (const file of placed) {
            const numbers = file.stops.map((stop) => stop.planLabel);
            expect(numbers).toEqual([...numbers].sort((left, right) => left.localeCompare(right)));
            // A stop appears once, regardless of how many anchors it has in the file.
            expect(new Set(numbers).size).toBe(numbers.length);
        }
    });

    it('excludes Other from the map because its lines are not placed', () => {
        const model = build();
        const other = SNAPSHOT.stops.find((stop) => stop.tier === 'other');

        expect(other?.id).toBe(model.otherStopId);
        expect(model.otherStopId).not.toBeNull();
        for (const file of model.files.values()) {
            expect(file.stops.some((stop) => stop.stopId === model.otherStopId)).toBe(false);
        }
    });

    it('explains a file without anchors in Other and links its badge there', () => {
        const model = build();
        const yaml = fileOf('.github/CODEOWNERS');

        expect(yaml.stops).toEqual([]);
        expect(yaml.changed).toBe(true);
        expect(marginBadgeShown(yaml)).toBe(true);
        expect(treeBadgeLabel(yaml)).toBe('outside the route');
        expect(marginBadgeLabel(yaml)).toBe('no route stop');
        expect(marginTargetStopId(yaml, model.otherStopId)).toBe(model.otherStopId);
        expect(marginBadgeTitle(yaml, true)).toBe('No route stop — go to "Other"');
    });

    it('gives a partially covered file its stop badge and uncovered ranges', () => {
        const schema = fileOf('services/orders/src/payments/generated/psp-schema.ts');

        expect(schema.stops.length).toBeGreaterThan(0);
        expect(schema.uncoveredLines).toBe(17);
        expect(marginBadgeLabel(schema)).toContain(`explained in ${schema.stops[0]?.planLabel ?? ''} · `);
    });

    it('a file in several stops gets the first badge plus "+N", with all numbers in the tooltip', () => {
        const many: RouteMarginFile = {
            fileId: 'f1',
            stops: [
                { stopId: 's02', planLabel: '02', title: 'cache resets after a write' },
                { stopId: 's05', planLabel: '05', title: 'logs' },
            ],
            uncovered: [],
            uncoveredLines: 0,
            parsed: true,
            changed: true,
        };

        expect(treeBadgeLabel(many)).toBe('02 +1');
        expect(marginBadgeLabel(many)).toBe('explained in 02 +1 · cache resets after a write');
        expect(marginBadgeTitle(many, true)).toBe(
            'Explained in stops 02, 05 · cache resets after a write — go there',
        );
        expect(marginTargetStopId(many, 'other')).toBe('s02');
    });

    it('gives no badge to a file without changed lines', () => {
        const empty: RouteMarginFile = {
            fileId: 'f2',
            stops: [],
            uncovered: [],
            uncoveredLines: 0,
            parsed: true,
            changed: false,
        };

        expect(marginBadgeShown(empty)).toBe(false);
    });

    it('counts lines and files in the footer note and says it is counting until parsing finishes', () => {
        expect(marginFooterNote(build())).toBe(
            'The hatch means the range has no route stop. 34 lines in 3 files.',
        );

        const pending = build(SNAPSHOT, new Map());
        expect(pending.pendingFiles).toBe(DATA.diff.files.length);
        expect(marginFooterNote(pending)).toBe('The hatch means the range has no route stop. Counting the lines…');
    });

    it('hides the note when nothing is uncovered and reports unparsed files', () => {
        const covered = buildRouteMargin({ snapshot: SNAPSHOT, files: [], models: new Map() });
        expect(marginFooterNote(covered)).toBeNull();

        const failedId = DATA.diff.files[0]?.fileId ?? '';
        const failed = buildRouteMargin({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: MODELS,
            failed: new Set([failedId]),
        });
        expect(failed.failedFiles).toBe(0);

        const unparsed = new Map(MODELS);
        unparsed.delete(failedId);
        const broken = buildRouteMargin({
            snapshot: SNAPSHOT,
            files: DATA.diff.files,
            models: unparsed,
            failed: new Set([failedId]),
        });
        expect(broken.pendingFiles).toBe(0);
        expect(broken.failedFiles).toBe(1);
        expect(marginFooterNote(broken)).toContain('1 file failed to parse — their lines are not counted.');
    });

    it('distinguishes diff sides and a single line in hatch labels', () => {
        expect(marginStripText({ side: 'new', start: 18, end: 26 })).toBe('lines 18–26 without a route stop');
        expect(marginStripText({ side: 'new', start: 18, end: 18 })).toBe('line 18 without a route stop');
        expect(marginStripText({ side: 'old', start: 4, end: 9 })).toBe(
            'removed lines 4–9 have no route stop',
        );
        // Line numbers match the gutter, without digit grouping.
        expect(marginStripText({ side: 'new', start: 1234, end: 1240 })).toBe(
            'lines 1234–1240 have no route stop',
        );
        expect(
            marginStripSummary([
                { side: 'new', start: 18, end: 26 },
                { side: 'old', start: 4, end: 4 },
            ]),
        ).toBe('10 lines have no route stop');
    });
});
