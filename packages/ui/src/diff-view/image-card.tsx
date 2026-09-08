import type { FileDiff, FileImage, ImageSide } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES } from '@sherpa/protocol';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, RefObject, SyntheticEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Translate } from '../i18n/index.js';
import { activeT, useT } from '../i18n/index.js';
import type { BlobLoader } from './blob-loader.tsx';
import { sharedImageDiffClient } from './image-diff-client.js';
import type { DiffPixelsOptions, ImageDiffResult, PixelSurface } from './image-diff.js';
import './image-card.css';

/**
 * Image card body replaces the "binary file
 * not shown" notice with sides next to each other and ways to compare them. The header, Viewed, menu and folds
 * stay shared, since this body sits inside a regular `FileCard`.
 *
 * Bytes arrive through a transport (`BlobLoader`) instead of directly from an endpoint. The gallery and tests use
 * a fixture, while the application uses `fetchBlob` with a token.
 */

export type ImageMode = 'two-up' | 'swipe' | 'onion' | 'diff' | 'text';
export type ImageFit = 'fit' | 'actual';

/**
 * Side rasterization for Diff mode uses canvas in the browser and a mock in jsdom and the gallery.
 * The browser version waits for a loaded `<img>`, so the result can also be a promise.
 */
export type Rasterize = (image: HTMLImageElement) => PixelSurface | Promise<PixelSurface>;

/** Diff computation uses the tab's worker in the browser and a direct `diffPixels` call in tests. */
export type ComputeDiff = (
    before: PixelSurface,
    after: PixelSurface,
    options: DiffPixelsOptions,
) => Promise<ImageDiffResult>;

/**
 * Initial card frame for the gallery and tests only. Reviewers switch modes by clicking.
 * Rasterization and computation mocks live here too, keeping Diff frames independent of canvas and the worker.
 */
export interface ImageBodyState {
    readonly mode?: ImageMode;
    readonly fit?: ImageFit;
    /** Swipe divider position as a percentage of width. */
    readonly swipe?: number;
    /** Onion Skin top side opacity as a percentage. */
    readonly onion?: number;
    readonly rasterize?: Rasterize;
    readonly computeDiff?: ComputeDiff;
}

export interface ImageBodyProps {
    readonly file: FileDiff;
    readonly image: FileImage;
    readonly loadBlob: BlobLoader;
    /** Diff lines for Text mode (svg). null means the file has no text patch. */
    readonly textBody?: ReactNode;
    readonly initial?: ImageBodyState | undefined;
}

interface ModeOption {
    readonly id: ImageMode;
    readonly label: 'image.mode.twoUp' | 'image.mode.swipe' | 'image.mode.onion' | 'image.mode.diff' | 'image.mode.text';
}

const MODE_OPTIONS: readonly ModeOption[] = [
    { id: 'two-up', label: 'image.mode.twoUp' },
    { id: 'swipe', label: 'image.mode.swipe' },
    { id: 'onion', label: 'image.mode.onion' },
    { id: 'diff', label: 'image.mode.diff' },
    { id: 'text', label: 'image.mode.text' },
];

/** Swipe divider keyboard step. */
const SWIPE_STEP = 2;

