import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, RouteStop } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { anchorLabel, buildDigest, buildDigestTestCode, claimLabel, resolveAnchor } from './digest.js';
import { buildRouteModel, stopSeenRanges } from './route-model.js';

/**
 * Test digest on the `medium` fixture (M2-T2): stop s04 has 12 accepted assertions and 2
 * rejected by the validator. Counts come from data, not hardcoded test values. A digest that disagrees
 * with its fixture misrepresents the test contract.
 */

const DATA = fixtureData('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();

function stop(id: string): RouteStop {
    const found = SNAPSHOT.stops.find((candidate) => candidate.id === id);
    if (found === undefined) {
        throw new Error(`fixture snapshot has no stop ${id}`);
    }
    return found;
}

function routeModel(snapshot: RouteSnapshot = SNAPSHOT) {
    const models = new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))]));
    return buildRouteModel({ snapshot, files: DATA.diff.files, models });
}

/** Moves anchors of regular s04 assertions to other entries without changing the stop anchors. */
function digestTargets(...targetStopIds: readonly string[]): RouteSnapshot {
    const targets = targetStopIds.map((stopId) => {
        const anchor = SNAPSHOT.stops.find((candidate) => candidate.id === stopId)?.anchors[0];
        if (anchor === undefined) {
            throw new Error(`stop ${stopId} needs an anchor for the digest test`);
        }
        return { fileId: anchor.fileId, path: anchor.path, line: anchor.start };
    });
    let targetIndex = 0;
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((candidate) =>
            candidate.id !== 's04'
                ? candidate
                : {
                      ...candidate,
                      tests: candidate.tests.map((claim) => {
                          if (claim.kind === 'uncovered') {
                              return claim;
                          }
                          const anchor = targets[targetIndex % targets.length];
                          targetIndex += 1;
                          return { ...claim, anchor: anchor ?? null };
                      }),
                  },
        ),
    };
}

function digestWithNonTestFile(): RouteSnapshot {
    const anchor = SNAPSHOT.stops.find((candidate) => candidate.id === 's01')?.anchors[0];
    if (anchor === undefined) {
        throw new Error('stop s01 needs an anchor in a non-test file');
    }
    return {
        ...SNAPSHOT,
        stops: SNAPSHOT.stops.map((candidate) =>
            candidate.id === 's04' ? { ...candidate, anchors: [...candidate.anchors, anchor] } : candidate,
        ),
    };
}

function digestTestCode(snapshot: RouteSnapshot) {
    const model = routeModel(snapshot);
    const entry = model.entries.find((candidate) => candidate.kind === 'stop' && candidate.view.stop.id === 's04');
    if (entry?.kind !== 'stop') {
        throw new Error('route model has no digest stop s04');
    }
    const digest = buildDigest(entry.view.stop);
    if (digest === null) {
        throw new Error('stop s04 must have a digest');
    }
    return buildDigestTestCode(
        digest,
        model.entries,
        entry.view.stop.id,
        entry.view.files.map((file) => file.fileId),
    );
}

function anchorLocation(testCode: ReturnType<typeof buildDigestTestCode>) {
    if (testCode.location?.kind !== 'anchor') {
        throw new Error('expected a link to another route entry');
    }
    return testCode.location;
}

