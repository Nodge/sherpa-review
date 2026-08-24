import { afterEach, describe, expect, it, vi } from 'vitest';

import { convergeScroll } from './file-list.tsx';

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
});