export function ImageBody({ file, image, loadBlob, textBody = null, initial }: ImageBodyProps) {
    const t = useT();
    const before = useImageSide(image.before, loadBlob);
    const after = useImageSide(image.after, loadBlob);
    const [mode, setMode] = useState<ImageMode>(initial?.mode ?? 'two-up');
    const [fit, setFit] = useState<ImageFit>(initial?.fit ?? 'fit');
    const [swipe, setSwipe] = useState(initial?.swipe ?? 50);
    const [onion, setOnion] = useState(initial?.onion ?? 50);
    const diff = useDiffCache();

    const bothSides = image.before !== null && image.after !== null;
    const hasText = textBody !== null;
    // Show raster upscaling in 1:1 as pixels. Doing this to svg only creates jagged edges.
    const pixelated = image.mime !== 'image/svg+xml';
    // Nothing to rasterize while either side lacks natural dimensions (svg without
    // width/height). That `<img>` would produce an empty canvas instead of a diff.
    const noSize = before.natural !== null && after.natural !== null && (before.natural.width === 0 || after.natural.width === 0);
    const options = MODE_OPTIONS.filter((option) => option.id !== 'text' || hasText).map((option) => ({
        ...option,
        reason: !bothSides
            ? option.id === 'swipe' || option.id === 'onion' || option.id === 'diff'
                ? t('image.mode.needBothSides')
                : null
            : option.id === 'diff' && noSize
              ? t('image.mode.noSize')
              : null,
    }));

    return (
        <div className="image-card">
            <div className="image-card__controls">
                <div className="image-card__modes" role="group" aria-label={t('image.mode.aria')}>
                    {options.map((option) => (
                        <button
                            key={option.id}
                            type="button"
                            className={`image-card__mode${option.id === mode ? ' is-active' : ''}`}
                            aria-pressed={option.id === mode}
                            disabled={option.reason !== null}
                            title={option.reason ?? undefined}
                            onClick={() => {
                                setMode(option.id);
                            }}
                        >
                            {t(option.label)}
                        </button>
                    ))}
                </div>
                <span className="image-card__spacer" />
                {mode === 'text' ? null : (
                    <button
                        type="button"
                        className={`image-card__mode image-card__mode--single${fit === 'actual' ? ' is-active' : ''}`}
                        aria-pressed={fit === 'actual'}
                        title={t(fit === 'actual' ? 'image.fit.toFitTitle' : 'image.fit.toActualTitle')}
                        onClick={() => {
                            setFit(fit === 'actual' ? 'fit' : 'actual');
                        }}
                    >
                        {t(fit === 'actual' ? 'image.fit.toFit' : 'image.fit.toActual')}
                    </button>
                )}
            </div>

            {mode === 'text' ? (
                textBody
            ) : mode === 'diff' ? (
                <PixelDiff
                    file={file}
                    image={image}
                    fit={fit}
                    pixelated={pixelated}
                    before={before}
                    after={after}
                    cache={diff}
                    rasterize={initial?.rasterize}
                    computeDiff={initial?.computeDiff}
                />
            ) : mode === 'swipe' || mode === 'onion' ? (
                <Overlay
                    file={file}
                    image={image}
                    mode={mode}
                    fit={fit}
                    pixelated={pixelated}
                    before={before}
                    after={after}
                    swipe={swipe}
                    onSwipe={setSwipe}
                    onion={onion}
                    onOnion={setOnion}
                />
            ) : (
                <div className="image-card__pair">
                    <SideColumn
                        file={file}
                        side="before"
                        model={image.before}
                        view={before}
                        fit={fit}
                        pixelated={pixelated}
                    />
                    <SideColumn
                        file={file}
                        side="after"
                        model={image.after}
                        view={after}
                        fit={fit}
                        pixelated={pixelated}
                    />
                </div>
            )}
        </div>
    );
}

/** Known side state: `missing` means a host 404, `tooLarge` means the side was never loaded. */
type SideState = 'idle' | 'loading' | 'ready' | 'missing' | 'error' | 'tooLarge';

interface SideLoad {
    readonly state: SideState;
    /** Object URL for the bytes, released on unmount and when `blobId` changes. */
    readonly url: string | null;
    readonly error: string | null;
}

interface SideView extends SideLoad {
    /** `naturalWidth`/`naturalHeight` after `onLoad`. null means the image has not rendered yet. */
    readonly natural: { readonly width: number; readonly height: number } | null;
    readonly retry: () => void;
    readonly onLoad: (event: SyntheticEvent<HTMLImageElement>) => void;
}

/**
 * Load one side. Each side has its own effect, running in parallel and once
 * per card. A side larger than `IMAGE_BLOB_MAX_BYTES` is never loaded.
 */
