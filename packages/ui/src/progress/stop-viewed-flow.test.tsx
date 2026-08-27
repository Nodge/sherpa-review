// @vitest-environment jsdom
import { fixtureData, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot, UiFileProgress, UiStopProgress, UiStopSeenRange } from '@sherpa/protocol';
import { UI_ENDPOINTS } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { App } from '../app.tsx';
import { parseFileDiff } from '../diff/parse.js';
import type { SessionStore } from '../session/session-store.js';
import { createSessionStore } from '../session/session-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import type { Store, StoreSnapshot } from '../store.js';

/**
 * End-to-end stop marking (dogfooding finding #31): header toggle click → write
 * seen ranges through the endpoint → refetch the progress snapshot → update file read-state boxes in the shared
 * store. Mount the whole application: App handles refetching, so an isolated view cannot
 * test it. The mark was lost at the boundary between the view and App.
 *
 * The server here is an in-memory map with `ProgressStore` semantics, and the event channel is a substituted
 * `Store`. This also reproduces the case where a progress event has not reached the tab yet.
 */

const DATA = fixtureData('medium');
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();

// React 19 requires the environment to be declared explicitly, or every `act` logs a warning.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface FakeProgress {
    readonly revision: number;
    readonly read: () => UiFileProgress[];
    readonly readStops: () => UiStopProgress[];
    readonly setStopViewed: (stopId: string, viewed: boolean, ranges: readonly UiStopSeenRange[]) => number;
    readonly setFileViewed: (fileId: string, viewed: boolean) => number;
    /** Server restart: database data survives, but the revision counter starts over. */
    readonly restart: () => void;
}

/** In-memory PR progress with the same reading rules as the server's `ProgressStore`. */
function fakeProgress(): FakeProgress {
    const files = new Map<string, boolean>();
    const stops = new Map<string, boolean>();
    const ranges = new Map<string, readonly UiStopSeenRange[]>();
    let revision = 0;
    return {
        get revision() {
            return revision;
        },
        read: () => {
            const byFile = new Map<string, UiFileProgress>();
            for (const [fileId, viewed] of files) {
                byFile.set(fileId, { fileId, viewed, seenRanges: [] });
            }
            for (const list of ranges.values()) {
                for (const range of list) {
                    const record = byFile.get(range.fileId) ?? {
                        fileId: range.fileId,
                        viewed: false,
                        seenRanges: [],
                    };
                    byFile.set(range.fileId, {
                        ...record,
                        seenRanges: [...record.seenRanges, { side: range.side, start: range.start, end: range.end }],
                    });
                }
            }
            return [...byFile.values()];
        },
        readStops: () => [...stops].map(([stopId, viewed]) => ({ stopId, viewed })),
        setStopViewed: (stopId, viewed, next) => {
            stops.set(stopId, viewed);
            ranges.set(stopId, viewed ? next : []);
            revision += 1;
            return revision;
        },
        setFileViewed: (fileId, viewed) => {
            files.set(fileId, viewed);
            revision += 1;
            return revision;
        },
        restart: () => {
            revision = 0;
        },
    };
}

interface Mounted {
    readonly host: HTMLElement;
    /** Server restart with a channel event announcing its new (zero) revision. */
    readonly restartServer: () => void;
    readonly session: SessionStore;
    readonly progress: FakeProgress;
    /** Advance time: loads, diff parsing, and progress refetches complete across frames. */
    readonly settle: () => Promise<void>;
}

const cleanups: (() => void)[] = [];
afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
        cleanup();
    }
});

interface MountOptions {
    /** Progress events do not reach the tab, so the channel revision stays unknown. */
    readonly silentProgressEvents?: boolean;
    /** Files the worker will fail to parse. */
    readonly failParse?: ReadonlySet<string>;
}

