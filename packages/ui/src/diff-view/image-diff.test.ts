import { describe, expect, it } from 'vitest';

import type { PixelSurface } from './image-diff.js';
import { diffPixels } from './image-diff.js';

/**
 * Pixel diff: what counts as a change (threshold, transparency, different sizes) and what
 * the output looks like. The accent color is a parameter, so tests check it literally.
 */

const ACCENT: readonly [number, number, number] = [255, 0, 128];

/** Raster from explicit pixels: `fill` returns a pixel's RGBA. */
function surface(
    width: number,
    height: number,
    fill: (x: number, y: number) => readonly [number, number, number, number],
): PixelSurface {
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const at = (y * width + x) * 4;
            const [r, g, b, a] = fill(x, y);
            data[at] = r;
            data[at + 1] = g;
            data[at + 2] = b;
            data[at + 3] = a;
        }
    }
    return { width, height, data };
}

function solid(width: number, height: number, pixel: readonly [number, number, number, number]): PixelSurface {
    return surface(width, height, () => pixel);
}

/** Output pixel RGBA at the given coordinates. */
function pixelAt(result: PixelSurface, x: number, y: number): number[] {
    const at = (y * result.width + x) * 4;
    return [...result.data.slice(at, at + 4)];
}

describe('pixel diff', () => {
    it('identical sides: no changed pixels, background becomes a muted underlay', () => {
        const side = solid(2, 2, [100, 100, 100, 255]);
        const result = diffPixels(side, solid(2, 2, [100, 100, 100, 255]), { accent: ACCENT });

        expect(result.changed).toBe(0);
        expect(result.total).toBe(4);
        expect(result.sizeMismatch).toBe(false);
        expect(result.width).toBe(2);
        expect(result.height).toBe(2);
        // Desaturated `after` with alpha × 0.35: 255 × 0.35 = 89.25.
        expect(pixelAt(result, 0, 0)).toEqual([100, 100, 100, 89]);
    });

    it('one different pixel: count is one, accent is exactly at its position', () => {
        const before = solid(2, 2, [10, 20, 30, 255]);
        const after = surface(2, 2, (x, y) => (x === 1 && y === 0 ? [10, 20, 200, 255] : [10, 20, 30, 255]));

        const result = diffPixels(before, after, { accent: ACCENT });

        expect(result.changed).toBe(1);
        expect(pixelAt(result, 1, 0)).toEqual([255, 0, 128, 255]);
        expect(pixelAt(result, 0, 0)[3]).toBe(89);
    });

    it('different sizes: flags the size mismatch and counts the extra area as changed', () => {
        const before = solid(2, 1, [10, 10, 10, 255]);
        const after = solid(4, 1, [10, 10, 10, 255]);

        const result = diffPixels(before, after, { accent: ACCENT });

        expect(result.sizeMismatch).toBe(true);
        expect(result.width).toBe(4);
        expect(result.total).toBe(4);
        expect(result.changed).toBe(2);
        expect(pixelAt(result, 3, 0)).toEqual([255, 0, 128, 255]);
    });

    it('does not count a pixel absent on both sides as changed', () => {
        // The sides extend in different directions: the bounding rectangle has an empty bottom-right corner.
        const result = diffPixels(solid(4, 1, [0, 0, 0, 255]), solid(1, 4, [0, 0, 0, 255]), { accent: ACCENT });

        expect(result.total).toBe(16);
        // The sides share one pixel (0, 0). Another six belong to exactly one side and count as changed,
        // while the remaining nine belong to neither.
        expect(result.changed).toBe(6);
        expect(pixelAt(result, 2, 2)).toEqual([0, 0, 0, 0]);
    });

    it('treats two fully transparent pixels as equal regardless of RGB', () => {
        const result = diffPixels(solid(1, 1, [255, 0, 0, 0]), solid(1, 1, [0, 0, 255, 0]), { accent: ACCENT });

        expect(result.changed).toBe(0);
        // The pixel stays transparent: RGB under zero alpha has no effect.
        expect(pixelAt(result, 0, 0)[3]).toBe(0);
    });

    it('threshold: a channel within tolerance stays unchanged', () => {
        const before = solid(1, 1, [100, 100, 100, 255]);
        const within = diffPixels(before, solid(1, 1, [105, 100, 100, 255]), { accent: ACCENT, threshold: 8 });
        const beyond = diffPixels(before, solid(1, 1, [110, 100, 100, 255]), { accent: ACCENT, threshold: 8 });
        const exact = diffPixels(before, solid(1, 1, [105, 100, 100, 255]), { accent: ACCENT });

        expect(within.changed).toBe(0);
        expect(beyond.changed).toBe(1);
        // The default threshold is zero: exact equality.
        expect(exact.changed).toBe(1);
    });
});
