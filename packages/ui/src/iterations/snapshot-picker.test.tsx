// @vitest-environment jsdom
import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { createT } from '../i18n/index.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';

import { rowText, SnapshotPill, SnapshotsCard } from './snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from './viewing.js';
import { pickerRows, VIEWING_CURRENT } from './viewing.js';

/**
 * Selecting a slice in the picker takes 2 steps: Shift+click (Shift+⏎) the first iteration, then click the second.
 * This also covers the range preview, the hint at the bottom of the menu, the active slice marks and the same behaviour
 * in the "Snapshots" card on Overview.
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

/** Mount under the command registry so Esc follows the layer hierarchy, as in App. */
function mount(element: ReactNode): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);
    act(() => {
        root.render(<ShortcutsProvider registry={registry}>{element}</ShortcutsProvider>);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });
    return host;
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
    const host = mount(
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
    return { host, chosen };
}

function sections(host: HTMLElement): string[] {
    return [...host.querySelectorAll('.snapshot-picker__section')].map((node) => node.textContent);
}

function hint(host: HTMLElement, selector = '.snapshot-picker__hint'): string | null {
    return host.querySelector(selector)?.textContent ?? null;
}

function menuOpen(host: HTMLElement): boolean {
    return host.querySelector('.snapshot-picker__menu') !== null;
}

function click(node: Element | null, shiftKey = false): void {
    act(() => {
        node?.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey }));
    });
}

function shiftClick(node: Element | null): void {
    click(node, true);
}

