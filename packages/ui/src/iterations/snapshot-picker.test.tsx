// @vitest-environment jsdom
import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';

import { rowText, SnapshotPill, SnapshotsCard } from './snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from './viewing.js';
import { pickerRows, VIEWING_CURRENT } from './viewing.js';

/**
 * Slices in the picker: Shift+click and Shift+⏎ on a timeline row, both endpoints marked,
 * a hint at the bottom of the menu, and the same Shift+click in the Overview "Snapshots" card.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OLD_COMMIT = '9f3c1ab6d4e2705c8a1b3f9d6e4c2a08b7d5f316';
const GONE_COMMIT = 'b0d3f77a1c8e4562d0a9b8c7f6e5d4c3b2a10088';
const NEW_COMMIT = 'a71d4e2c9b8f5301d6e4a2c7b09f8e3d5a4c6b21';
const NOW = Date.parse('2026-08-31T12:00:00.000Z');

const SNAPSHOT: UiSnapshotSummary = {
    snapshotId: 'route-new',
    diffId: '182801',
    commit: NEW_COMMIT,
    baseCommit: 'base',
    createdAt: '2026-08-31T09:30:00.000Z',
    provenance: { harness: 'claude-code', model: 'sonnet-5', locale: null },
    previousSnapshotId: null,
    status: 'current',
};

function iteration(patch: Partial<Iteration>): Iteration {
    return {
        diffId: '182801',
        baseCommit: 'base',
        headCommit: NEW_COMMIT,
        createdAt: '2026-08-31T09:00:00.000Z',
        status: 'active',
        ...patch,
    };
}

const ITERATIONS: readonly Iteration[] = [
    iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'gone' }),
    iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
    iteration({}),
];

const LABEL: ViewingLabel = { kind: 'snapshot', commit: NEW_COMMIT, status: 'current' };
const SLICE_LABEL: ViewingLabel = {
    kind: 'slice',
    commit: NEW_COMMIT,
    baseCommit: OLD_COMMIT,
    status: 'slice',
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const cleanup of mounted.splice(0)) {
        cleanup();
    }
});

interface Rendered {
    readonly host: HTMLElement;
    readonly chosen: Viewing[];
}

function render(options: {
    readonly interdiff?: boolean;
    readonly snapshots?: readonly UiSnapshotSummary[];
    readonly iterations?: readonly Iteration[];
    readonly viewing?: Viewing;
    readonly label?: ViewingLabel;
}): Rendered {
    const rows = pickerRows({
        snapshots: options.snapshots ?? [SNAPSHOT],
        iterations: options.iterations ?? ITERATIONS,
        activeIteration: { diffId: '182801', commit: NEW_COMMIT },
        ...(options.interdiff === undefined ? {} : { interdiff: options.interdiff }),
    });
    const chosen: Viewing[] = [];
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <SnapshotPill
                label={options.label ?? LABEL}
                menu={{
                    rows,
                    viewing: options.viewing ?? VIEWING_CURRENT,
                    now: NOW,
                    onSelect: (viewing) => chosen.push(viewing),
                    initialOpen: true,
                }}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, chosen };
}

function sections(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.snapshot-picker__section')].map((node) => node.textContent);
}

function hint(host: HTMLElement): string | null {
    return host.querySelector('.snapshot-picker__hint')?.textContent ?? null;
}

function shiftClick(node: Element | null): void {
    act(() => {
        node?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
}

function press(host: HTMLElement, key: string, shiftKey = false): void {
    const menu = host.querySelector<HTMLElement>('.snapshot-picker__menu');
    act(() => {
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    });
}

const PREVIOUS = '[data-diff="182800"]';
const GONE = '[data-diff="182799"]';
const ACTIVE_SNAPSHOT = '[data-snapshot="route-new"]';

describe('slice in the picker menu', () => {
    it('the menu has one section for the timeline', () => {
        const { host } = render({ interdiff: true });

        expect(sections(host)).toEqual(['Snapshots and iterations']);
        expect([...host.querySelectorAll('.snapshot-picker__row')]).toHaveLength(3);
    });

    it('Shift+clicking a previous iteration gives a slice up to the active one, with the base older than the head', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('Shift+clicking a newer iteration makes it the head', () => {
        const { host, chosen } = render({ interdiff: true, viewing: { kind: 'diff', diffId: '182800' } });

        shiftClick(host.querySelector(ACTIVE_SNAPSHOT));

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('with a stale route, Shift+click starts from the current snapshot iteration, not the active one', () => {
        const staleSnapshot: UiSnapshotSummary = {
            ...SNAPSHOT,
            snapshotId: 'route-old',
            diffId: '182800',
            commit: OLD_COMMIT,
        };
        const iterations = [
            iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'previous' }),
            iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
            iteration({}),
        ];

        const toActive = render({ interdiff: true, snapshots: [staleSnapshot], iterations });
        shiftClick(toActive.host.querySelector('[data-diff="182801"]'));
        expect(toActive.chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);

        const toOlder = render({ interdiff: true, snapshots: [staleSnapshot], iterations });
        shiftClick(toOlder.host.querySelector('[data-diff="182799"]'));
        expect(toOlder.chosen).toEqual([{ kind: 'slice', base: '182799', head: '182800' }]);
    });

    it('a regular click selects the row normally', () => {
        const { host, chosen } = render({ interdiff: true });

        act(() => {
            host.querySelector<HTMLElement>(PREVIOUS)?.click();
        });

        expect(chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Shift+click on the anchor, a gone iteration or a host without slices selects normally', () => {
        const onAnchor = render({ interdiff: true });
        shiftClick(onAnchor.host.querySelector(ACTIVE_SNAPSHOT));
        expect(onAnchor.chosen).toEqual([{ kind: 'snapshot', snapshotId: 'route-new' }]);

        const onGone = render({ interdiff: true });
        shiftClick(onGone.host.querySelector(GONE));
        expect(onGone.chosen).toEqual([{ kind: 'diff', diffId: '182799' }]);

        const noInterdiff = render({});
        shiftClick(noInterdiff.host.querySelector(PREVIOUS));
        expect(noInterdiff.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Shift+⏎ on the row under the pointer selects a slice, regular ⏎ selects normally', () => {
        const shifted = render({ interdiff: true });
        press(shifted.host, 'ArrowDown');
        press(shifted.host, 'Enter', true);
        expect(shifted.chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);

        const plain = render({ interdiff: true });
        press(plain.host, 'ArrowDown');
        press(plain.host, 'Enter');
        expect(plain.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('a slice marks both edges and the indicator names both sides', () => {
        const { host } = render({
            interdiff: true,
            viewing: { kind: 'slice', base: '182800', head: '182801' },
            label: SLICE_LABEL,
        });

        expect(host.querySelector('.snapshot-pill')?.textContent).toContain(
            `slice ${OLD_COMMIT.slice(0, 7)} → ${NEW_COMMIT.slice(0, 7)}`,
        );
        expect(host.querySelector<HTMLElement>('.snapshot-pill')?.title).toBe(
            `Slice between iterations ${OLD_COMMIT} → ${NEW_COMMIT}`,
        );
        const checked = [...host.querySelectorAll('[aria-checked="true"]')];
        expect(checked.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182800',
        ]);
    });

    it('an iteration with several snapshots marks the top one and leaves intermediate iterations unmarked', () => {
        const { host } = render({
            interdiff: true,
            snapshots: [{ ...SNAPSHOT, snapshotId: 'route-new-1', status: 'stale' }, SNAPSHOT],
            iterations: [
                iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'previous' }),
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration({}),
            ],
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: SLICE_LABEL,
        });

        const checked = [...host.querySelectorAll('[aria-checked="true"]')];
        expect(checked.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182799',
        ]);
    });

    it('the Shift+click hint appears only when the host supports slices and there are iterations to compare', () => {
        expect(hint(render({ interdiff: true }).host)).toBe('⇧ + click — changes between iterations');
        expect(hint(render({}).host)).toBeNull();
        expect(hint(render({ interdiff: true, iterations: [iteration({})] }).host)).toBeNull();
        // A gone iteration cannot be compared, leaving only the active one with nothing to compare it to.
        expect(
            hint(
                render({
                    interdiff: true,
                    iterations: [iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'gone' }), iteration({})],
                }).host,
            ),
        ).toBeNull();
    });

    it('the hint is not a menu item, so arrow keys skip it', () => {
        const { host, chosen } = render({ interdiff: true });
        expect(host.querySelector('.snapshot-picker__hint')?.getAttribute('role')).toBeNull();

        for (let step = 0; step < 5; step += 1) {
            press(host, 'ArrowDown');
        }
        press(host, 'Enter');

        expect(chosen).toEqual([{ kind: 'diff', diffId: '182799' }]);
    });
});

describe('slice in the "Snapshots" card on Overview', () => {
    function renderCard(viewing: Viewing = VIEWING_CURRENT): Rendered {
        const rows = pickerRows({
            snapshots: [SNAPSHOT],
            iterations: ITERATIONS,
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const chosen: Viewing[] = [];
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<SnapshotsCard rows={rows} viewing={viewing} now={NOW} onSelect={(next) => chosen.push(next)} />);
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });
        return { host, chosen };
    }

    it('Shift+click selects a slice, a regular click selects normally', () => {
        const { host, chosen } = renderCard();

        shiftClick(host.querySelector(PREVIOUS));
        act(() => {
            host.querySelector<HTMLElement>(PREVIOUS)?.click();
        });
        shiftClick(host.querySelector(GONE));

        expect(chosen).toEqual([
            { kind: 'slice', base: '182800', head: '182801' },
            { kind: 'diff', diffId: '182800' },
            { kind: 'diff', diffId: '182799' },
        ]);
    });

    it('marks both slice endpoints', () => {
        const { host } = renderCard({ kind: 'slice', base: '182800', head: '182801' });

        const pressed = [...host.querySelectorAll('[aria-pressed="true"]')];
        expect(pressed.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182800',
        ]);
    });
});

describe('menu rows with indistinguishable commits', () => {
    it('2 iterations of the same commit show the exact time instead of "6 hr. ago"', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '182799', status: 'previous', createdAt: '2026-08-31T09:00:00.000Z' }),
                iteration({ diffId: '182800', status: 'previous', createdAt: '2026-08-31T10:30:00.000Z' }),
            ],
            activeIteration: null,
        });
        const t = createT('en');
        const texts = rows.iterations.map((row) => rowText(row, NOW, t, 'en'));

        expect(new Set(texts).size).toBe(2);
        for (const text of texts) {
            expect(text).not.toContain('ago');
        }
    });

    it('distinct commits in the menu keep rounded times', () => {
        const rows = pickerRows({
            snapshots: [],
            iterations: [
                iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
                iteration({}),
            ],
            activeIteration: null,
        });
        const t = createT('en');

        expect(rows.iterations.map((row) => rowText(row, NOW, t, 'en'))).toEqual([
            `${NEW_COMMIT.slice(0, 7)} · active iteration · no route`,
            `${OLD_COMMIT.slice(0, 7)} · previous iteration · no route`,
        ]);
    });
});