function useImageSide(side: ImageSide | null, loadBlob: BlobLoader): SideView {
    const blobId = side?.blobId ?? null;
    const size = side?.size ?? 0;
    const [attempt, setAttempt] = useState(0);
    // Attempt key. Changing sides or choosing Retry clears both the result and measured size
    // during render, avoiding a setState reset from an effect.
    const attemptKey = `${String(attempt)}:${blobId ?? ''}`;
    const [loaded, setLoaded] = useState<{ readonly key: string; readonly load: SideLoad } | null>(null);
    const [measured, setMeasured] = useState<{
        readonly key: string;
        readonly natural: { readonly width: number; readonly height: number };
    } | null>(null);
    const load = loaded?.key === attemptKey ? loaded.load : initialLoad(blobId, size);
    const natural = measured?.key === attemptKey ? measured.natural : null;

    useEffect(() => {
        if (blobId === null || size > IMAGE_BLOB_MAX_BYTES) {
            return;
        }

        let objectUrl: string | null = null;
        let cancelled = false;
        loadBlob(blobId).then(
            (blob) => {
                if (cancelled) {
                    return;
                }
                if (blob === null) {
                    setLoaded({ key: attemptKey, load: { state: 'missing', url: null, error: null } });
                    return;
                }
                objectUrl = URL.createObjectURL(blob);
                setLoaded({ key: attemptKey, load: { state: 'ready', url: objectUrl, error: null } });
            },
            (error: unknown) => {
                if (!cancelled) {
                    setLoaded({
                        key: attemptKey,
                        load: {
                            state: 'error',
                            url: null,
                            error: error instanceof Error ? error.message : String(error),
                        },
                    });
                }
            },
        );

        return () => {
            cancelled = true;
            if (objectUrl !== null) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, [attemptKey, blobId, loadBlob, size]);

    const retry = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);
    const onLoad = useCallback(
        (event: SyntheticEvent<HTMLImageElement>) => {
            const image = event.currentTarget;
            setMeasured({ key: attemptKey, natural: { width: image.naturalWidth, height: image.naturalHeight } });
        },
        [attemptKey],
    );

    return { ...load, natural, retry, onLoad };
}

/** Side state before any loading, also used for server rendering. */
function initialLoad(blobId: string | null, size: number): SideLoad {
    if (blobId === null) {
        return { state: 'idle', url: null, error: null };
    }
    if (size > IMAGE_BLOB_MAX_BYTES) {
        return { state: 'tooLarge', url: null, error: null };
    }
    return { state: 'loading', url: null, error: null };
}

/** 2-up column: side label, image on a checkerboard, dimensions and Download. */
function SideColumn({
    file,
    side,
    model,
    view,
    fit,
    pixelated,
}: {
    file: FileDiff;
    side: 'before' | 'after';
    model: ImageSide | null;
    view: SideView;
    fit: ImageFit;
    pixelated: boolean;
}) {
    const t = useT();
    const title = t(side === 'before' ? 'image.side.before' : 'image.side.after');

    if (model === null) {
        return (
            <div className="image-card__side">
                <p className="image-card__side-title">{title}</p>
                <p className="file-card__image-empty">{t('image.side.empty')}</p>
            </div>
        );
    }

    const dimensions = view.natural === null || view.natural.width === 0 ? null : t('image.dimensions', view.natural.width, view.natural.height);
    return (
        <div className="image-card__side">
            <p className="image-card__side-title">{title}</p>
            <div
                className={`image-card__frame${fit === 'actual' ? ' image-card__frame--actual' : ''}${
                    pixelated ? ' image-card__frame--pixelated' : ''
                }`}
            >
                {view.state === 'ready' && view.url !== null ? (
                    <img
                        className="image-card__image"
                        src={view.url}
                        alt={t(side === 'before' ? 'image.alt.before' : 'image.alt.after', file.path)}
                        onLoad={view.onLoad}
                    />
                ) : (
                    <SideStatus file={file} model={model} view={view} />
                )}
            </div>
            <p className="image-card__meta">
                {dimensions === null ? null : <span>{dimensions}</span>}
                <span>{formatBytes(model.size, t)}</span>
                {view.state === 'ready' && view.url !== null ? (
                    <a className="image-card__download" href={view.url} download={basename(file.path)}>
                        {t('image.download')}
                    </a>
                ) : null}
            </p>
        </div>
    );
}

/** States without a visible image: loading, 404, endpoint error and size refusal. */
function SideStatus({ file, model, view }: { file: FileDiff; model: ImageSide; view: SideView }) {
    const t = useT();
    if (view.state === 'tooLarge') {
        return (
            <p className="image-card__status">
                {t('image.tooLarge', formatBytes(model.size, t))}
                {file.hostFileUrl === null ? null : (
                    <a className="image-card__download" href={file.hostFileUrl} target="_blank" rel="noopener">
                        {t('image.openAtHost')}
                    </a>
                )}
            </p>
        );
    }
    if (view.state === 'error') {
        return (
            <p className="image-card__status" role="status">
                {t('image.failed', view.error ?? '')}
                <button type="button" className="image-card__retry" onClick={view.retry}>
                    {t('image.retry')}
                </button>
            </p>
        );
    }
    return (
        <p className="image-card__status">{t(view.state === 'missing' ? 'image.missing' : 'image.loading')}</p>
    );
}

/**
 * Swipe and Onion Skin put both sides in one box sized to fit them. Until both sides
 * arrive, show the same statuses as 2-up, or the mode would look empty.
 */
function Overlay({
    file,
    image,
    mode,
    fit,
    pixelated,
    before,
    after,
    swipe,
    onSwipe,
    onion,
    onOnion,
}: {
    file: FileDiff;
    image: FileImage;
    mode: 'swipe' | 'onion';
    fit: ImageFit;
    pixelated: boolean;
    before: SideView;
    after: SideView;
    swipe: number;
    onSwipe: (value: number) => void;
    onion: number;
    onOnion: (value: number) => void;
}) {
    const t = useT();
    const stageRef = useRef<HTMLDivElement | null>(null);

    const moveTo = useCallback(
        (clientX: number) => {
            const box = stageRef.current?.getBoundingClientRect();
            if (box === undefined || box.width === 0) {
                return;
            }
            onSwipe(clamp(((clientX - box.left) / box.width) * 100));
        },
        [onSwipe],
    );

    // The overlay box uses the larger dimensions. Each image takes its own share from the shared
    // top-left corner. Stretching both to fill the box would make sides of different resolutions
    // match pixel for pixel, so moving an asset to 2x would look like "nothing changed".
    const width = Math.max(before.natural?.width ?? 0, after.natural?.width ?? 0);
    const height = Math.max(before.natural?.height ?? 0, after.natural?.height ?? 0);
    const size = width === 0 || height === 0 ? undefined : { width, aspectRatio: `${String(width)} / ${String(height)}` };
    // Use a share of the box width and derive height from it. The box can be taller than its aspect
    // ratio (minimum height when dimensions are unknown), so a percentage height would stretch the image.
    const layerSize = (natural: SideView['natural']): CSSProperties | undefined =>
        natural === null || width === 0
            ? undefined
            : { width: `${String((natural.width / width) * 100)}%`, height: 'auto' };

    // Nothing to overlay until both sides arrive. Until then, show the same
    // status columns as 2-up.
    if (before.state !== 'ready' || after.state !== 'ready') {
        return (
            <div className="image-card__pair">
                <SideColumn file={file} side="before" model={image.before} view={before} fit={fit} pixelated={pixelated} />
                <SideColumn file={file} side="after" model={image.after} view={after} fit={fit} pixelated={pixelated} />
            </div>
        );
    }

    return (
        <div
            className={`image-card__overlay${fit === 'actual' ? ' image-card__overlay--actual' : ''}${
                pixelated ? ' image-card__overlay--pixelated' : ''
            }`}
        >
            <div
                className={`image-card__stage${size === undefined ? ' image-card__stage--unsized' : ''}`}
                ref={stageRef}
                style={size}
            >
                <img
                    className="image-card__layer"
                    src={before.url ?? undefined}
                    alt={t('image.alt.before', file.path)}
                    onLoad={before.onLoad}
                    style={layerSize(before.natural)}
                />
                {/* Apply clipping and opacity to the full-box layer instead of the image itself,
                    otherwise percentages would use its dimensions and drift away from the divider. */}
                <div
                    className="image-card__clip"
                    style={
                        mode === 'swipe'
                            ? { clipPath: `inset(0 ${String(100 - swipe)}% 0 0)` }
                            : { opacity: onion / 100 }
                    }
                >
                    <img
                        className="image-card__layer"
                        src={after.url ?? undefined}
                        alt={t('image.alt.after', file.path)}
                        onLoad={after.onLoad}
                        style={layerSize(after.natural)}
                    />
                </div>
                {mode === 'swipe' ? (
                    <div
                        className="image-card__divider"
                        style={{ left: `${String(swipe)}%` }}
                        role="slider"
                        tabIndex={0}
                        aria-label={t('image.swipe.aria')}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(swipe)}
                        onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
                            // `preventDefault` also prevents click focus. Without restoring it after dragging,
                            // ←/→ and Home/End would do nothing until the reviewer tabs to the divider.
                            event.preventDefault();
                            event.currentTarget.setPointerCapture(event.pointerId);
                            event.currentTarget.focus();
                            moveTo(event.clientX);
                        }}
                        onPointerMove={(event: ReactPointerEvent<HTMLDivElement>) => {
                            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
                                moveTo(event.clientX);
                            }
                        }}
                        onPointerUp={(event: ReactPointerEvent<HTMLDivElement>) => {
                            event.currentTarget.releasePointerCapture(event.pointerId);
                        }}
                        onKeyDown={(event) => {
                            const next = swipeByKey(event.key, swipe);
                            if (next !== null) {
                                event.preventDefault();
                                onSwipe(next);
                            }
                        }}
                    />
                ) : null}
            </div>

            {mode === 'onion' ? (
                <label className="image-card__slider">
                    {t('image.onion.label')}
                    <input
                        type="range"
                        min={0}
                        max={100}
                        value={onion}
                        onChange={(event) => {
                            onOnion(Number(event.currentTarget.value));
                        }}
                    />
                    <span className="image-card__slider-value">{t('image.onion.value', onion)}</span>
                </label>
            ) : null}
        </div>
    );
}

