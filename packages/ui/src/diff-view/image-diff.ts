/**
 * Pixel difference between two image sides (M5-T25). Pure function without DOM or theme colors:
 * the card rasterizes, the accent is a parameter. The same calculation runs in a web worker.
 */

/** Side raster: like `ImageData`, without a canvas dependency, so the worker can use it too. */
export interface PixelSurface {
    readonly width: number;
    readonly height: number;
    readonly data: Uint8ClampedArray;
}

export interface DiffPixelsOptions {
    /** Changed pixel color: the card's computed `--accent` token. */
    readonly accent: readonly [number, number, number];
    /** RGBA channel tolerance: a channel is unchanged while its difference is at most the threshold. */
    readonly threshold?: number;
}

export interface ImageDiffResult extends PixelSurface {
    readonly changed: number;
    readonly total: number;
    /** Different side resolutions: calculation used the bounding rectangle, which must be reported. */
    readonly sizeMismatch: boolean;
}

/** Opacity of the unchanged background underlay: context stays visible without competing with the accent. */
const CONTEXT_ALPHA = 0.35;

/**
 * Diff over the bounding rectangle (`max` width and height, aligned at the top left,
 * like Swipe layers). A pixel is changed if present on only one side or if at least one
 * RGBA channel differs by more than the threshold. Two fully transparent pixels are equal regardless of RGB.
 * A pixel absent on both sides (the sides differ in both width and height)
 * is not counted as changed and stays transparent in the output.
 */
export function diffPixels(before: PixelSurface, after: PixelSurface, options: DiffPixelsOptions): ImageDiffResult {
    const threshold = options.threshold ?? 0;
    const accentR = options.accent[0];
    const accentG = options.accent[1];
    const accentB = options.accent[2];
    const width = Math.max(before.width, after.width);
    const height = Math.max(before.height, after.height);
    const data = new Uint8ClampedArray(width * height * 4);
    let changed = 0;

    for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
            const out = (y * width + x) * 4;
            const hasBefore = x < before.width && y < before.height;
            const hasAfter = x < after.width && y < after.height;
            const b = (y * before.width + x) * 4;
            const a = (y * after.width + x) * 4;

            let differs = hasBefore !== hasAfter;
            if (hasBefore && hasAfter) {
                const beforeAlpha = before.data[b + 3] ?? 0;
                const afterAlpha = after.data[a + 3] ?? 0;
                differs =
                    (beforeAlpha !== 0 || afterAlpha !== 0) &&
                    (Math.abs((before.data[b] ?? 0) - (after.data[a] ?? 0)) > threshold ||
                        Math.abs((before.data[b + 1] ?? 0) - (after.data[a + 1] ?? 0)) > threshold ||
                        Math.abs((before.data[b + 2] ?? 0) - (after.data[a + 2] ?? 0)) > threshold ||
                        Math.abs(beforeAlpha - afterAlpha) > threshold);
            }

            if (differs) {
                changed += 1;
                data[out] = accentR;
                data[out + 1] = accentG;
                data[out + 2] = accentB;
                data[out + 3] = 255;
            } else if (hasAfter) {
                // Desaturated `after` as underlay: `Uint8ClampedArray` rounds and clamps it.
                const luma =
                    0.2126 * (after.data[a] ?? 0) + 0.7152 * (after.data[a + 1] ?? 0) + 0.0722 * (after.data[a + 2] ?? 0);
                data[out] = luma;
                data[out + 1] = luma;
                data[out + 2] = luma;
                data[out + 3] = (after.data[a + 3] ?? 0) * CONTEXT_ALPHA;
            }
        }
    }

    return {
        width,
        height,
        data,
        changed,
        total: width * height,
        sizeMismatch: before.width !== after.width || before.height !== after.height,
    };
}
