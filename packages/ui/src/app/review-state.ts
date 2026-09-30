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
import { LOCAL_VCS_KINDS, localHostName } from '@sherpa/protocol';

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

const EMPTY_SLICE_LENSES: UiReviewLensesResponse = { ownership: null, extra: [], ownershipSource: null };

/** Placeholder slice progress belongs to the slice itself. The server never returns progress for it. */
function emptySliceProgress(diff: PrDiff | null): UiReviewProgressResponse {
    return { diffId: diff?.diffId ?? '', files: [], stops: [], progressRevision: 0 };
}

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
        progress: emptySliceProgress(current.diff),
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

const LOCAL_HOSTS: readonly string[] = LOCAL_VCS_KINDS.map(localHostName);

/**
 * Local review (`local-git`) in `uiState.reviewHost` has no PR,
 * so the UI uses its own wording for gone iterations, stale routes and comment delivery.
 * The reviewer does not need to know which VCS the checkout uses.
 */
export function isLocalHost(host: string | null): boolean {
    return host !== null && LOCAL_HOSTS.includes(host);
}

export function hostDisplayName(host: string, t: Translate): string {
    if (host === 'github') {
        return t('host.github');
    }
    if (isLocalHost(host)) {
        return t('host.local');
    }
    if (host === 'github') {
        return t('host.github');
    }
    return host === 'fixture' ? 'FixtureHost' : host;
}

/**
 * The file menu item label for opening `blameUrl` names GitHub explicitly.
 * Other hosts (fixtures and local checkouts without a link) use generic wording.
 */
export function fileWebActionLabel(host: string | null, t: Translate): string {
    if (host === 'github') {
        
    }
    if (host === 'github') {
        return t('file.menu.openGithub');
    }
    return t('file.menu.openWeb');
}

/** Where published drafts go: to the hosted PR or into an agent task (local review has no PR). */
export type DraftDestination = 'pr' | 'agent';

export function draftDestinationOf(reviewHost: string): DraftDestination {
    return isLocalHost(reviewHost) ? 'agent' : 'pr';
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