/**
 * Computation result for a pair of object URLs. The key separates a fresh result from a response for old bytes.
 * There is no separate "computing" state here. It is a key with no result yet.
 */
type DiffJob =
    | { readonly key: string; readonly state: 'ready'; readonly result: ImageDiffResult }
    | { readonly key: string; readonly state: 'error'; readonly error: string };

/**
 * Diff computation that survives leaving Diff mode, including both completed results and pending requests.
 * Lives in `ImageBody`, because `PixelDiff` unmounts when leaving the mode while the side
 * bytes stay the same.
 */
interface DiffCache {
    /** Attempt number. Retry changes the key, sending the pair for computation again. */
    readonly attempt: number;
    readonly job: DiffJob | null;
    readonly setJob: (job: DiffJob) => void;
    readonly requestRef: RefObject<{ readonly key: string; readonly promise: Promise<ImageDiffResult> } | null>;
    readonly retry: () => void;
}

function useDiffCache(): DiffCache {
    const [attempt, setAttempt] = useState(0);
    const [job, setJob] = useState<DiffJob | null>(null);
    const requestRef = useRef<{ readonly key: string; readonly promise: Promise<ImageDiffResult> } | null>(null);
    const retry = useCallback(() => {
        setAttempt((value) => value + 1);
    }, []);
    return { attempt, job, setJob, requestRef, retry };
}

