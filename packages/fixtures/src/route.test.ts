import type { RouteSnapshot, RouteStop, RouteTier } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { buildRouteFixtures, fixtureData, routeFixtures } from './data/index.js';

/**
 * Checks route fixtures against the diff, not themselves: coverage is recalculated
 * from patches (`+`/`−` hunk lines) and compared with handoff numbers. Shifting any anchor
 * by one line fails either the "anchor covers changed lines only" check or the uncovered line count.
 */

const HUNK_HEADER = /^@@ -(\d+),\d+ \+(\d+),\d+ @@/;

/** Target coverage bar shares from README §1 (862 lines: 188 / 348 / 292 + 34 unplaced). */
const TIER_TARGETS: Record<'high' | 'medium' | 'low', number> = { high: 188, medium: 348, low: 292 };
const TIER_TOLERANCE = 25;
const UNEXPLAINED_LINES = 34;
const UNEXPLAINED_FILES = 3;

interface ChangedFile {
    fileId: string;
    /** Changed line numbers by side: added lines belong to `new`, removed lines to `old`. */
    old: Set<number>;
    new: Set<number>;
}

/** Changed diff lines: the same definition as SPEC §2.4 coverage math (added + removed). */
function changedLines(name: 'medium'): Map<string, ChangedFile> {
    const files = new Map<string, ChangedFile>();
    for (const file of fixtureData(name).diff.files) {
        if (file.patch === null) {
            continue;
        }
        const changed: ChangedFile = { fileId: file.fileId, old: new Set(), new: new Set() };
        let oldLine = 0;
        let newLine = 0;
        let inHunk = false;
        for (const line of file.patch.split('\n')) {
            const header = HUNK_HEADER.exec(line);
            if (header !== null) {
                oldLine = Number(header[1]);
                newLine = Number(header[2]);
                inHunk = true;
                continue;
            }
            if (!inHunk) {
                continue;
            }
            const prefix = line.slice(0, 1);
            if (prefix === '+') {
                changed.new.add(newLine);
                newLine += 1;
            } else if (prefix === '-') {
                changed.old.add(oldLine);
                oldLine += 1;
            } else if (prefix === ' ') {
                oldLine += 1;
                newLine += 1;
            }
        }
        files.set(file.path, changed);
    }
    return files;
}

function totalChangedLines(files: Map<string, ChangedFile>): number {
    let total = 0;
    for (const file of files.values()) {
        total += file.old.size + file.new.size;
    }
    return total;
}

/** Diff file paths: the validator drops assertion anchors pointing outside this set. */
function diffPaths(): Set<string> {
    return new Set(fixtureData('medium').diff.files.map((file) => file.path));
}

function mediumSnapshot(): RouteSnapshot {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot;
    if (snapshot === undefined || snapshot === null) {
        throw new Error('medium fixture has no ready route snapshot');
    }
    return snapshot;
}

function stopById(snapshot: RouteSnapshot, id: string): RouteStop {
    const stop = snapshot.stops.find((candidate) => candidate.id === id);
    if (stop === undefined) {
        throw new Error(`snapshot has no stop ${id}`);
    }
    return stop;
}

/**
 * Coverage by tier: a line belongs to the tier of the first stop that claims it
 * (`stops` array order is triage). The fixture has no duplicate anchors, but counting must match
 * the validator, or the test will disagree with the UI on the first duplicate.
 */
function coverageByTier(snapshot: RouteSnapshot, files: Map<string, ChangedFile>) {
    const owner = new Map<string, RouteTier>();
    for (const stop of snapshot.stops) {
        for (const anchor of stop.anchors) {
            const file = files.get(anchor.path);
            expect(file, `anchor of stop ${stop.id} points outside the diff: ${anchor.path}`).toBeDefined();
            expect(anchor.fileId).toBe(file?.fileId);
            expect(anchor.end).toBeGreaterThanOrEqual(anchor.start);

            const changed = anchor.side === 'old' ? file?.old : file?.new;
            for (let line = anchor.start; line <= anchor.end; line += 1) {
                expect(
                    changed?.has(line),
                    `anchor of stop ${stop.id} covers an unchanged line ${anchor.path}:${anchor.side}:${String(line)}`,
                ).toBe(true);
                const key = `${anchor.path}:${anchor.side}:${String(line)}`;
                if (!owner.has(key)) {
                    owner.set(key, stop.tier);
                }
            }
        }
    }

    const byTier: Record<string, number> = { high: 0, medium: 0, low: 0, other: 0 };
    for (const tier of owner.values()) {
        byTier[tier] = (byTier[tier] ?? 0) + 1;
    }

    const unexplainedFiles = new Set<string>();
    let unexplained = 0;
    for (const [path, file] of files) {
        for (const side of ['old', 'new'] as const) {
            for (const line of file[side]) {
                if (!owner.has(`${path}:${side}:${String(line)}`)) {
                    unexplained += 1;
                    unexplainedFiles.add(path);
                }
            }
        }
    }

    return { byTier, unexplained, unexplainedFiles };
}

