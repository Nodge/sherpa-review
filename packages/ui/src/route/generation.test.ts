import { routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiRouteState, UiTask } from '@sherpa/protocol';
import { describe, expect, it } from 'vitest';

import { createT, ru } from '../i18n/index.js';
import {
    generationCardKind,
    generationIsLong,
    generationProgress,
    LONG_GENERATION_MS,
    openRouteTasks,
    provenanceLine,
    routeActionErrorInPlace,
    routeGenerationAvailable,
    routeViewKind,
    snapshotLocale,
} from './generation.js';
import { snapshotFilling } from './other-stop.js';

/** Generation state model. Phase selection and "N of M" counts all come from fixture data. */

function state(phase: 'none' | 'reading' | 'filling' | 'ready' | 'failed'): UiRouteState {
    const fixture = routeFixtures('medium')?.states[phase] ?? null;
    if (fixture === null) {
        throw new Error(`medium fixture needs state ${phase}`);
    }
    return fixture;
}

function snapshotOf(phase: 'filling' | 'ready'): RouteSnapshot {
    const snapshot = state(phase).snapshot;
    if (snapshot === null) {
        throw new Error(`state ${phase} needs a snapshot`);
    }
    return snapshot;
}

function rebuildState(phase: 'reading' | 'failed'): UiRouteState {
    return {
        ...state(phase),
        snapshot: snapshotOf('ready'),
    };
}

function task(overrides: Partial<UiTask> & Pick<UiTask, 'id'>): UiTask {
    return {
        type: 'route.skeleton',
        priority: 'background',
        status: 'queued',
        heldByWorker: overrides.status === 'leased',
        attempt: 1,
        instructions: 'build the skeleton',
        progressText: null,
        result: null,
        failReason: null,
        createdAt: '2026-08-24T12:00:00.000Z',
        updatedAt: '2026-08-24T12:00:00.000Z',
        ...overrides,
    };
}

describe('Route tab phase selection', () => {
    it('renders ready and partially filled routes in the same view', () => {
        expect(routeViewKind(state('ready'))).toBe('workspace');
        expect(routeViewKind(state('filling'))).toBe('workspace');
    });

    it('keeps a working route from the old snapshot during a rebuild and after its failure', () => {
        expect(routeViewKind(rebuildState('reading'))).toBe('workspace');
        expect(routeViewKind(rebuildState('failed'))).toBe('workspace');
    });

    it('shows separate screens for reading and failure without a snapshot, a small PR and the invitation', () => {
        expect(routeViewKind(state('reading'))).toBe('reading');
        expect(routeViewKind(state('failed'))).toBe('failed');
        expect(routeViewKind(routeFixtures('small')?.states.none ?? null)).toBe('small-pr');
        expect(routeViewKind(state('none'))).toBe('invitation');
        expect(routeViewKind(null)).toBe('invitation');
    });

    it('falls back to the invitation instead of an empty screen when a phase has no data', () => {
        expect(routeViewKind({ phase: 'ready', smallPr: false, snapshot: null, failure: null, stale: null })).toBe('invitation');
        expect(routeViewKind({ phase: 'failed', smallPr: false, snapshot: null, failure: null, stale: null })).toBe('invitation');
    });
});

describe('generation card in the Overview rail', () => {
    it('shows content during reading, filling, ready and failed phases and nothing otherwise', () => {
        expect(generationCardKind(state('reading'))).toBe('reading');
        expect(generationCardKind(state('filling'))).toBe('filling');
        expect(generationCardKind(state('ready'))).toBe('ready');
        expect(generationCardKind(state('failed'))).toBe('failed');
        expect(generationCardKind(state('none'))).toBeNull();
        expect(generationCardKind(null)).toBeNull();
    });
});

describe('route generation availability', () => {
    it('disables the palette, banner and card consistently during generation and for a small PR', () => {
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'failed', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'none', smallPr: false, generating: false })).toBe(true);
        expect(routeGenerationAvailable({ phase: 'reading', smallPr: false, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'filling', smallPr: false, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: false, generating: true })).toBe(false);
        expect(routeGenerationAvailable({ phase: 'ready', smallPr: true, generating: false })).toBe(false);
        expect(routeGenerationAvailable({ phase: null, smallPr: false, generating: false })).toBe(false);
    });
});