/**
 * Diff mode rasterizes both sides into `ImageData` and sends them to a worker. The result
 * renders in the same box as Swipe layers. Computation is lazy, so a 2-up card starts no worker.
 */
function PixelDiff({
    file,
    image,
    fit,
    pixelated,
    before,
    after,
    cache,
    rasterize,
    computeDiff,
}: {
    file: FileDiff;
    image: FileImage;
    fit: ImageFit;
    pixelated: boolean;
    before: SideView;
    after: SideView;
    cache: DiffCache;
    rasterize: Rasterize | undefined;
    computeDiff: ComputeDiff | undefined;
}) {
    const t = useT();
    const beforeRef = useRef<HTMLImageElement | null>(null);
    const afterRef = useRef<HTMLImageElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const { attempt, job, setJob, requestRef, retry } = cache;

    const beforeNatural = before.natural;
    const afterNatural = after.natural;
    const noSize = beforeNatural !== null && afterNatural !== null && (beforeNatural.width === 0 || afterNatural.width === 0);
    const sized = beforeNatural !== null && afterNatural !== null && !noSize;
    // Keep the result while the object URLs stay the same. There is no reason to recompute the same bytes
    // on every return to Diff. Retry changes the key and starts computation again.
    const key = `${String(attempt)} ${before.url ?? ''} ${after.url ?? ''}`;
    const current = job?.key === key ? job : null;

    useEffect(() => {
        const beforeImage = beforeRef.current;
        const afterImage = afterRef.current;
        if (!sized || beforeImage === null || afterImage === null) {
            return;
        }

        let cancelled = false;
        // Wait for a pending computation of the same pair. Leaving for 2-up and returning
        // to Diff must not cost another rasterization and another worker round trip.
        let pending = requestRef.current?.key === key ? requestRef.current.promise : null;
        if (pending === null) {
            // Rasterization waits for the loaded element and can throw (if the browser provides no canvas).
            // The async wrapper sends its failure through the same path as a worker failure.
            pending = (async (): Promise<ImageDiffResult> => {
                const read = rasterize ?? rasterizeWithCanvas;
                const compute = computeDiff ?? sharedImageDiffClient().compute;
                const [beforeSurface, afterSurface] = await Promise.all([read(beforeImage), read(afterImage)]);
                return compute(beforeSurface, afterSurface, { accent: accentColor() });
            })();
            requestRef.current = { key, promise: pending };
        }

        pending.then(
            (result) => {
                if (!cancelled) {
                    setJob({ key, state: 'ready', result });
                }
            },
            (error: unknown) => {
                if (!cancelled) {
                    setJob({ key, state: 'error', error: messageOf(error) });
                }
            },
        );

        // Do not write a cancelled request's response anywhere. The worker is shared, and interrupting it for one
        // unmounted card costs more than letting it finish. The result will wait in `requestRef`.
        return () => {
            cancelled = true;
        };
    }, [key, sized, rasterize, computeDiff, requestRef, setJob]);

    const result = current?.state === 'ready' ? current.result : null;
    useEffect(() => {
        const canvas = canvasRef.current;
        if (canvas === null || result === null) {
            return;
        }
        canvas.width = result.width;
        canvas.height = result.height;
        const context = canvas.getContext('2d');
        if (context === null) {
            return;
        }
        // Use `createImageData`, since jsdom has no global `ImageData` constructor.
        const frame = context.createImageData(result.width, result.height);
        frame.data.set(result.data);
        context.putImageData(frame, 0, 0);
    }, [result]);

    // Nothing to compute until both sides arrive. Until then, show the same
    // status columns as 2-up.
    if (before.state !== 'ready' || after.state !== 'ready') {
        return (
            <div className="image-card__pair">
                <SideColumn file={file} side="before" model={image.before} view={before} fit={fit} pixelated={pixelated} />
                <SideColumn file={file} side="after" model={image.after} view={after} fit={fit} pixelated={pixelated} />
            </div>
        );
    }

    // Use the larger side dimensions, as overlays do. The diff is computed over the same rectangle.
    const width = Math.max(beforeNatural?.width ?? 0, afterNatural?.width ?? 0);
    const height = Math.max(beforeNatural?.height ?? 0, afterNatural?.height ?? 0);
    const size = width === 0 || height === 0 ? undefined : { width, aspectRatio: `${String(width)} / ${String(height)}` };
    const percent = result === null || result.total === 0 ? 0 : (result.changed / result.total) * 100;

    return (
        <div
            className={`image-card__overlay${fit === 'actual' ? ' image-card__overlay--actual' : ''}${
                pixelated ? ' image-card__overlay--pixelated' : ''
            }`}
        >
            <div
                className={`image-card__stage${size === undefined ? ' image-card__stage--unsized' : ''}`}
                style={size}
            >
                {/* Rasterization sources. `drawImage` needs a loaded element, but showing it
                    alongside the diff would be wrong, so keep the pair hidden. */}
                <img
                    ref={beforeRef}
                    className="image-card__source"
                    src={before.url ?? undefined}
                    alt=""
                    aria-hidden
                    onLoad={before.onLoad}
                />
                <img
                    ref={afterRef}
                    className="image-card__source"
                    src={after.url ?? undefined}
                    alt=""
                    aria-hidden
                    onLoad={after.onLoad}
                />
                {result === null ? null : (
                    <canvas
                        ref={canvasRef}
                        className="image-card__layer image-card__diff"
                        role="img"
                        aria-label={t('image.diff.alt', file.path)}
                    />
                )}
            </div>

            <p className="image-card__meta" role="status">
                {noSize ? (
                    <span>{t('image.mode.noSize')}</span>
                ) : current === null ? (
                    <span>{t('image.diff.busy')}</span>
                ) : current.state === 'error' ? (
                    <>
                        <span>{t('image.diff.failed', current.error)}</span>
                        <button type="button" className="image-card__retry" onClick={retry}>
                            {t('image.retry')}
                        </button>
                    </>
                ) : (
                    <>
                        <span>{t('image.diff.summary', percent, current.result.changed, current.result.total)}</span>
                        {current.result.sizeMismatch && beforeNatural !== null && afterNatural !== null ? (
                            <span>
                                {t(
                                    'image.diff.sizeMismatch',
                                    beforeNatural.width,
                                    beforeNatural.height,
                                    afterNatural.width,
                                    afterNatural.height,
                                )}
                            </span>
                        ) : null}
                    </>
                )}
            </p>
        </div>
    );
}

