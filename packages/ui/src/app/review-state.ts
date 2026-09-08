/**
 * Tab review data state and pure transitions between its keys. Changes to the PR, host
 * or selected iteration are handled only here, without React.
 */
import type {
    Iteration,
    PrDiff,
    RouteSnapshot,
    Thread,
    UiReviewLensesResponse,
    UiReviewProgressResponse,
    UiRoutePhase,
    UiRouteState,
    UiSnapshotSummary,
    UiTask,
} from '@sherpa/protocol';

import type { Translate } from '../i18n/index.js';

/** A generation or cancellation endpoint failed. The phase is the one when the reviewer clicked. */
export interface RouteActionFailure {
    readonly phase: UiRoutePhase | null;
    readonly message: string;
}

/** PR snapshot list. `list === null` in loaded state means the server has no endpoint. */
export interface SnapshotsState {
    readonly key: string;
    readonly list: readonly UiSnapshotSummary[] | null;
    readonly loaded: boolean;
}

/**
 * Known facts about the active PR iteration. Collected only from responses without parameters and kept
 * separate from tab data. Selecting a previous iteration must not erase the facts used
 * to resolve that very selection (read-only mode, labels, fallback snapshot list).
 */
export interface ActiveFacts {
    readonly key: string;
    readonly diffId: string | null;
    readonly commit: string | null;
    readonly snapshot: RouteSnapshot | null;
    /** The route endpoint without parameters has already responded, including with a rejection. */
    readonly routeSettled: boolean;
}

export interface ReviewState {
    readonly key: string;
    /** Key of the selected iteration. Reload the diff, progress and route when it changes. */
    readonly viewKey: string;
    readonly diff: PrDiff | null;
    readonly lenses: UiReviewLensesResponse | null;
    readonly progress: UiReviewProgressResponse | null;
    readonly threads: readonly Thread[] | null;
    readonly route: UiRouteState | null;
    readonly diffError: string | null;
    readonly lensesError: string | null;
    readonly progressError: string | null;
    readonly threadsError: string | null;
    readonly routeError: string | null;
    readonly diffLoading: boolean;
    readonly lensesLoading: boolean;
    readonly progressLoading: boolean;
    readonly threadsLoading: boolean;
    readonly routeLoading: boolean;
}

const EMPTY_SLICE_LENSES: UiReviewLensesResponse = { ownership: null, extra: [] };
const EMPTY_SLICE_PROGRESS: UiReviewProgressResponse = { files: [], stops: [], progressRevision: 0 };

/**
 * Tab state in a slice: lenses, progress and threads are replaced with empty values. Their endpoints
 * are never called because this data refers to iteration `fileId` values that a slice does not have.
 */
export function sliceReviewState(current: ReviewState): ReviewState {
    return {
        ...current,
        lenses: EMPTY_SLICE_LENSES,
        lensesError: null,
        lensesLoading: false,
        progress: EMPTY_SLICE_PROGRESS,
        progressError: null,
        progressLoading: false,
        threads: EMPTY_THREADS,
        threadsError: null,
        threadsLoading: false,
    };
}

export function emptyReviewState(key: string, viewKey: string, loading: boolean): ReviewState {
    return {
        key,
        viewKey,
        diff: null,
        lenses: null,
        progress: null,
        threads: null,
        route: null,
        diffError: null,
        lensesError: null,
        progressError: null,
        threadsError: null,
        routeError: null,
        diffLoading: loading,
        lensesLoading: loading,
        progressLoading: loading,
        threadsLoading: loading,
        routeLoading: loading,
    };
}

/**
 * Changing the PR or host resets everything. Changing the selected iteration resets only the diff, progress and route:
 * threads and lenses belong to the host and are shared across the PR. Old data never appears as new data.
 * The view shows a loading skeleton instead (docs/design/SPEC-elements.md §3).
 */
/**
 * PR-wide layers (lenses, threads) do not depend on the selected iteration and must not overwrite
 * `viewKey`. A response that lags behind a selection change could roll back an already loaded diff.
 */
export function sharedReviewState(current: ReviewState, key: string, viewKey: string): ReviewState {
    return current.key === key ? current : emptyReviewState(key, viewKey, true);
}

export function reviewStateForKeys(current: ReviewState, key: string, viewKey: string): ReviewState {
    if (current.key !== key) {
        return emptyReviewState(key, viewKey, true);
    }
    if (current.viewKey === viewKey) {
        return current;
    }
    return {
        ...current,
        viewKey,
        diff: null,
        progress: null,
        route: null,
        diffError: null,
        progressError: null,
        routeError: null,
        diffLoading: true,
        progressLoading: true,
        routeLoading: true,
    };
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function hostDisplayName(host: string, t: Translate): string {
    if (host === 'github') {
        return t('host.github');
    }
    return host === 'fixture' ? 'FixtureHost' : host;
}

export function emptySnapshots(key: string): SnapshotsState {
    return { key, list: null, loaded: false };
}

export function emptyActiveFacts(key: string): ActiveFacts {
    return { key, diffId: null, commit: null, snapshot: null, routeSettled: false };
}

export const EMPTY_THREADS: readonly Thread[] = [];
export const EMPTY_ITERATIONS: readonly Iteration[] = [];
export const EMPTY_TASKS: readonly UiTask[] = [];