describe('where to show generation endpoint errors', () => {
    it('shows errors next to the triggering action in the red route card and Overview generation card', () => {
        expect(routeActionErrorInPlace('route', state('failed'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('failed'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('reading'))).toBe(true);
        expect(routeActionErrorInPlace('overview', state('filling'))).toBe(true);
    });

    it('uses the banner slot for Build the route from the palette in phase none because no reason field is available', () => {
        expect(routeActionErrorInPlace('route', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('overview', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('diff', state('none'))).toBe(false);
        expect(routeActionErrorInPlace('diff', state('failed'))).toBe(false);
        expect(routeActionErrorInPlace('route', state('reading'))).toBe(false);
        expect(routeActionErrorInPlace('route', rebuildState('failed'))).toBe(false);
        // The ready route has no error row in its card.
        expect(routeActionErrorInPlace('overview', state('ready'))).toBe(false);
    });
});

describe('route filling progress', () => {
    it('takes counts from fixture slot statuses instead of the design handoff image', () => {
        const progress = generationProgress(snapshotOf('filling'));

        // An unfinished route has no "Other". s01, s02 and s05 are filled, which is 3 out of 6.
        expect(progress.total).toBe(6);
        expect(progress.ready).toBe(3);
        expect(progress.slots.map((slot) => slot.status)).toEqual([
            'ready',
            'ready',
            'queued',
            'queued',
            'ready',
            'filling',
        ]);
        expect(progress.slots.map((slot) => slot.planLabel)).toEqual(['01', '02', '03', '04', '05', '06']);
    });

    it('no longer considers a ready snapshot to be filling', () => {
        expect(snapshotFilling(snapshotOf('ready'))).toBe(false);
        expect(snapshotFilling(snapshotOf('filling'))).toBe(true);
    });

    it('includes Other in the plan of a ready route only when it has something to show', () => {
        expect(generationProgress(snapshotOf('ready')).total).toBe(6);
        expect(generationProgress(snapshotOf('ready'), { uncovered: 0, conflictFiles: 0 }).total).toBe(6);
        const withOther = generationProgress(snapshotOf('ready'), { uncovered: 38, conflictFiles: 0 });
        expect(withOther.total).toBe(7);
        expect(withOther.ready).toBe(7);
        expect(withOther.slots.at(-1)?.planLabel).toBe('07');
    });
});

describe('long generation', () => {
    it('considers only queued and leased route tasks open', () => {
        const tasks = [
            task({ id: 1, status: 'queued' }),
            task({ id: 2, status: 'leased', type: 'route.section' }),
            task({ id: 3, status: 'done' }),
            task({ id: 4, status: 'queued', type: 'echo', priority: 'interactive' }),
            // The worker is still running the cancelled section, but generation is no longer active or blocked.
            task({ id: 5, status: 'cancelled', type: 'route.section', heldByWorker: true }),
        ];

        expect(openRouteTasks(tasks).map((item) => item.id)).toEqual([1, 2]);
    });

    it('uses a threshold of one minute from enqueueing the oldest open task', () => {
        const created = Date.parse('2026-08-24T12:00:00.000Z');
        const tasks = [task({ id: 1 })];

        expect(generationIsLong(tasks, created + LONG_GENERATION_MS - 1)).toBe(false);
        expect(generationIsLong(tasks, created + LONG_GENERATION_MS)).toBe(true);
        expect(generationIsLong([task({ id: 1, status: 'done' })], created + 600_000)).toBe(false);
    });
});

describe('summary and provenance', () => {
    it('provenance contains the harness, model and short commit', () => {
        expect(provenanceLine(snapshotOf('ready'), createT('en'), 'en')).toBe(
            `claude-code · claude-opus-5 · ${snapshotOf('ready').commit.slice(0, 7)}`,
        );
    });

    it('leaves no dangling separators for empty provenance', () => {
        const snapshot = { ...snapshotOf('ready'), provenance: { harness: null, model: null, locale: null } };

        expect(provenanceLine(snapshot, createT('en'), 'en')).toBe(snapshot.commit.slice(0, 7));
    });

    it('adds the route language only when it differs from the tab language', () => {
        const ready = snapshotOf('ready');
        const english = { ...ready, provenance: { ...ready.provenance, locale: 'en' as const } };

        // A snapshot with no recorded language (`locale: null`) is read as English.
        expect(provenanceLine(ready, createT('ru'), 'ru')).toBe(provenanceLine(english, createT('ru'), 'ru'));
        expect(provenanceLine(ready, createT('en'), 'en')).not.toContain('English');
        expect(provenanceLine(english, createT('ru'), 'ru')).toContain(ru['route.locale.name.en']);
        expect(provenanceLine(english, createT('en'), 'en')).not.toContain('English');
    });

    it('treats null snapshot locale as English', () => {
        expect(snapshotLocale({ harness: null, model: null, locale: null })).toBe('en');
        expect(snapshotLocale({ harness: null, model: null, locale: 'ru' })).toBe('ru');
    });
});