function mount(options: MountOptions = {}): Mounted {
    const progress = fakeProgress();
    const originalFetch = globalThis.fetch;
    const globals = globalThis as { Worker?: unknown; ResizeObserver?: unknown };
    const originalWorker = globals.Worker;

    // jsdom has no real worker. Use the same parser in the same thread.
    class FakeWorker {
        private readonly listeners = new Map<string, ((event: unknown) => void)[]>();
        addEventListener(type: string, listener: (event: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }
        postMessage(message: { id: number; file: Parameters<typeof parseFileDiff>[0] }): void {
            const failed = options.failParse?.has(message.file.fileId) === true;
            const reply = failed
                ? { id: message.id, ok: false, error: 'patch could not be parsed' }
                : { id: message.id, ok: true, model: parseFileDiff(message.file) };
            queueMicrotask(() => {
                for (const listener of this.listeners.get('message') ?? []) {
                    listener({ data: reply });
                }
            });
        }
        terminate(): void {
            this.listeners.clear();
        }
    }
    globals.Worker = FakeWorker;
    globals.ResizeObserver ??= class {
        observe(): void {
            // jsdom has no layout, so there is nothing to observe.
        }
        unobserve(): void {
            // jsdom has no layout, so there is nothing to observe.
        }
        disconnect(): void {
            // jsdom has no layout, so there is nothing to observe.
        }
    };

    const json = (body: unknown): Response =>
        new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

    globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const path = url.split('?')[0] ?? '';
        const body: Record<string, unknown> =
            typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : {};
        switch (path) {
            case UI_ENDPOINTS.reviewDiff:
                return Promise.resolve(json({ diff: DATA.diff }));
            case UI_ENDPOINTS.reviewLenses:
                return Promise.resolve(json({ ownership: DATA.ownership, extra: DATA.extraLenses }));
            case UI_ENDPOINTS.reviewThreads:
                return Promise.resolve(json({ threads: DATA.threads }));
            case UI_ENDPOINTS.reviewRoute:
                return Promise.resolve(
                    json({
                        route: { phase: 'ready', smallPr: false, snapshot: SNAPSHOT, failure: null },
                        routeRevision: 1,
                    }),
                );
            case UI_ENDPOINTS.reviewProgress:
                return Promise.resolve(
                    json({
                        files: progress.read(),
                        stops: progress.readStops(),
                        progressRevision: progress.revision,
                    }),
                );
            case UI_ENDPOINTS.reviewStopViewed: {
                const revision = progress.setStopViewed(
                    body.stopId as string,
                    body.viewed as boolean,
                    body.ranges as readonly UiStopSeenRange[],
                );
                pushProgressEvent(revision);
                return Promise.resolve(json({ progressRevision: revision }));
            }
            case UI_ENDPOINTS.reviewFileViewed: {
                const revision = progress.setFileViewed(body.fileId as string, body.viewed as boolean);
                pushProgressEvent(revision);
                return Promise.resolve(json({ progressRevision: revision }));
            }
            default:
                return Promise.resolve(json({}));
        }
    };

    let snapshot: StoreSnapshot = {
        connection: 'online',
        state: { prKey: 'fixture/medium', worker: { kind: 'never' }, tasks: [], reviewHost: 'fixture', pr: DATA.pr },
        error: null,
        progressRevision: null,
        threadsRevision: 1,
        routeRevision: 1,
    };
    const listeners = new Set<() => void>();
    const pushProgressEvent = (revision: number): void => {
        if (options.silentProgressEvents === true) {
            return;
        }
        snapshot = { ...snapshot, progressRevision: revision };
        for (const listener of [...listeners]) {
            listener();
        }
    };
    const store: Store = {
        subscribe: (listener) => {
            listeners.add(listener);
            return () => {
                listeners.delete(listener);
            };
        },
        getSnapshot: () => snapshot,
        close: () => undefined,
    };

    const session = createSessionStore({ initial: { view: 'route', filter: 'all' } });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ShortcutsProvider registry={createShortcutRegistry()}>
                <App store={store} session={session} token="token" />
            </ShortcutsProvider>,
        );
    });
    cleanups.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
        globalThis.fetch = originalFetch;
        globals.Worker = originalWorker;
    });

    const settle = async (): Promise<void> => {
        for (let step = 0; step < 12; step += 1) {
            await act(async () => {
                await new Promise((resolve) => setTimeout(resolve, 20));
            });
        }
    };

    return {
        host,
        session,
        progress,
        settle,
        restartServer: () => {
            progress.restart();
            pushProgressEvent(0);
        },
    };
}