describe('medium fixture route', () => {
    const files = changedLines('medium');
    const snapshot = mediumSnapshot();
    const coverage = coverageByTier(snapshot, files);

    it('counts the same changed lines as the PR header', () => {
        expect(totalChangedLines(files)).toBe(862);
    });

    it('leaves exactly 34 lines in exactly 3 files unexplained', () => {
        expect(coverage.unexplained).toBe(UNEXPLAINED_LINES);
        expect([...coverage.unexplainedFiles].sort()).toEqual([
            '.github/CODEOWNERS',
            '.github/workflows/ci.yml',
            'services/orders/src/payments/generated/psp-schema.ts',
        ]);
        expect(coverage.unexplainedFiles.size).toBe(UNEXPLAINED_FILES);
    });

    it('preserves the coverage bar proportions by tier', () => {
        for (const [tier, target] of Object.entries(TIER_TARGETS)) {
            expect(Math.abs((coverage.byTier[tier] ?? 0) - target)).toBeLessThanOrEqual(TIER_TOLERANCE);
        }
        // "Other" covers nothing: the UI derives its contents from uncovered ranges.
        expect(coverage.byTier.other).toBe(0);
        const explained = Object.values(coverage.byTier).reduce((sum, lines) => sum + lines, 0);
        expect(explained + coverage.unexplained).toBe(totalChangedLines(files));
    });

    it('has 7 planned stops with synthetic "Other" last', () => {
        expect(snapshot.stops.length).toBe(7);
        expect(snapshot.stops.map((stop) => stop.planIndex)).toEqual([1, 2, 3, 4, 5, 6, 7]);
        expect(snapshot.stops.map((stop) => stop.tier)).toEqual([
            'high',
            'high',
            'medium',
            'medium',
            'low',
            'low',
            'other',
        ]);

        const other = stopById(snapshot, 'other');
        expect(other.planIndex).toBe(7);
        expect(other.status).toBe('ready');
        expect(other.anchors).toEqual([]);
        expect(other.paragraph).toBeNull();
    });

    it('has tourOrder as a permutation of all stop ids, with "Other" last', () => {
        expect([...snapshot.tourOrder].sort()).toEqual([...snapshot.stops.map((stop) => stop.id)].sort());
        expect(snapshot.tourOrder.at(-1)).toBe('other');
        // A meaningful permutation that differs from plan order.
        expect(snapshot.tourOrder).not.toEqual(snapshot.stops.map((stop) => stop.id));
    });

    it('has all stops ready, with contentHash and provenance on the snapshot', () => {
        for (const stop of snapshot.stops) {
            expect(stop.status).toBe('ready');
            expect(stop.provenance).toBeNull();
        }
        expect(snapshot.contentHash).toMatch(/^[0-9a-f]{16}$/);
        expect(snapshot.provenance).toEqual({ harness: 'claude-code', model: 'claude-opus-5' });
        expect(snapshot.commit).toBe(fixtureData('medium').diff.headCommit);
        expect(snapshot.diffId).toBe(fixtureData('medium').diff.diffId);
        expect(snapshot.summary.split('\n\n').length).toBeGreaterThanOrEqual(2);
    });

    it('places collapsed anchors on generated lockfile lines', () => {
        const collapsed = snapshot.stops.flatMap((stop) => stop.anchors.filter((anchor) => anchor.collapsed));
        expect(collapsed.length).toBeGreaterThanOrEqual(1);
        expect(collapsed.length).toBeLessThanOrEqual(2);
        for (const anchor of collapsed) {
            expect(anchor.path).toBe('pnpm-lock.yaml');
        }
    });

    it('has 12 digest assertions anchored to test files in the diff', () => {
        const digest = stopById(snapshot, 's04');
        expect(digest.tests.length).toBe(12);
        expect(digest.droppedClaims).toBe(2);
        // The validator note names the file that caused assertions to be dropped.
        expect(digest.validationNotes.join(' ')).toContain('services/orders/src/domain/__tests__/factories.ts');
        expect(digest.tests.filter((claim) => claim.kind === 'weakened').length).toBeGreaterThanOrEqual(1);
        expect(digest.tests.filter((claim) => claim.kind === 'uncovered').length).toBeGreaterThanOrEqual(1);

        for (const claim of digest.tests) {
            if (claim.anchor === null) {
                // Only `uncovered` lacks an anchor: such an assertion has no test anchor.
                expect(claim.kind).toBe('uncovered');
                continue;
            }
            const file = files.get(claim.anchor.path);
            expect(file, `assertion points outside the diff: ${claim.anchor.path}`).toBeDefined();
            expect(claim.anchor.fileId).toBe(file?.fileId);
            expect(file?.new.has(claim.anchor.line)).toBe(true);
            if (claim.kind !== 'uncovered') {
                expect(claim.anchor.path).toMatch(/__tests__\/.+\.test\.ts$/);
            }
        }
    });

    it('has no digest on the other stops', () => {
        for (const stop of snapshot.stops) {
            if (stop.id === 's04') {
                continue;
            }
            expect(stop.tests).toEqual([]);
            expect(stop.droppedClaims).toBe(0);
        }
    });

    it('stop text is filled using the formula', () => {
        for (const stop of snapshot.stops) {
            expect(stop.title).toMatch(/\p{L}/u);
            if (stop.id === 'other') {
                continue;
            }
            expect(stop.paragraph ?? '').toMatch(/\p{L}/u);
            expect((stop.paragraph ?? '').split(/(?<=\.)\s/).length).toBeGreaterThanOrEqual(2);
        }
    });
});