describe('behavioural digest', () => {
    it('a regular stop has no digest', () => {
        expect(buildDigest(stop('s01'))).toBeNull();
    });

    it('stop s04 has 12 assertions, with 10 list rows, 2 footer rows and 2 rejected', () => {
        const digest = buildDigest(stop('s04'));

        expect(digest?.total).toBe(12);
        expect(digest?.rows).toHaveLength(10);
        expect(digest?.footer).toHaveLength(2);
        expect(digest?.dropped).toBe(2);
    });

    it('counts categories from model data: 6 new, 2 changed, 2 weakened, 2 uncovered', () => {
        const digest = buildDigest(stop('s04'));
        const kinds = [...(digest?.rows ?? []), ...(digest?.footer ?? [])].map((claim) => claim.kind);

        expect(kinds.filter((kind) => kind === 'new')).toHaveLength(6);
        expect(kinds.filter((kind) => kind === 'changed')).toHaveLength(2);
        expect(kinds.filter((kind) => kind === 'weakened')).toHaveLength(2);
        expect(kinds.filter((kind) => kind === 'uncovered')).toHaveLength(2);
    });

    it('keeps model row order and only moves uncovered to the bottom', () => {
        const digest = buildDigest(stop('s04'));
        const model = stop('s04').tests;

        expect(digest?.rows.map((claim) => claim.text)).toEqual(
            model.filter((claim) => claim.kind !== 'uncovered').map((claim) => claim.text),
        );
        expect(digest?.footer.map((claim) => claim.text)).toEqual(
            model.filter((claim) => claim.kind === 'uncovered').map((claim) => claim.text),
        );
    });

    it('treats only assertion anchor files as test code, excluding uncovered code', () => {
        const digest = buildDigest(stop('s04'));
        const paths = [...(digest?.testFileIds ?? [])].map(
            (fileId) => DATA.diff.files.find((file) => file.fileId === fileId)?.path ?? '',
        );

        expect(paths.every((path) => path.includes('__tests__'))).toBe(true);
        expect(paths).toHaveLength(3);
        // An uncovered anchor points to uncovered code, which must not be hidden as test code.
        const uncovered = digest?.footer.find((claim) => claim.anchor !== null)?.anchor ?? null;
        expect(uncovered?.path).toBe('services/orders/src/domain/edit-window.ts');
        expect(digest?.testFileIds.has(uncovered?.fileId ?? '')).toBe(false);
    });

    it('hides no files for an empty intersection and links to the first entry with test code', () => {
        const testCode = digestTestCode(digestTargets('s01'));
        const location = anchorLocation(testCode);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(location.label).toBe('test code — in stop 01');
        expect(location.target.stopId).toBe('s01');
    });

    it('reports when the lens hides test files in the same stop without linking to itself', () => {
        const snapshot = digestWithNonTestFile();
        const model = routeModel(snapshot);
        const entry = model.entries.find(
            (candidate) => candidate.kind === 'stop' && candidate.view.stop.id === 's04',
        );
        if (entry?.kind !== 'stop') {
            throw new Error('route model has no digest stop s04');
        }
        const digest = buildDigest(entry.view.stop);
        if (digest === null) {
            throw new Error('stop s04 must have a digest');
        }
        const visibleFileIds = entry.view.files
            .filter((file) => !digest.testFileIds.has(file.fileId))
            .map((file) => file.fileId);
        expect(visibleFileIds.length).toBeGreaterThan(0);

        const testCode = buildDigestTestCode(digest, model.entries, entry.view.stop.id, visibleFileIds);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(testCode.location?.kind).toBe('hidden-by-lens');
        expect(testCode.location?.label).toBe('test code hidden by the lens');
        expect(testCode.location?.anchor.fileId).not.toBe(visibleFileIds[0]);
        expect(testCode.location).not.toHaveProperty('target');
    });

    it('has nothing to hide or link to when all assertions are uncovered', () => {
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((candidate) =>
                candidate.id === 's04'
                    ? {
                          ...candidate,
                          tests: candidate.tests.map((claim) => ({ ...claim, kind: 'uncovered' as const })),
                      }
                    : candidate,
            ),
        };
        const testCode = digestTestCode(snapshot);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(testCode.location).toBeNull();
    });

    it('links to the first resolvable target across entries with an accurate shared label', () => {
        const testCode = digestTestCode(digestTargets('s01', 's02'));
        const location = anchorLocation(testCode);

        expect(testCode.hiddenFileIds.size).toBe(0);
        expect(location.label).toBe('test code — in other stops');
        expect(location.target.stopId).toBe('s01');
    });

    it('uses the accurate Other label when that is the only target', () => {
        const file = DATA.diff.files.find((candidate) => candidate.path.endsWith('generated/psp-schema.ts'));
        if (file === undefined) {
            throw new Error('medium fixture needs generated/psp-schema.ts');
        }
        const snapshot: RouteSnapshot = {
            ...SNAPSHOT,
            stops: SNAPSHOT.stops.map((candidate) =>
                candidate.id !== 's04'
                    ? candidate
                    : {
                          ...candidate,
                          tests: candidate.tests.map((claim) =>
                              claim.kind === 'uncovered'
                                  ? claim
                                  : { ...claim, anchor: { fileId: file.fileId, path: file.path, line: 70 } },
                          ),
                      },
            ),
        };
        const testCode = digestTestCode(snapshot);
        const location = anchorLocation(testCode);

        expect(location.label).toBe('test code — in “Other”');
        expect(location.target.stopId).toBe('other');
    });

    it('shows the link as a filename and line while keeping the path in the model', () => {
        const anchor = buildDigest(stop('s04'))?.rows[0]?.anchor ?? null;

        expect(anchor?.path).toBe('services/orders/src/domain/__tests__/edit-window.test.ts');
        expect(anchorLabel(anchor ?? { fileId: '', path: '', name: '', line: 0 })).toBe('edit-window.test.ts:10');
    });

    it('does not invent an anchor when an assertion has none', () => {
        const digest = buildDigest(stop('s04'));

        expect(digest?.footer.filter((claim) => claim.anchor === null)).toHaveLength(1);
    });

    it('chip labels are English, one per category', () => {
        expect([claimLabel('new'), claimLabel('changed'), claimLabel('weakened'), claimLabel('uncovered')]).toEqual([
            'new',
            'changed',
            'weakened',
            'uncovered',
        ]);
    });
});