/** Canvas rasterization, the only part of the card that needs a browser. */
async function rasterizeWithCanvas(image: HTMLImageElement): Promise<PixelSurface> {
    await whenDrawable(image);
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    if (context === null) {
        throw new Error(activeT()('image.diff.noCanvas'));
    }
    context.drawImage(image, 0, 0);
    const frame = context.getImageData(0, 0, canvas.width, canvas.height);
    return { width: frame.width, height: frame.height, data: frame.data };
}

/**
 * Wait for a frame before `drawImage`. It silently draws nothing for an unloaded element, which
 * would give a zero diff instead of an error. Usually the same bytes were just shown in 2-up, so
 * there is nothing to wait for. A decode failure becomes a computation error with Retry.
 */
async function whenDrawable(image: HTMLImageElement): Promise<void> {
    if (image.complete && image.naturalWidth > 0) {
        return;
    }
    await image.decode();
}

/** Fallback accent. The diff must stay visible even when the token cannot be read. */
const FALLBACK_ACCENT: readonly [number, number, number] = [255, 138, 61];

/** Changed pixels use the computed `--accent` token, so the theme sets the diff color. */
function accentColor(): [number, number, number] {
    if (typeof document === 'undefined') {
        return [...FALLBACK_ACCENT];
    }
    const raw = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
    return parseColor(raw) ?? [...FALLBACK_ACCENT];
}

