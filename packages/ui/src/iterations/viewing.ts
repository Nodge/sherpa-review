import type { Iteration, Locale, RouteSnapshot, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';

/**
 * What the tab displays (M4-T9): current PR state, a previous route snapshot, an iteration
 * without a route, or a slice between 2 iterations (M4-T12). The selection lives on the client in the
 * URL fragment. The server is not asked for the "current view" (`uiReviewDiffRequestSchema` contract).
 *
 * Resolving the selection is a pure function: it takes the snapshot list, iterations, current route
 * and what App already knows about the active iteration. It returns endpoint parameters, read-only mode
 * and the pill label.
 */

export type Viewing =
    | { readonly kind: 'current' }
    | { readonly kind: 'snapshot'; readonly snapshotId: string }
    | { readonly kind: 'diff'; readonly diffId: string }
    /** Slice between iterations: `base` is a saved iteration, `head` is always active. */
    | { readonly kind: 'slice'; readonly base: string; readonly head: string };

export const VIEWING_CURRENT: Viewing = { kind: 'current' };

/** Slice diff endpoint parameters, also kept in the URL fragment by the UI. */
export interface ViewingSlice {
    readonly base: string;
    readonly head: string;
}

/**
 * With several URL parameters, `snapshot` takes precedence over a slice, and a slice over `diff` (task breakdown
 * M4-T9: selections are mutually exclusive). A slice missing either half is ignored entirely.
 */
export function parseViewing(
    snapshotId: string | null,
    diffId: string | null,
    base: string | null = null,
    head: string | null = null,
): Viewing {
    if (snapshotId !== null && snapshotId !== '') {
        return { kind: 'snapshot', snapshotId };
    }
    if (base !== null && base !== '' && head !== null && head !== '') {
        return { kind: 'slice', base, head };
    }
    return diffId !== null && diffId !== '' ? { kind: 'diff', diffId } : VIEWING_CURRENT;
}

export interface ViewingFragment {
    readonly snapshot: string | null;
    readonly diff: string | null;
    readonly base: string | null;
    readonly head: string | null;
}

/** What to write to the fragment: `current` stays out of the URL. */
export function viewingFragment(viewing: Viewing): ViewingFragment {
    const empty: ViewingFragment = { snapshot: null, diff: null, base: null, head: null };
    if (viewing.kind === 'snapshot') {
        return { ...empty, snapshot: viewing.snapshotId };
    }
    if (viewing.kind === 'diff') {
        return { ...empty, diff: viewing.diffId };
    }
    return viewing.kind === 'slice' ? { ...empty, base: viewing.base, head: viewing.head } : empty;
}

/**
 * Fragment update on selection change: clear anchor keys from another diff, because file, side,
 * lines, thread and stop may reference things absent from the new selection.
 */
export function viewingFragmentPatch(
    viewing: Viewing,
    previous: Viewing,
): Readonly<Record<string, string | null>> {
    const fragment: Readonly<Record<string, string | null>> = { ...viewingFragment(viewing) };
    if (sameViewing(viewing, previous)) {
        return fragment;
    }
    return { ...fragment, file: null, side: null, line: null, end: null, thread: null, stop: null };
}

export function sameViewing(left: Viewing, right: Viewing): boolean {
    if (left.kind !== right.kind) {
        return false;
    }
    if (left.kind === 'snapshot' && right.kind === 'snapshot') {
        return left.snapshotId === right.snapshotId;
    }
    if (left.kind === 'diff' && right.kind === 'diff') {
        return left.diffId === right.diffId;
    }
    if (left.kind === 'slice' && right.kind === 'slice') {
        return left.base === right.base && left.head === right.head;
    }
    return true;
}

/** Pill label: `current` / `stale` / `commit no longer in the PR` / `no route` / `slice`. */
export type ViewingStatus = 'current' | 'stale' | 'gone' | 'noRoute' | 'slice';

export type ViewingLabel =
    | { readonly kind: 'snapshot' | 'diff'; readonly commit: string; readonly status: ViewingStatus }
    /** A slice has 2 sides: `commit` is the active iteration, `baseCommit` is the starting point. */
    | {
          readonly kind: 'slice';
          readonly commit: string;
          readonly baseCommit: string;
          readonly status: 'slice';
      };

export interface ResolvedViewing {
    /** Normalized selection: an unknown id becomes `current`. */
    readonly viewing: Viewing;
    /** `diffId` parameter of diff and progress endpoints. null means the active iteration, with no parameter. */
    readonly diffId: string | null;
    /** `snapshot` parameter of the route endpoint. null means the current route state. */
    readonly snapshotId: string | null;
    readonly readOnly: boolean;
    readonly gone: boolean;
    readonly label: ViewingLabel | null;
    /** Time of the selected snapshot or iteration. null means unknown. */
    readonly createdAt: string | null;
    /** Selection absent from both the list and current state, so the URL needs cleanup. */
    readonly unknown: boolean;
    /** The snapshot list has not arrived yet, so parameters are unknown and data is not loaded. */
    readonly pending: boolean;
    /** The "Route" tab shows an iteration without a route. */
    readonly routeless: boolean;
    /** The tab shows a slice, loaded through the `base`/`head` endpoint, with no progress or lenses. */
    readonly slice: ViewingSlice | null;
}

export interface ViewingInput {
    readonly viewing: Viewing;
    /** PR snapshots in creation order. If the endpoint fails, a list containing only the current snapshot. */
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** The loaded route. For `current`/`diff` selections, this is the current route. */
    readonly route: UiRouteState | null;
    /**
     * Active iteration, if already seen. Knowledge of it comes from responses
     * without parameters and does not depend on what the tab is viewing. Otherwise selecting a previous iteration
     * would erase the facts needed to resolve that selection.
     */
    readonly activeDiffId: string | null;
    /** Active iteration commit from the same source as `activeDiffId`. */
    readonly activeCommit: string | null;
    /** The snapshot list has responded, including with a failure. */
    readonly snapshotsLoaded: boolean;
    /** Endpoints without parameters have responded, including with a failure, so the active iteration is known. */
    readonly activeLoaded: boolean;
}

const CURRENT_BASE = {
    diffId: null,
    snapshotId: null,
    readOnly: false,
    gone: false,
    unknown: false,
    pending: false,
    routeless: false,
    slice: null,
} as const;

export function resolveViewing(input: ViewingInput): ResolvedViewing {
    const currentLabel = labelOfCurrentRoute(input.route);
    const current: ResolvedViewing = {
        ...CURRENT_BASE,
        viewing: VIEWING_CURRENT,
        label: currentLabel,
        createdAt: input.route?.snapshot?.createdAt ?? null,
    };
    if (input.viewing.kind === 'current') {
        return current;
    }
    // Wait for the snapshot list and facts about the active iteration. Without them,
    // a URL selection looks unknown, and read-only mode cannot be distinguished from the active iteration.
    if (!input.snapshotsLoaded || !input.activeLoaded) {
        return { ...current, viewing: input.viewing, pending: true };
    }

    const active = activeIterationDiffId(input);
    if (input.viewing.kind === 'slice') {
        return resolveSlice(input.viewing, input, active, current);
    }
    if (input.viewing.kind === 'snapshot') {
        const { snapshotId } = input.viewing;
        const summary = input.snapshots.find((candidate) => candidate.snapshotId === snapshotId) ?? null;
        if (summary === null) {
            return { ...current, unknown: true };
        }
        // Selecting the current snapshot is equivalent to `current`, using the same endpoints without parameters.
        if (summary.status === 'current') {
            return { ...current, viewing: input.viewing };
        }
        return {
            viewing: input.viewing,
            diffId: summary.diffId,
            snapshotId,
            readOnly: active === null || summary.diffId !== active,
            gone: summary.status === 'gone',
            label: { kind: 'snapshot', commit: summary.commit, status: summary.status },
            createdAt: summary.createdAt,
            unknown: false,
            pending: false,
            routeless: false,
            slice: null,
        };
    }

    const { diffId } = input.viewing;
    const iteration = input.iterations.find((candidate) => candidate.diffId === diffId) ?? null;
    const commit = commitOfDiff(diffId, input);
    if (commit === null) {
        return { ...current, unknown: true };
    }
    // Route for the iteration without parameters: the current snapshot may or may not have been built on it.
    const routeSnapshot = input.route?.snapshot ?? null;
    const onRoute = routeSnapshot !== null && routeSnapshot.diffId === diffId;
    // The active iteration uses the same endpoints without parameters. A parameter would only
    // reload data already loaded. The selection stays in the URL to label the iteration.
    const isActive = active !== null && diffId === active;
    return {
        viewing: input.viewing,
        diffId: isActive ? null : diffId,
        snapshotId: null,
        readOnly: !isActive,
        gone: iteration?.status === 'gone',
        label: onRoute
            ? { kind: 'snapshot', commit: routeSnapshot.commit, status: input.route?.stale == null ? 'current' : 'stale' }
            : { kind: 'diff', commit, status: 'noRoute' },
        createdAt: iteration?.createdAt ?? null,
        unknown: false,
        pending: false,
        routeless: !onRoute,
        slice: null,
    };
}

/**
 * Slice between iterations: `base` is a saved iteration from the list, `head` is always active.
 * Any other URL combination is invalid (a force-push rewrote the iteration, or the URL came from another
 * tab). Like an unknown snapshot, the selection is cleared and the tab returns to the active iteration.
 */
function resolveSlice(
    viewing: { readonly kind: 'slice'; readonly base: string; readonly head: string },
    input: ViewingInput,
    active: string | null,
    current: ResolvedViewing,
): ResolvedViewing {
    const { base, head } = viewing;
    const baseIteration = input.iterations.find((candidate) => candidate.diffId === base) ?? null;
    const headCommit = commitOfDiff(head, input);
    if (baseIteration === null || headCommit === null || base === head || active === null || head !== active) {
        return { ...current, unknown: true };
    }
    return {
        viewing,
        diffId: head,
        snapshotId: null,
        readOnly: true,
        gone: false,
        label: { kind: 'slice', commit: headCommit, baseCommit: baseIteration.headCommit, status: 'slice' },
        createdAt: baseIteration.createdAt,
        unknown: false,
        pending: false,
        // No route is built for a slice. It is "what is new" without AI (brief, principle 1).
        routeless: true,
        slice: { base, head },
    };
}

/**
 * Active iteration: use the iteration list, then what the current route knows
 * (`stale.prDiffId` or its snapshot iteration), then the diff returned without parameters.
 */
export function activeIterationDiffId(
    input: Pick<ViewingInput, 'iterations' | 'activeDiffId'>,
): string | null {
    return input.iterations.find((iteration) => iteration.status === 'active')?.diffId ?? input.activeDiffId;
}

/**
 * Commit of the selected iteration: use the iteration list, a snapshot on it, facts about the active
 * iteration, or `stale` from the current route. Active iteration facts take precedence over the route in
 * tab state: the route reloads when the selection changes, while those facts do not.
 */
function commitOfDiff(diffId: string, input: ViewingInput): string | null {
    const iteration = input.iterations.find((candidate) => candidate.diffId === diffId);
    if (iteration !== undefined) {
        return iteration.headCommit;
    }
    const summary = input.snapshots.find((candidate) => candidate.diffId === diffId);
    if (summary !== undefined) {
        return summary.commit;
    }
    if (input.activeDiffId === diffId && input.activeCommit !== null) {
        return input.activeCommit;
    }
    const stale = input.route?.stale ?? null;
    if (stale !== null && stale.prDiffId === diffId) {
        return stale.prCommit;
    }
    return input.route?.snapshot?.diffId === diffId ? input.route.snapshot.commit : null;
}

/** Current-state pill: `stale` while the PR is ahead of the snapshot (README §1). */
function labelOfCurrentRoute(route: UiRouteState | null): ViewingLabel | null {
    const snapshot = route?.snapshot ?? null;
    if (snapshot === null) {
        return null;
    }
    return { kind: 'snapshot', commit: snapshot.commit, status: route?.stale == null ? 'current' : 'stale' };
}

/**
 * Snapshot list when the `reviewSnapshots` endpoint did not respond (the server does not support it yet):
 * one current snapshot built from route state. This UI cannot access previous snapshots,
 * so a selection from the URL will be unknown and cleared.
 */
export function fallbackSnapshots(snapshot: RouteSnapshot | null): readonly UiSnapshotSummary[] {
    if (snapshot === null) {
        return [];
    }
    return [
        {
            snapshotId: snapshot.snapshotId,
            diffId: snapshot.diffId,
            commit: snapshot.commit,
            baseCommit: snapshot.baseCommit,
            createdAt: snapshot.createdAt,
            provenance: snapshot.provenance,
            previousSnapshotId: snapshot.previousSnapshotId,
            status: 'current',
        },
    ];
}

/**
 * Picker row: one per snapshot, one per iteration without a snapshot, and one per slice
 * from a saved iteration to the active one.
 */
export interface PickerRow {
    readonly kind: 'snapshot' | 'diff' | 'slice';
    /** `snapshotId` or `diffId`, used for the selection and `data-*` in e2e. */
    readonly id: string;
    readonly diffId: string;
    readonly commit: string;
    /** null means the time is unknown (an iteration from `stale`). */
    readonly createdAt: string | null;
    readonly model: string | null;
    readonly harness: string | null;
    /** Snapshot generation language. null means an iteration without a route or a pre-M5 snapshot. */
    readonly locale: Locale | null;
    readonly status: ViewingStatus | 'activeIteration' | 'previousIteration';
    /** Slice head (active iteration commit). Null for other rows. */
    readonly toCommit: string | null;
    readonly viewing: Viewing;
}

export interface PickerRowsInput {
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Active PR iteration from App facts, independent of what the tab is viewing. */
    readonly activeIteration: { readonly diffId: string; readonly commit: string } | null;
    /**
     * The host supports iterations (`pr.capabilities.iterations`). Otherwise the slice endpoint returns 400,
     * leaving no slices to offer.
     */
    readonly interdiff?: boolean;
}

export interface PickerRows {
    readonly snapshots: readonly PickerRow[];
    readonly iterations: readonly PickerRow[];
    /** "Show changes since iteration…": a slice from each qualifying iteration to the active one. */
    readonly slices: readonly PickerRow[];
}

/**
 * Picker rows: snapshots newest first, followed by iterations without snapshots.
 * Even an empty iteration list yields the active iteration row if it has no snapshot:
 * its `diffId` and commit are known from the route fetched without parameters (the server sends `iterations: []`
 * before M4-T4).
 */
export function pickerRows(input: PickerRowsInput): PickerRows {
    const snapshots = [...input.snapshots].reverse().map(
        (summary): PickerRow => ({
            kind: 'snapshot',
            id: summary.snapshotId,
            diffId: summary.diffId,
            commit: summary.commit,
            createdAt: summary.createdAt,
            model: summary.provenance.model,
            harness: summary.provenance.harness,
            locale: summary.provenance.locale,
            status: summary.status,
            toCommit: null,
            viewing: { kind: 'snapshot', snapshotId: summary.snapshotId },
        }),
    );

    const withSnapshot = new Set(input.snapshots.map((summary) => summary.diffId));
    const iterations = input.iterations
        .filter((iteration) => !withSnapshot.has(iteration.diffId))
        .map(
            (iteration): PickerRow => ({
                kind: 'diff',
                id: iteration.diffId,
                diffId: iteration.diffId,
                commit: iteration.headCommit,
                createdAt: iteration.createdAt,
                model: null,
                harness: null,
                locale: null,
                status:
                    iteration.status === 'active'
                        ? 'activeIteration'
                        : iteration.status === 'gone'
                          ? 'gone'
                          : 'previousIteration',
                toCommit: null,
                viewing: { kind: 'diff', diffId: iteration.diffId },
            }),
        )
        .reverse();

    const active = input.activeIteration;
    if (iterations.length === 0 && active !== null && !withSnapshot.has(active.diffId)) {
        iterations.push({
            kind: 'diff',
            id: active.diffId,
            diffId: active.diffId,
            commit: active.commit,
            createdAt: null,
            model: null,
            harness: null,
            locale: null,
            status: 'activeIteration',
            toCommit: null,
            viewing: { kind: 'diff', diffId: active.diffId },
        });
    }

    return { snapshots, iterations, slices: sliceRows(input) };
}

/**
 * Slices worth offering: from each saved iteration to the active one. The active iteration
 * is not compared with itself, and a gone (`gone`) one is never offered. The review host returns
 * 400 for it because the commit is no longer in the PR.
 */
function sliceRows(input: PickerRowsInput): readonly PickerRow[] {
    const listed = input.iterations.find((iteration) => iteration.status === 'active') ?? null;
    const active =
        listed === null ? input.activeIteration : { diffId: listed.diffId, commit: listed.headCommit };
    if (input.interdiff !== true || active === null) {
        return [];
    }
    return input.iterations
        .filter(
            (iteration) =>
                iteration.diffId !== active.diffId &&
                iteration.status !== 'active' &&
                iteration.status !== 'gone',
        )
        .map(
            (iteration): PickerRow => ({
                kind: 'slice',
                id: iteration.diffId,
                diffId: iteration.diffId,
                commit: iteration.headCommit,
                createdAt: iteration.createdAt,
                model: null,
                harness: null,
                locale: null,
                status: 'slice',
                toCommit: active.commit,
                viewing: { kind: 'slice', base: iteration.diffId, head: active.diffId },
            }),
        )
        .reverse();
}