describe('following an assertion anchor', () => {
    it('links a test file in the same stop to that stop and restores the side from the slice', () => {
        const entries = routeModel().entries;
        const anchor = buildDigest(stop('s04'))?.rows[0]?.anchor ?? null;

        expect(resolveAnchor(entries, 's04', anchor?.fileId ?? '', anchor?.line ?? 0)).toEqual({
            stopId: 's04',
            side: 'new',
        });
    });

    it('links an uncovered anchor to the stop that explains the code', () => {
        const entries = routeModel().entries;
        const anchor = buildDigest(stop('s04'))?.footer.find((claim) => claim.anchor !== null)?.anchor ?? null;

        // Stop 01 explains `edit-window.ts`, so the jump goes there instead of staying in s04.
        expect(resolveAnchor(entries, 's04', anchor?.fileId ?? '', anchor?.line ?? 0)).toEqual({
            stopId: 's01',
            side: 'new',
        });
    });

    it('chooses the target by line, not just by file', () => {
        const entries = routeModel().entries;
        // `psp-schema.ts` is split between s03 (file header) and "Other" (uncovered tail),
        // a normal result of clipping by anchors. s03 comes first and has the file, but its
        // card has no line 70. The jump must go to "Other", where that line is rendered.
        const owners = entries.filter((entry) =>
            entry.view.files.some((file) => file.path.endsWith('generated/psp-schema.ts')),
        );
        expect(owners.map((entry) => entry.view.stop.id)).toEqual(['s03', 'other']);

        const fileId = owners[0]?.view.files.find((file) => file.path.endsWith('psp-schema.ts'))?.fileId ?? '';
        expect(resolveAnchor(entries, 's04', fileId, 70)).toEqual({ stopId: 'other', side: 'new' });
        // Both render line 3, s03 on the new side and "Other" on the old side. Both
        // the earlier entry and the new side take precedence.
        expect(resolveAnchor(entries, 's04', fileId, 3)).toEqual({ stopId: 's03', side: 'new' });
    });

    it('targets the file card with an unknown side when no slice contains the line', () => {
        const entries = routeModel().entries;
        const fileId = entries[0]?.view.files[0]?.fileId ?? '';

        expect(resolveAnchor(entries, 's04', fileId, 100_000)).toEqual({
            stopId: entries[0]?.view.stop.id,
            side: null,
        });
    });

    it('disables the link without crashing the view when the file is absent from the route', () => {
        expect(resolveAnchor(routeModel().entries, 's04', 'no-such-file', 1)).toBeNull();
    });
});

describe('digest and the viewed mark', () => {
    it('counts mark ranges from stop anchors, including all test code', () => {
        const entry = routeModel().entries.find((candidate) => candidate.view.stop.id === 's04') ?? null;
        if (entry === null) {
            throw new Error('route model has no stop s04');
        }
        const ranges = stopSeenRanges(entry);
        const paths = new Set(
            ranges.map((range) => DATA.diff.files.find((file) => file.fileId === range.fileId)?.path ?? ''),
        );

        // The Show/Hide toggle does not affect this count. The route model knows nothing about the session,
        // and marking a digest stop correctly marks its test files (M2-T9 decision).
        expect(paths.size).toBe(3);
        expect([...paths].every((path) => path.includes('__tests__'))).toBe(true);
        expect(ranges.length).toBeGreaterThan(0);
    });
});
