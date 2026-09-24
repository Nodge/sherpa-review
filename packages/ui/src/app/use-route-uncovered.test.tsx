// @vitest-environment jsdom
import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { FileDiff, RouteSnapshot } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DiffFileModel } from '../diff/model.js';
import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import type { DiffViewStore } from '../diff-view/store.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { buildRouteModel } from '../route/route-model.js';
import type { RouteUncoveredOptions } from './use-route-uncovered.js';
import { useRouteUncovered } from './use-route-uncovered.js';

/**
 * Uncovered ranges outside the route view: Overview and the palette learn whether "Other" exists
 * without waiting for the reviewer to open the route.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DATA = fixtureIteration('medium');

function snapshot(phase: 'filling' | 'ready'): RouteSnapshot {
    const value = routeFixtures('medium')?.states[phase]?.snapshot ?? null;
    if (value === null) {
        throw new Error(`the medium fixture needs a snapshot in phase ${phase}`);
    }
    return value;
}

const parseNow = (file: FileDiff): Promise<DiffFileModel> => Promise.resolve(parseFileDiff(toParseRequest(file)));

/** Fixture uncovered ranges, calculated by the route view model across all parsed files. */
const EXPECTED = buildRouteModel({
    snapshot: snapshot('ready'),
    files: DATA.diff.files,
    models: new Map(DATA.diff.files.map((file) => [file.fileId, parseFileDiff(toParseRequest(file))])),
}).totals.uncovered;

let host: HTMLElement;
let root: ReturnType<typeof createRoot>;
let seen: (number | null)[];

function Probe(props: RouteUncoveredOptions) {
    seen.push(useRouteUncovered(props));
    return null;
}

async function mount(props: RouteUncoveredOptions): Promise<void> {
    act(() => {
        root.render(<Probe {...props} />);
    });
    await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
    });
}

beforeEach(() => {
    vi.useFakeTimers();
    seen = [];
    host = document.createElement('div');
    root = createRoot(host);
});

afterEach(() => {
    act(() => {
        root.unmount();
    });
    vi.useRealTimers();
});

describe('uncovered route ranges outside the route view', () => {
    it('parses the diff in the background and returns the same count as the route view', async () => {
        expect(EXPECTED).toBeGreaterThan(0);
        const store = createDiffViewStore({ files: DATA.diff.files });
        const parse = vi.fn(parseNow);

        await mount({ diff: DATA.diff, store, snapshot: snapshot('ready'), parse });

        expect(seen[0]).toBeNull();
        expect(seen.at(-1)).toBe(EXPECTED);
        const conflicts = DATA.diff.files.filter((file) => file.changeType === 'conflict').length;
        expect(parse).toHaveBeenCalledTimes(DATA.diff.files.length - conflicts);
    });

    it('does not reparse files already parsed by the view', async () => {
        const store: DiffViewStore = createDiffViewStore({ files: DATA.diff.files });
        for (const file of DATA.diff.files) {
            store.setModel(file.fileId, parseFileDiff(toParseRequest(file)));
        }
        const parse = vi.fn(parseNow);

        await mount({ diff: DATA.diff, store, snapshot: snapshot('ready'), parse });

        expect(parse).not.toHaveBeenCalled();
        expect(seen.at(-1)).toBe(EXPECTED);
    });

    it('does not parse or count while the route is being built', async () => {
        const store = createDiffViewStore({ files: DATA.diff.files });
        const parse = vi.fn(parseNow);

        await mount({ diff: DATA.diff, store, snapshot: snapshot('filling'), parse });

        expect(parse).not.toHaveBeenCalled();
        expect(seen.every((value) => value === null)).toBe(true);
    });

    it('treats a parse failure as a result and shows the count without lines from that file', async () => {
        const store = createDiffViewStore({ files: DATA.diff.files });
        const broken = DATA.diff.files[0]?.fileId;
        const parse = vi.fn((file: FileDiff) =>
            file.fileId === broken ? Promise.reject(new Error('worker crashed')) : parseNow(file),
        );

        await mount({ diff: DATA.diff, store, snapshot: snapshot('ready'), parse });

        expect(seen.at(-1)).not.toBeNull();
    });

    it('still shows the count when the worker fails to start synchronously', async () => {
        const store = createDiffViewStore({ files: DATA.diff.files });
        const parse = vi.fn((): Promise<DiffFileModel> => {
            throw new ReferenceError('Worker is not defined');
        });

        await mount({ diff: DATA.diff, store, snapshot: snapshot('ready'), parse });

        expect(seen.at(-1)).toBe(0);
    });
});