describe('intermediate route states', () => {
    it('filling matches README §7: 01, 02 and 05 are ready, indicators are out of order', () => {
        const filling = routeFixtures('medium')?.states.filling;
        const snapshot = filling?.snapshot;
        expect(filling?.phase).toBe('filling');
        expect(snapshot?.contentHash).toBeNull();

        const statuses = new Map((snapshot?.stops ?? []).map((stop) => [stop.id, stop.status]));
        expect(Object.fromEntries(statuses)).toEqual({
            s01: 'ready',
            s02: 'ready',
            s03: 'queued',
            s04: 'queued',
            s05: 'ready',
            s06: 'filling',
            other: 'ready',
        });

        for (const stop of snapshot?.stops ?? []) {
            expect(stop.title.length).toBeGreaterThan(0);
            if (stop.status !== 'ready') {
                expect(stop.paragraph).toBeNull();
                expect(stop.anchors).toEqual([]);
            }
        }

        const ready = (snapshot?.stops ?? []).filter((stop) => stop.status === 'ready' && stop.id !== 'other');
        expect(ready.length).toBe(3);
    });

    it('has no snapshot in the reading, none and failed phases', () => {
        const states = routeFixtures('medium')?.states;
        expect(states?.reading?.snapshot).toBeNull();
        expect(states?.none?.snapshot).toBeNull();
        expect(states?.failed?.snapshot).toBeNull();
        expect(states?.failed?.failure?.message).toMatch(/^Generation stopped at validation:/);
        expect(states?.failed?.failure?.message.split('. ').length).toBe(1);
        // Raw output is parseable JSON: "Open raw output" shows what the model returned.
        expect(() => {
            JSON.parse(states?.failed?.failure?.rawOutput ?? '');
        }).not.toThrow();
    });

    it('marks a small PR as smallPr, with separate states for large and edge', () => {
        expect(routeFixtures('small')?.states.none).toEqual({
            phase: 'none',
            smallPr: true,
            snapshot: null,
            failure: null,
        });
        expect(routeFixtures('large')?.states.none?.smallPr).toBe(false);
        expect(routeFixtures('edge')?.states.failed?.failure?.rawOutput).toContain('infra/clock.ts');
    });
});

