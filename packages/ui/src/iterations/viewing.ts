import type { Iteration, Locale, RouteSnapshot, UiRouteState, UiSnapshotSummary } from '@sherpa/protocol';

/**
 * What the tab is viewing: current PR state, a previous route snapshot, an iteration without
 * a route or a slice between 2 iterations. The selection is client-side and lives in the
 * URL fragment. The server is not asked for the "current view" (`uiReviewDiffRequestSchema` contract).
 *
 * Resolving the selection is a pure function: it takes the snapshot list, iterations, current route
 * and what App already knows about the active iteration. It returns endpoint parameters, read-only mode
 * and the indicator label.
 */

export type Viewing =
    | { readonly kind: 'current' }
    | { readonly kind: 'snapshot'; readonly snapshotId: string }
    | { readonly kind: 'diff'; readonly diffId: string }
    /** Slice between iterations: `base` is older, `head` is newer and need not be active. */
    | { readonly kind: 'slice'; readonly base: string; readonly head: string };

export const VIEWING_CURRENT: Viewing = { kind: 'current' };

/** Slice diff endpoint parameters, also kept in the URL fragment by the UI. */
export interface ViewingSlice {
    readonly base: string;
    readonly head: string;
}

/**
 * With several URL parameters, `snapshot` takes precedence over slice, and slice over `diff`: selections
 * are mutually exclusive. A slice missing either half is ignored entirely.
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

/** Indicator label: `current` / `stale` / `commit is no longer in the PR` / `no route` / `slice`. */
export type ViewingStatus = 'current' | 'stale' | 'gone' | 'noRoute' | 'slice';

export type ViewingLabel =
    | { readonly kind: 'snapshot' | 'diff'; readonly commit: string; readonly status: ViewingStatus }
    /** A slice has 2 sides: `commit` is its head, `baseCommit` is the starting point. */
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
 * Slice between iterations: both endpoints must be valid (`sliceIndex`), with the base older than the head, so
 * the base must be in the list, and the head must be in the list or active. Any other URL combination is invalid (a force-push
 * rewrote an iteration, or the URL came from another tab). Clear the selection as with an unknown
 * snapshot, and fall back to the active iteration.
 */
function resolveSlice(
    viewing: { readonly kind: 'slice'; readonly base: string; readonly head: string },
    input: ViewingInput,
    active: string | null,
    current: ResolvedViewing,
): ResolvedViewing {
    const { base, head } = viewing;
    const baseIndex = sliceIndex(input.iterations, active, base);
    const headIndex = sliceIndex(input.iterations, active, head);
    const baseIteration = input.iterations.find((candidate) => candidate.diffId === base) ?? null;
    const headCommit = commitOfDiff(head, input);
    if (
        baseIndex === null ||
        headIndex === null ||
        baseIndex >= headIndex ||
        baseIteration === null ||
        headCommit === null
    ) {
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
        // No route is built for a slice. It shows "what is new" without AI (docs/product.md §3, principle 1).
        routeless: true,
        slice: { base, head },
    };
}

/**
 * Position among slice endpoints, oldest to newest: index in the iteration list (the server returns
 * it oldest to newest). The active iteration outside the list is newest. null cannot be a slice endpoint:
 * a gone iteration (the review host returns 400 for it) or an unknown one.
 */