function hover(node: Element | null): void {
    act(() => {
        node?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
}

function press(host: HTMLElement, key: string, shiftKey = false): void {
    const menu = host.querySelector<HTMLElement>('.snapshot-picker__menu');
    act(() => {
        menu?.dispatchEvent(new KeyboardEvent('keydown', { key, shiftKey, bubbles: true }));
    });
}

function escape(): void {
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
}

/** Range marks: row id → edge or inside. */
function sliceParts(host: HTMLElement, rowSelector: string): string[] {
    return [...host.querySelectorAll(rowSelector)].map((node) => {
        const id = node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff') ?? '';
        const part = node.classList.contains('is-slice-edge')
            ? 'edge'
            : node.classList.contains('is-slice-inside')
              ? 'inside'
              : '-';
        return `${id}:${part}`;
    });
}

const PREVIOUS = '[data-diff="182800"]';
const OLDER = '[data-diff="182799"]';
const GONE = OLDER;
const ACTIVE_SNAPSHOT = '[data-snapshot="route-new"]';
const ROW = '.snapshot-picker__row';

/** Three eligible iterations: 182800 lies between the edges 182799 and the active iteration. */
const THREE: readonly Iteration[] = [
    iteration({ diffId: '182799', headCommit: GONE_COMMIT, status: 'previous' }),
    iteration({ diffId: '182800', headCommit: OLD_COMMIT, status: 'previous' }),
    iteration({}),
];

const HINT_IDLE = 'Shift+click two iterations — the slice between them';
const HINT_SECOND = 'Pick the second iteration · Esc or clicking the first one again cancels';

describe('slice in the picker menu', () => {
    it('the menu has one section for the timeline', () => {
        const { host } = render({ interdiff: true });

        expect(sections(host)).toEqual(['Snapshots and iterations']);
        expect([...host.querySelectorAll(ROW)]).toHaveLength(3);
    });

    it('the first Shift+click sets an edge, keeps the menu open without selecting and shows the second-step hint', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));

        expect(chosen).toEqual([]);
        expect(menuOpen(host)).toBe(true);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:edge', '182799:-']);
        expect(hint(host)).toBe(HINT_SECOND);
    });

    it('the second click without Shift builds a slice and closes the menu', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(ACTIVE_SNAPSHOT));

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
        expect(menuOpen(host)).toBe(false);
    });

    it('the second click with Shift also builds a slice, either edge order works and the active iteration is eligible', () => {
        const { host, chosen } = render({ interdiff: true, iterations: THREE });

        shiftClick(host.querySelector(ACTIVE_SNAPSHOT));
        shiftClick(host.querySelector(OLDER));

        expect(chosen).toEqual([{ kind: 'slice', base: '182799', head: '182801' }]);
    });

    it('clicking the edge again clears it and keeps the menu open', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(PREVIOUS));

        expect(chosen).toEqual([]);
        expect(menuOpen(host)).toBe(true);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:-']);
        expect(hint(host)).toBe(HINT_IDLE);

        // Mode cleared: a plain click selects normally again.
        click(host.querySelector(PREVIOUS));
        expect(chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Esc clears the edge and the next Esc closes the menu', () => {
        const { host, chosen } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        escape();

        expect(menuOpen(host)).toBe(true);
        expect(hint(host)).toBe(HINT_IDLE);
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:-']);

        escape();
        expect(menuOpen(host)).toBe(false);
        expect(chosen).toEqual([]);
    });

    it('closing the menu clears the edge', () => {
        const { host } = render({ interdiff: true });

        shiftClick(host.querySelector(PREVIOUS));
        press(host, 'Tab');
        act(() => {
            host.querySelector<HTMLButtonElement>('button.snapshot-pill--button')?.click();
        });

        expect(hint(host)).toBe(HINT_IDLE);
        expect(host.querySelector('.is-slice-edge')).toBeNull();
    });

    it('keyboard: Shift+⏎ sets an edge and ⏎ on another row builds a slice', () => {
        const { host, chosen } = render({ interdiff: true });

        press(host, 'ArrowDown');
        press(host, 'Enter', true);
        expect(chosen).toEqual([]);
        expect(hint(host)).toBe(HINT_SECOND);

        press(host, 'ArrowUp');
        press(host, 'Enter');
        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('space on another row also builds a slice', () => {
        const { host, chosen } = render({ interdiff: true });

        press(host, 'ArrowDown');
        press(host, 'Enter', true);
        press(host, 'ArrowUp');
        press(host, ' ');

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('a plain click and ⏎ outside slice mode select normally', () => {
        const clicked = render({ interdiff: true });
        click(clicked.host.querySelector(PREVIOUS));
        expect(clicked.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);

        const pressed = render({ interdiff: true });
        press(pressed.host, 'ArrowDown');
        press(pressed.host, 'Enter');
        expect(pressed.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('Shift+click selects normally for a gone iteration or a host without slice support', () => {
        const onGone = render({ interdiff: true });
        shiftClick(onGone.host.querySelector(GONE));
        expect(onGone.chosen).toEqual([{ kind: 'diff', diffId: '182799' }]);

        const noInterdiff = render({});
        shiftClick(noInterdiff.host.querySelector(PREVIOUS));
        expect(noInterdiff.chosen).toEqual([{ kind: 'diff', diffId: '182800' }]);
    });

    it('hovering another iteration previews the range, hovering the edge shows only the edge', () => {
        const { host } = render({ interdiff: true, iterations: THREE });

        shiftClick(host.querySelector(OLDER));
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        expect(sliceParts(host, ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);

        hover(host.querySelector(OLDER));
        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:-', '182799:edge']);
    });

    it('a slice shows the "Now: slice …" row, labelled edges and the range between them', () => {
        const { host } = render({
            interdiff: true,
            iterations: THREE,
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: { ...SLICE_LABEL, baseCommit: GONE_COMMIT },
        });

        expect(host.querySelector('.snapshot-picker__now')?.textContent).toBe(
            `Now: slice ${GONE_COMMIT.slice(0, 7)} → ${NEW_COMMIT.slice(0, 7)}`,
        );
        expect(sliceParts(host, ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
        expect([...host.querySelectorAll('.snapshot-picker__role')].map((node) => node.textContent)).toEqual([
            'head',
            'base',
        ]);
    });

    it('outside a slice there is no "Now" row or edge labels', () => {
        const { host } = render({ interdiff: true });

        expect(host.querySelector('.snapshot-picker__now')).toBeNull();
        expect(host.querySelector('.snapshot-picker__role')).toBeNull();
    });

    it('previewing a new slice replaces the active slice highlight', () => {
        const { host } = render({
            interdiff: true,
            iterations: THREE,
            viewing: { kind: 'slice', base: '182799', head: '182801' },
            label: SLICE_LABEL,
        });

        shiftClick(host.querySelector(PREVIOUS));
        hover(host.querySelector(OLDER));

        expect(sliceParts(host, ROW)).toEqual(['route-new:-', '182800:edge', '182799:edge']);
        expect(host.querySelector('.snapshot-picker__role')).toBeNull();
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
            iterations: THREE,
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
        expect(hint(render({ interdiff: true }).host)).toBe(HINT_IDLE);
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
    const CARD_ROW = '.snapshot-list__row';

    function renderCard(viewing: Viewing = VIEWING_CURRENT, iterations: readonly Iteration[] = ITERATIONS): Rendered {
        const rows = pickerRows({
            snapshots: [SNAPSHOT],
            iterations,
            activeIteration: { diffId: '182801', commit: NEW_COMMIT },
            interdiff: true,
        });
        const chosen: Viewing[] = [];
        const host = mount(
            <SnapshotsCard rows={rows} viewing={viewing} now={NOW} onSelect={(next) => chosen.push(next)} />,
        );
        return { host, chosen };
    }

    it('Shift+click sets an edge and clicking another iteration builds a slice', () => {
        const { host, chosen } = renderCard();

        shiftClick(host.querySelector(PREVIOUS));
        expect(chosen).toEqual([]);
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:edge', '182799:-']);
        expect(hint(host, '.snapshot-list__hint')).toBe(HINT_SECOND);

        click(host.querySelector(ACTIVE_SNAPSHOT));
        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
        expect(host.querySelector('.is-slice-edge')).toBeNull();
        expect(hint(host, '.snapshot-list__hint')).toBe(HINT_IDLE);
    });

    it('a plain click selects normally, as does Shift+click on a gone iteration', () => {
        const { host, chosen } = renderCard();

        click(host.querySelector(PREVIOUS));
        shiftClick(host.querySelector(GONE));

        expect(chosen).toEqual([
            { kind: 'diff', diffId: '182800' },
            { kind: 'diff', diffId: '182799' },
        ]);
    });

    it('clicking the edge again or pressing Esc clears it', () => {
        const { host, chosen } = renderCard();

        shiftClick(host.querySelector(PREVIOUS));
        click(host.querySelector(PREVIOUS));
        expect(host.querySelector('.is-slice-edge')).toBeNull();

        shiftClick(host.querySelector(PREVIOUS));
        escape();
        expect(host.querySelector('.is-slice-edge')).toBeNull();
        expect(chosen).toEqual([]);
    });

    it('hovering or focusing another iteration previews the range', () => {
        const { host } = renderCard(VIEWING_CURRENT, THREE);

        shiftClick(host.querySelector(OLDER));
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);

        act(() => {
            host.querySelector(ACTIVE_SNAPSHOT)?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:-', '182799:edge']);

        act(() => {
            host.querySelector<HTMLElement>(PREVIOUS)?.focus();
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:-', '182800:edge', '182799:edge']);
    });

    it('moving the mouse off a focused row keeps the preview', () => {
        const { host } = renderCard(VIEWING_CURRENT, THREE);

        shiftClick(host.querySelector(OLDER));
        act(() => {
            host.querySelector<HTMLElement>(ACTIVE_SNAPSHOT)?.focus();
        });
        hover(host.querySelector(ACTIVE_SNAPSHOT));
        act(() => {
            host.querySelector(ACTIVE_SNAPSHOT)?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true }));
        });
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
    });

    it('a slice marks both edges with labels and the range between them', () => {
        const { host } = renderCard({ kind: 'slice', base: '182799', head: '182801' }, THREE);

        const pressed = [...host.querySelectorAll('[aria-pressed="true"]')];
        expect(pressed.map((node) => node.getAttribute('data-snapshot') ?? node.getAttribute('data-diff'))).toEqual([
            'route-new',
            '182799',
        ]);
        expect(sliceParts(host, CARD_ROW)).toEqual(['route-new:edge', '182800:inside', '182799:edge']);
        expect([...host.querySelectorAll('.snapshot-list__role')].map((node) => node.textContent)).toEqual([
            'head',
            'base',
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
