import type { FileDiff, FileImage, ImageSide } from '@sherpa/protocol';
import { IMAGE_BLOB_MAX_BYTES } from '@sherpa/protocol';
import type { CSSProperties, PointerEvent as ReactPointerEvent, ReactNode, SyntheticEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import type { Translate } from '../i18n/index.js';
import { useT } from '../i18n/index.js';
import type { BlobLoader } from './blob-loader.tsx';
import './image-card.css';

/**
 * Image card body (M5-T24, requested by Alice Ingram from the review host): replaces the "binary file
 * not shown" notice with sides next to each other and ways to compare them. The header, Viewed, menu and folds
 * stay shared, since this body sits inside a regular `FileCard`.
 *
 * Bytes arrive through a transport (`BlobLoader`) instead of directly from an endpoint. The gallery and tests use
 * a fixture, while the application uses `fetchBlob` with a token.
 */

export type ImageMode = 'two-up' | 'swipe' | 'onion' | 'diff' | 'text';
export type ImageFit = 'fit' | 'actual';

/** Initial card state, gallery only: reviewers switch modes by clicking. */
export interface ImageBodyState {
    readonly mode?: ImageMode;
    readonly fit?: ImageFit;
    /** Swipe divider position as a percentage of width. */
    readonly swipe?: number;
    /** Onion Skin top side opacity as a percentage. */
    readonly onion?: number;
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

    const bothSides = image.before !== null && image.after !== null;
    const hasText = textBody !== null;
    // Show raster upscaling in 1:1 as pixels. Doing this to svg only creates jagged edges.
    const pixelated = image.mime !== 'image/svg+xml';
    const options = MODE_OPTIONS.filter((option) => option.id !== 'text' || hasText).map((option) => ({
        ...option,
        // `Diff` belongs to T25: keep its button here so the mode row does not shift when it arrives.
        reason:
            option.id === 'diff'
                ? t('image.mode.diffLater')
                : (option.id === 'swipe' || option.id === 'onion') && !bothSides
                  ? t('image.mode.needBothSides')
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