function sliceIndex(iterations: readonly Iteration[], active: string | null, diffId: string): number | null {
    const index = iterations.findIndex((iteration) => iteration.diffId === diffId);
    if (index === -1) {
        return diffId === active ? iterations.length : null;
    }
    return iterations[index]?.status === 'gone' ? null : index;
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

/** Current state indicator: `stale` while the PR is ahead of the snapshot (docs/design/README.md §1). */
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

/** Picker row: one per snapshot and one per iteration without a snapshot. */
export interface PickerRow {
    readonly kind: 'snapshot' | 'diff';
    /** `snapshotId` or `diffId`, used for the selection and `data-*` in e2e. */
    readonly id: string;
    readonly diffId: string;
    readonly commit: string;
    /** Short commit identifier unique within the menu (`shortCommits`). */
    readonly short: string;
    /** null means the time is unknown (an iteration from `stale`). */
    readonly createdAt: string | null;
    readonly model: string | null;
    readonly harness: string | null;
    /** Snapshot generation language. null means an iteration without a route or a snapshot saved before language was recorded. */
    readonly locale: Locale | null;
    readonly status: ViewingStatus | 'activeIteration' | 'previousIteration';
    /** Current PR snapshot (`current` on the server): selected without parameters, even when labelled "stale". */
    readonly latest: boolean;
    /** The commit does not distinguish this row from another in the menu, so show the exact time. */
    readonly ambiguous: boolean;
    readonly viewing: Viewing;
}

export interface PickerRowsInput {
    readonly snapshots: readonly UiSnapshotSummary[];
    readonly iterations: readonly Iteration[];
    /** Active PR iteration from App facts, independent of what the tab is viewing. */
    readonly activeIteration: { readonly diffId: string; readonly commit: string } | null;
    /**
     * The host supports iterations (`pr.capabilities.iterations`). Otherwise the slice endpoint returns 400,
     * and Shift+click does not build a slice.
     */
    readonly interdiff?: boolean;
}

export interface PickerRows {
    /**
     * Snapshots and iterations without routes in one list: active iteration first (with its snapshot
     * if a route was built on it), then newest to oldest by iteration time. A snapshot sits
     * beside its iteration. Multiple snapshots of one iteration appear newest first.
     */
    readonly iterations: readonly PickerRow[];
    /** Valid slice endpoints and their order (`sliceIndex`). Empty when the host does not support slices. */
    readonly sliceOrder: ReadonlyMap<string, number>;
}

/** Row before labels calculated across the whole menu: short id and uniqueness. */
type RawRow = Omit<PickerRow, 'short' | 'ambiguous'>;

/**
 * Picker rows. An empty iteration list still yields an active iteration row if it has no
 * snapshot: its `diffId` and commit are known from the route without parameters (the server may send
 * `iterations: []`).
 */
export function pickerRows(input: PickerRowsInput): PickerRows {
    const active = input.activeIteration;
    const snapshots = [...input.snapshots].reverse().map(
        (summary): RawRow => ({
            kind: 'snapshot',
            id: summary.snapshotId,
            diffId: summary.diffId,
            commit: summary.commit,
            createdAt: summary.createdAt,
            model: summary.provenance.model,
            harness: summary.provenance.harness,
            locale: summary.provenance.locale,
            // The current snapshot of a previous iteration is stale, as in the indicator: the PR has moved ahead.
            status:
                summary.status === 'current' && active !== null && summary.diffId !== active.diffId
                    ? 'stale'
                    : summary.status,
            latest: summary.status === 'current',
            viewing: { kind: 'snapshot', snapshotId: summary.snapshotId },
        }),
    );

    const withSnapshot = new Set(input.snapshots.map((summary) => summary.diffId));
    const routeless = input.iterations
        .filter((iteration) => !withSnapshot.has(iteration.diffId))
        .map(
            (iteration): RawRow => ({
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
                latest: false,
                viewing: { kind: 'diff', diffId: iteration.diffId },
            }),
        )
        .reverse();

    if (routeless.length === 0 && active !== null && !withSnapshot.has(active.diffId)) {
        routeless.push({
            kind: 'diff',
            id: active.diffId,
            diffId: active.diffId,
            commit: active.commit,
            createdAt: null,
            model: null,
            harness: null,
            locale: null,
            status: 'activeIteration',
            latest: false,
            viewing: { kind: 'diff', diffId: active.diffId },
        });
    }

    const activeDiffId =
        input.iterations.find((iteration) => iteration.status === 'active')?.diffId ?? active?.diffId ?? null;
    const timeline = orderedTimeline([...snapshots, ...routeless], input, activeDiffId);
    // Calculate short identifiers across the whole menu, where they must be distinct.
    const short = shortCommits(timeline.map((row) => row.commit));
    // A commit shared by multiple menu rows does not distinguish them. Show
    // exact times instead of rounded ones (iterations without routes had no time at all before).
    const perCommit = new Map<string, number>();
    for (const row of timeline) {
        perCommit.set(row.commit, (perCommit.get(row.commit) ?? 0) + 1);
    }
    const dressed = (row: RawRow): PickerRow => ({
        ...row,
        short: short.get(row.commit) ?? row.commit,
        ambiguous: (perCommit.get(row.commit) ?? 0) > 1,
    });
    return {
        iterations: timeline.map(dressed),
        sliceOrder: sliceOrder(input, activeDiffId),
    };
}

function sliceOrder(input: PickerRowsInput, activeDiffId: string | null): ReadonlyMap<string, number> {
    const order = new Map<string, number>();
    if (input.interdiff !== true) {
        return order;
    }
    const candidates = input.iterations.map((iteration) => iteration.diffId);
    if (activeDiffId !== null) {
        candidates.push(activeDiffId);
    }
    for (const diffId of candidates) {
        const index = sliceIndex(input.iterations, activeDiffId, diffId);
        if (index !== null) {
            order.set(diffId, index);
        }
    }
    return order;
}

/** A row can be a slice endpoint when the host supports slices, the iteration still exists, and there is another to compare. */
export function canBeSliceEdge(rows: PickerRows, row: PickerRow): boolean {
    return rows.sliceOrder.size >= 2 && rows.sliceOrder.has(row.diffId);
}

/** First endpoint still valid for a slice: the rows may have changed since it was selected. */
export function liveSliceEdge(rows: PickerRows, edge: string | null): string | null {
    return edge !== null && rows.sliceOrder.has(edge) ? edge : null;
}

/** Slice between two iterations: the older is the base, the newer is the head. null means the pair cannot form a slice. */
export function sliceBetween(
    rows: PickerRows,
    first: string,
    second: string,
): Extract<Viewing, { kind: 'slice' }> | null {
    const firstOrder = rows.sliceOrder.get(first);
    const secondOrder = rows.sliceOrder.get(second);
    if (firstOrder === undefined || secondOrder === undefined || firstOrder === secondOrder) {
        return null;
    }
    return firstOrder < secondOrder
        ? { kind: 'slice', base: first, head: second }
        : { kind: 'slice', base: second, head: first };
}

/** Row click action: select a view (closing the menu) or set and clear the first slice endpoint. */
export type RowAction =
    | { readonly kind: 'select'; readonly viewing: Viewing }
    | { readonly kind: 'edge'; readonly edge: string | null };

/**
 * A click on a picker row. Slice selection takes two steps: Shift-click sets the first
 * endpoint. The next click on another iteration, with or without Shift, builds the slice. Clicking the iteration
 * of the first endpoint clears it. A row that cannot be an endpoint uses normal click selection,
 * whether a first endpoint is set or not.
 */
export function rowAction(rows: PickerRows, edge: string | null, row: PickerRow, shift: boolean): RowAction {
    const first = liveSliceEdge(rows, edge);
    if (first !== null) {
        if (row.diffId === first) {
            return { kind: 'edge', edge: null };
        }
        return { kind: 'select', viewing: sliceBetween(rows, first, row.diffId) ?? row.viewing };
    }
    if (shift && canBeSliceEdge(rows, row)) {
        return { kind: 'edge', edge: row.diffId };
    }
    return { kind: 'select', viewing: row.viewing };
}

export interface SliceRowMark {
    readonly part: 'edge' | 'inside';
    /** Active slice endpoint label on the first row of the iteration group, like the selection checkmark. */
    readonly role: 'base' | 'head' | null;
}

/**
 * Slice range on picker rows. With the first endpoint set, mark it alone, or preview the future slice
 * when hovering over another valid iteration. The preview replaces the active slice mark.
 * Without a first endpoint, mark the slice the tab is viewing, with base and head labels.
 */
export function sliceMarks(
    rows: PickerRows,
    viewing: Viewing,
    edge: string | null,
    cursor: PickerRow | null,
): ReadonlyMap<PickerRow, SliceRowMark> {
    const first = liveSliceEdge(rows, edge);
    if (first !== null) {
        const preview = cursor === null ? null : sliceBetween(rows, first, cursor.diffId);
        return preview === null
            ? rangeMarks(rows, first, first, false)
            : rangeMarks(rows, preview.base, preview.head, false);
    }
    return viewing.kind === 'slice' ? rangeMarks(rows, viewing.base, viewing.head, true) : new Map();
}

/** Rows whose iteration falls between the endpoints, inclusive, by `sliceOrder`, with snapshots of those iterations. */
function rangeMarks(
    rows: PickerRows,
    base: string,
    head: string,
    roles: boolean,
): ReadonlyMap<PickerRow, SliceRowMark> {
    const marks = new Map<PickerRow, SliceRowMark>();
    const low = rows.sliceOrder.get(base);
    const high = rows.sliceOrder.get(head);
    if (low === undefined || high === undefined) {
        return marks;
    }
    const labelled = new Set<string>();
    for (const row of rows.iterations) {
        const order = rows.sliceOrder.get(row.diffId);
        if (order === undefined || order < low || order > high) {
            continue;
        }
        if (row.diffId !== base && row.diffId !== head) {
            marks.set(row, { part: 'inside', role: null });
            continue;
        }
        const role = roles && !labelled.has(row.diffId) ? (row.diffId === base ? 'base' : 'head') : null;
        labelled.add(row.diffId);
        marks.set(row, { part: 'edge', role });
    }
    return marks;
}

/**
 * Menu row order: active iteration first, then newest to oldest by iteration time.
 * Snapshots do not form a separate section at the top. The reviewer looks for an iteration,
 * regardless of whether a route was built on it.
 */
function orderedTimeline(rows: readonly RawRow[], input: PickerRowsInput, activeDiffId: string | null): RawRow[] {
    const times = new Map(input.iterations.map((iteration) => [iteration.diffId, iteration.createdAt]));
    const groups = new Map<string, RawRow[]>();
    for (const row of rows) {
        const group = groups.get(row.diffId);
        if (group === undefined) {
            groups.set(row.diffId, [row]);
        } else {
            group.push(row);
        }
    }
    /** Iteration time. For an unknown iteration, use its latest snapshot time, otherwise place it last. */
    const timeOf = (diffId: string, group: readonly RawRow[]): string | null =>
        times.get(diffId) ??
        group.map((row) => row.createdAt).filter((at) => at !== null).toSorted().at(-1) ??
        null;

    return [...groups.entries()]
        .map(([diffId, group]) => ({ diffId, group, time: timeOf(diffId, group) }))
        .toSorted((left, right) => {
            if (left.diffId === activeDiffId || right.diffId === activeDiffId) {
                return left.diffId === activeDiffId ? -1 : 1;
            }
            if (left.time === right.time) {
                return 0;
            }
            // An iteration without a time is oldest. Substituting "now" would move it to the top.
            return left.time === null ? 1 : right.time === null ? -1 : right.time.localeCompare(left.time);
        })
        .flatMap((entry) => entry.group);
}

/** Commits never shrink below seven characters, as specified in the handoff (docs/design/README.md §13). */
const SHORT_COMMIT = 7;
/** Maximum prefix length. Show the shared suffix after an ellipsis. */
const LONGEST_PREFIX = 12;
/** Minimum suffix length after the ellipsis: one character is too short to read as an id. */
const SHORTEST_SUFFIX = 4;

/**
 * Short commit identifiers within one menu: seven characters, as elsewhere in the UI,
 * extended on collision until distinct, like short git hashes.
 *
 * Identifiers with a long shared prefix (local review iterations recorded with the old
 * `<sha HEAD>+<8 hex>` formula differ only by suffix) cannot be distinguished by prefix alone. Show those
 * rows with the beginning and end separated by an ellipsis.
 */
export function shortCommits(commits: readonly string[]): ReadonlyMap<string, string> {
    const unique = [...new Set(commits)];
    const prefix = shortestUnique(unique, SHORT_COMMIT, (commit, length) => commit.slice(0, length));
    if (prefix !== null && prefix <= LONGEST_PREFIX) {
        return new Map(unique.map((commit) => [commit, commit.slice(0, prefix)]));
    }
    const suffix = shortestUnique(unique, SHORTEST_SUFFIX, (commit, length) => commit.slice(-length));
    if (suffix !== null && suffix <= LONGEST_PREFIX) {
        return new Map(
            unique.map((commit) => [commit, `${commit.slice(0, SHORT_COMMIT)}…${commit.slice(-suffix)}`]),
        );
    }
    return new Map(unique.map((commit) => [commit, commit.slice(0, prefix ?? commit.length)]));
}

/** Smallest length starting at `shortest` that makes all strings distinct. null means no length does. */
function shortestUnique(
    commits: readonly string[],
    shortest: number,
    cut: (commit: string, length: number) => string,
): number | null {
    const longest = Math.max(shortest, ...commits.map((commit) => commit.length));
    for (let length = shortest; length <= longest; length += 1) {
        if (new Set(commits.map((commit) => cut(commit, length))).size === commits.length) {
            return length;
        }
    }
    return null;
}