describe('raw model outputs', () => {
    const raw = routeFixtures('medium')?.rawResults;

    it('has 6 skeleton stops without "Other", with tourOrder as a permutation of 1..6', () => {
        expect(raw?.skeleton.stops.length).toBe(6);
        for (const stop of raw?.skeleton.stops ?? []) {
            expect(['high', 'medium', 'low']).toContain(stop.tier);
        }
        expect([...(raw?.skeleton.tourOrder ?? [])].sort()).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('covers the entire plan in sections and matches all snapshot contents', () => {
        const snapshot = mediumSnapshot();
        const paths = diffPaths();
        expect(raw?.sections.length).toBe(6);

        for (const section of raw?.sections ?? []) {
            expect(section.stops.length).toBe(1);
            const [rawStop] = section.stops;
            const stop = snapshot.stops.find((candidate) => candidate.planIndex === rawStop?.planIndex);
            expect(stop).toBeDefined();
            expect(rawStop?.paragraph).toBe(stop?.paragraph);
            expect(rawStop?.bridge ?? null).toBe(stop?.bridge ?? null);

            // Compare the whole anchor: a shifted `end` or missing collapse directive would make
            // the section differ from the snapshot, which the M2-T3 validator builds from that section.
            expect(
                rawStop?.anchors.map(
                    (anchor) =>
                        `${anchor.path}:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}:${String(anchor.collapsed ?? false)}`,
                ),
            ).toEqual(
                stop?.anchors.map(
                    (anchor) =>
                        `${anchor.path}:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}:${String(anchor.collapsed)}`,
                ),
            );
            // Model anchors use paths: the validator resolves `fileId`.
            for (const anchor of rawStop?.anchors ?? []) {
                expect(anchor).not.toHaveProperty('fileId');
            }

            // Digest: the model returns everything, the snapshot holds accepted claims, and the difference is exactly `droppedClaims`.
            const rawTests = rawStop?.tests ?? [];
            expect(rawTests.length).toBe((stop?.tests.length ?? 0) + (stop?.droppedClaims ?? 0));
            const accepted = rawTests.filter((claim) => claim.testPath === undefined || paths.has(claim.testPath));
            expect(
                accepted.map(
                    (claim) => `${claim.kind}|${claim.text}|${claim.testPath ?? ''}:${String(claim.testLine ?? 0)}`,
                ),
            ).toEqual(
                stop?.tests.map(
                    (claim) =>
                        `${claim.kind}|${claim.text}|${claim.anchor?.path ?? ''}:${String(claim.anchor?.line ?? 0)}`,
                ),
            );
        }
    });

    it('has two assertions in section 04 digest that the validator will drop', () => {
        const digestSection = raw?.sections.find((section) => section.stops[0]?.planIndex === 4);
        const rawTests = digestSection?.stops[0]?.tests ?? [];
        expect(rawTests.length).toBe(14);

        const paths = diffPaths();
        const dropped = rawTests.filter((claim) => claim.testPath !== undefined && !paths.has(claim.testPath));
        expect(dropped.map((claim) => claim.testPath)).toEqual([
            'services/orders/src/domain/__tests__/factories.ts',
            'services/orders/src/domain/__tests__/factories.ts',
        ]);
        // The "2 claims dropped" counter comes from model output, not a value manually set in the snapshot.
        expect(stopById(mediumSnapshot(), 's04').droppedClaims).toBe(dropped.length);
    });

    it('fails invalid outputs on semantics, not schema', () => {
        const broken = raw?.broken;
        expect(broken?.sectionUnknownFile.stops[0]?.anchors[0]?.path).toBe(
            'services/orders/src/domain/order-state.ts',
        );
        expect(fixtureData('medium').diff.files.some((file) => file.path.endsWith('order-state.ts'))).toBe(false);

        const outside = broken?.sectionRangeOutsideChanges.stops[0]?.anchors[0];
        const readme = changedLines('medium').get('services/orders/README.md');
        expect(outside?.path).toBe('services/orders/README.md');
        expect(readme?.new.has(outside?.start ?? 0)).toBe(false);

        const tour = broken?.skeletonTourOrderNotPermutation.tourOrder ?? [];
        expect(new Set(tour).size).toBeLessThan(tour.length);
    });
});

describe('route fixtures: delivery', () => {
    for (const name of ['medium', 'small', 'large', 'edge'] as const) {
        it(`${name}: is deterministic and returns a copy`, () => {
            // Two builds from scratch: comparing two cache accesses would pass even with `Date.now()` inside.
            expect(JSON.stringify(buildRouteFixtures(name))).toBe(JSON.stringify(buildRouteFixtures(name)));

            const first = routeFixtures(name);
            const second = routeFixtures(name);
            expect(first).not.toBe(second);
            expect(JSON.stringify(first)).toBe(JSON.stringify(second));
        });
    }
});