/** `#abc`, `#aabbcc`, `rgb(…)`/`rgba(…)` are the forms browsers return for the computed token. */
export function parseColor(raw: string): [number, number, number] | null {
    const hex = /^#([\da-f]{3}|[\da-f]{6})$/iu.exec(raw);
    if (hex !== null) {
        const digits = hex[1] ?? '';
        const step = digits.length === 3 ? 1 : 2;
        const channel = (index: number): number => {
            const part = digits.slice(index * step, index * step + step);
            return Number.parseInt(step === 1 ? part + part : part, 16);
        };
        return [channel(0), channel(1), channel(2)];
    }

    const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/iu.exec(raw);
    if (rgb === null) {
        return null;
    }
    const channels: [number, number, number] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
    return channels.some((value) => Number.isNaN(value)) ? null : channels;
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Divider keyboard controls: ←/→ by 2 %, Home/End to the edges. `null` means an unrelated key. */
export function swipeByKey(key: string, current: number): number | null {
    if (key === 'ArrowLeft') {
        return clamp(current - SWIPE_STEP);
    }
    if (key === 'ArrowRight') {
        return clamp(current + SWIPE_STEP);
    }
    if (key === 'Home') {
        return 0;
    }
    if (key === 'End') {
        return 100;
    }
    return null;
}

function clamp(value: number): number {
    return Math.min(100, Math.max(0, value));
}

/** "1,023 B", "12.4 KB", "1.2 MB": grouping and decimal separators come from the locale, words from the dictionary. */
export function formatBytes(bytes: number, t: Translate): string {
    if (bytes < 1024) {
        return t('image.size.bytes', bytes);
    }
    if (bytes < 1024 * 1024) {
        return t('image.size.kilobytes', bytes / 1024);
    }
    return t('image.size.megabytes', bytes / (1024 * 1024));
}

/** File name for `download`. The browser will not preserve the full path anyway. */
function basename(path: string): string {
    const cut = path.lastIndexOf('/');
    return cut === -1 ? path : path.slice(cut + 1);
}