function stopSection(host: HTMLElement, stopId: string): HTMLElement {
    const section = host.querySelector<HTMLElement>(`[data-stop="${stopId}"]`);
    if (section === null) {
        throw new Error(`stop ${stopId} is missing from the markup`);
    }
    return section;
}

function viewedToggle(section: HTMLElement): HTMLButtonElement {
    const toggle = section.querySelector<HTMLButtonElement>('.route-stop__viewed');
    if (toggle === null) {
        throw new Error('stop header has no viewed toggle');
    }
    return toggle;
}

/** How many diff files the reader considers read, the same count shown by the action bar. */
function filesRead(host: HTMLElement): string {
    return host.querySelector('.review-action-bar__progress')?.textContent ?? '';
}

describe('marking a stop updates its file read-state boxes', () => {
    it('updates without reloading after ranges are sent and the progress snapshot reaches the file store', async () => {
        const view = mount();
        await view.settle();
        expect(filesRead(view.host)).toBe('4 / 18 files');

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        // Stop 01 explains 2 complete files, so they must become read.
        expect(view.progress.read().filter((record) => record.seenRanges.length > 0)).toHaveLength(2);
        expect(filesRead(view.host)).toBe('6 / 18 files');
    });

    it('refreshes without waiting for a progress event from the channel', async () => {
        const view = mount({ silentProgressEvents: true });
        await view.settle();
        expect(filesRead(view.host)).toBe('4 / 18 files');

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(filesRead(view.host)).toBe('6 / 18 files');
    });

    it('clearing the mark returns files to unread', async () => {
        const view = mount();
        await view.settle();

        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();
        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(view.progress.read().every((record) => record.seenRanges.length === 0)).toBe(true);
        expect(filesRead(view.host)).toBe('4 / 18 files');
    });

    it('refreshes even when a server restart resets the revision', async () => {
        const view = mount();
        await view.settle();

        // Several marks before the restart bring the server revision above zero.
        for (let round = 0; round < 2; round += 1) {
            act(() => {
                viewedToggle(stopSection(view.host, 's01')).click();
            });
            await view.settle();
            act(() => {
                viewedToggle(stopSection(view.host, 's01')).click();
            });
            await view.settle();
        }
        expect(filesRead(view.host)).toBe('4 / 18 files');

        view.restartServer();
        act(() => {
            viewedToggle(stopSection(view.host, 's01')).click();
        });
        await view.settle();

        expect(filesRead(view.host)).toBe('6 / 18 files');
    });

    it('does not silently mark a stop when a file failed to parse', async () => {
        const failing = SNAPSHOT.stops.find((stop) => stop.id === 's01')?.anchors[0]?.fileId ?? '';
        expect(failing).not.toBe('');
        const view = mount({ failParse: new Set([failing]) });
        await view.settle();

        const toggle = viewedToggle(stopSection(view.host, 's01'));
        expect(toggle.disabled).toBe(true);
        expect(toggle.title).toBe('Some files of this stop failed to parse — retry the parse');

        act(() => {
            toggle.click();
        });
        await view.settle();

        // Neither a mark nor a partial set of ranges: either write would misrepresent progress.
        expect(view.progress.readStops()).toEqual([]);
        expect(view.progress.read()).toEqual([]);
    });
});
