import type { FileDiff } from '@sherpa/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { convergeScroll, estimateBodyHeight, watchUserScroll } from './file-list.tsx';

interface AnimationFrames {
    readonly flush: () => void;
    readonly count: () => number;
}

function fakeAnimationFrames(): AnimationFrames {
    let nextId = 0;
    const frames = new Map<number, FrameRequestCallback>();
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
        nextId += 1;
        frames.set(nextId, callback);
        return nextId;
    });
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
        frames.delete(id);
    });
    return {
        flush: () => {
            const next = frames.entries().next().value;
            if (next === undefined) {
                throw new Error('No frame scheduled');
            }
            frames.delete(next[0]);
            next[1](0);
        },
        count: () => frames.size,
    };
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('virtualized list scroll adjustment', () => {
    it('signals completion only after the position converges', async () => {
        const frames = fakeAnimationFrames();
        const positions = [120, 180, 180];
        let step = 0;
        const onDone = vi.fn();
        const run = convergeScroll(
            () => {
                step += 1;
            },
            () => positions[step - 1] ?? positions.at(-1) ?? 0,
            onDone,
        );

        frames.flush();
        frames.flush();
        expect(onDone).not.toHaveBeenCalled();
        frames.flush();

        await expect(run.finished).resolves.toBe(true);
        expect(step).toBe(3);
        expect(onDone).toHaveBeenCalledWith(true);
        expect(frames.count()).toBe(0);
    });

    it('cancels the previous adjustment and resolves its waiter with false', async () => {
        const frames = fakeAnimationFrames();
        const onDone = vi.fn();
        const run = convergeScroll(
            () => undefined,
            () => 0,
            onDone,
        );

        expect(run.cancel()).toBe(false);
        await expect(run.finished).resolves.toBe(false);
        expect(onDone).toHaveBeenCalledWith(false);
        expect(frames.count()).toBe(0);
    });

    it('yields to the reviewer: wheel and touch cancel the steps, cleanup removes listeners', async () => {
        const frames = fakeAnimationFrames();
        const element = fakeElement();
        const run = convergeScroll(
            () => undefined,
            () => 0,
            () => undefined,
        );
        const unwatch = watchUserScroll(element.node, () => {
            run.cancel();
        });

        expect(frames.count()).toBe(1);
        element.emit('wheel');
        await expect(run.finished).resolves.toBe(false);
        expect(frames.count()).toBe(0);

        const second = convergeScroll(
            () => undefined,
            () => 0,
            () => undefined,
        );
        const unwatchSecond = watchUserScroll(element.node, () => {
            second.cancel();
        });
        element.emit('touchmove');
        await expect(second.finished).resolves.toBe(false);

        unwatch();
        unwatchSecond();
        expect(element.listeners('wheel')).toBe(0);
        expect(element.listeners('touchmove')).toBe(0);
    });
});

describe('card height estimate', () => {
    const file = (patch: Partial<FileDiff>): FileDiff => ({
        fileId: 'f',
        path: 'src/a.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 0,
        deletions: 0,
        patch: '@@',
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
        ...patch,
    });

    it('counts diff lines and adds an allowance for context between hunks', () => {
        expect(estimateBodyHeight(file({ additions: 25, deletions: 5 }), 'unified', false, 20)).toBe(30 * 20 + 104);
    });

    it('accounts for the compact theme\'s 17px code height', () => {
        expect(estimateBodyHeight(file({ additions: 25, deletions: 5 }), 'unified', false, 17)).toBe(30 * 17 + 104);
        expect(estimateBodyHeight(file({ changeType: 'add', additions: 28 }), 'split', false, 17)).toBe(28 * 17);
    });

    it('has no context for add and delete, the whole file is one hunk', () => {
        expect(estimateBodyHeight(file({ changeType: 'add', additions: 28 }), 'unified', false, 20)).toBe(28 * 20);
        expect(estimateBodyHeight(file({ changeType: 'delete', deletions: 28 }), 'unified', false, 20)).toBe(28 * 20);
    });

    it('counts a pair of lines as one row in split mode, except for a one-sided file', () => {
        expect(estimateBodyHeight(file({ additions: 25, deletions: 5 }), 'split', false, 20)).toBe(25 * 20 + 104);
        expect(estimateBodyHeight(file({ changeType: 'add', additions: 28 }), 'split', false, 20)).toBe(28 * 20);
    });

    it('knows about viewed, manual and generated folds from the first frame', () => {
        expect(estimateBodyHeight(file({ additions: 25, deletions: 5 }), 'unified', true, 20)).toBe(32);
        expect(estimateBodyHeight(file({ additions: 25, deletions: 5 }), 'split', true, 20)).toBe(32);
    });

    it('uses a single-line notice for binary files, files without a patch and files collapsed by size', () => {
        expect(estimateBodyHeight(file({ binary: true, patch: null }), 'unified', false, 20)).toBe(32);
        expect(estimateBodyHeight(file({ patch: null }), 'unified', false, 20)).toBe(32);
        expect(estimateBodyHeight(file({ additions: 3000, deletions: 1 }), 'unified', false, 20)).toBe(32);
    });

    it('has nothing to estimate when the file is missing', () => {
        expect(estimateBodyHeight(undefined, 'unified', false, 20)).toBe(0);
    });
});

interface FakeElement {
    readonly node: HTMLElement;
    readonly emit: (type: string) => void;
    readonly listeners: (type: string) => number;
}

/** Scroll container without a DOM. UI unit tests run in a Node environment. */
function fakeElement(): FakeElement {
    const handlers = new Map<string, Set<EventListener>>();
    const node = {
        addEventListener: (type: string, handler: EventListener) => {
            const set = handlers.get(type) ?? new Set<EventListener>();
            set.add(handler);
            handlers.set(type, set);
        },
        removeEventListener: (type: string, handler: EventListener) => {
            handlers.get(type)?.delete(handler);
        },
    } as unknown as HTMLElement;

    return {
        node,
        emit: (type) => {
            for (const handler of handlers.get(type) ?? []) {
                handler(new Event(type));
            }
        },
        listeners: (type) => handlers.get(type)?.size ?? 0,
    };
}
