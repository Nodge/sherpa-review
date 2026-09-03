// @vitest-environment jsdom
import type { Iteration, UiSnapshotSummary } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { SnapshotPill } from './snapshot-picker.tsx';
import type { Viewing, ViewingLabel } from './viewing.js';
import { pickerRows, VIEWING_CURRENT } from './viewing.js';

/**
 * The "Show changes since iteration…" section in the picker menu (M4-T12): what it offers,
 * what becomes the selection, and how keyboard navigation crosses the 3 sections.
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
    readonly iterations?: readonly Iteration[];
    readonly viewing?: Viewing;
    readonly label?: ViewingLabel;
}): Rendered {
    const rows = pickerRows({
        snapshots: [SNAPSHOT],
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

describe('slice section in the picker menu', () => {
    it('offers slices only from previous iterations, excluding active and gone ones', () => {
        const { host } = render({ interdiff: true });

        expect(sections(host)).toEqual(['Snapshots', 'Iterations without a route', 'Show changes since iteration…']);
        const slices = [...host.querySelectorAll('[data-slice]')];
        expect(slices.map((node) => node.getAttribute('data-slice'))).toEqual(['182800']);
        expect(slices[0]?.textContent).toContain(`→ ${NEW_COMMIT.slice(0, 7)}`);
        expect(slices[0]?.textContent).toContain(OLD_COMMIT.slice(0, 7));
    });

    it('omits the section for a host without iterations', () => {
        const { host } = render({});

        expect(sections(host)).toEqual(['Snapshots', 'Iterations without a route']);
        expect(host.querySelector('[data-slice]')).toBeNull();
    });

    it('omits the section when no iterations qualify', () => {
        const { host } = render({ interdiff: true, iterations: [iteration({})] });

        expect(sections(host)).toEqual(['Snapshots']);
    });

    it('clicking a row selects a slice to the active iteration', () => {
        const { host, chosen } = render({ interdiff: true });

        act(() => {
            host.querySelector<HTMLElement>('[data-slice="182800"]')?.click();
        });

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('arrows cross all 3 sections and ⏎ selects a slice', () => {
        const { host, chosen } = render({ interdiff: true });
        const menu = host.querySelector<HTMLElement>('.snapshot-picker__menu');
        expect(menu).not.toBeNull();

        // Snapshot, iteration without a route, gone iteration, slice: one step down each.
        for (let step = 0; step < 3; step += 1) {
            act(() => {
                menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            });
        }
        act(() => {
            menu?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        expect(chosen).toEqual([{ kind: 'slice', base: '182800', head: '182801' }]);
    });

    it('checks the selected slice and names both sides in the pill', () => {
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
        expect(checked).toHaveLength(1);
        expect(checked[0]?.getAttribute('data-slice')).toBe('182800');
    });
});
