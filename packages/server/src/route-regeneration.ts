import type { Comment, PrDiff, RouteSnapshot, RouteStop, Thread } from '@sherpa/protocol';

import type { IterationMap } from './iterations/index.js';
import { byteLength, fitText, unavailableBlock } from './payload-budget.js';

/**
 * Context files for route regeneration after a push (M4-T7): the previous route and discussion
 * added since then. The shared patch printer (`route-payload.ts`) prints the interdiff.
 * This module covers only what the first generation never has.
 *
 * Texts are English because the model reads them. Texts from the previous route keep their original language.
 */

/** What the server knows about the previous pass when generation starts. */
export interface RouteRegenerationContext {
    /** The snapshot that was current when generation started. */
    readonly previous: RouteSnapshot;
    /** Slice from the previous snapshot's iteration to the generation iteration. null means the same iteration or no slice available. */
    readonly interdiff: PrDiff | null;
    /** Line mapping for the same slice. null means no classification or "affected" markers. */
    readonly map: IterationMap | null;
    /** PR threads. null means the host did not return them (or context was restored after a restart). */
    readonly threads: readonly Thread[] | null;
}

/** Filenames in the generation directory, also used to identify files after a server restart. */
export const PREVIOUS_ROUTE_FILE = 'previous-route.md';
export const THREADS_SINCE_FILE = 'threads-since.md';

/**
 * Previous route for a regeneration task, so the model can preserve numbers and order
 * where code has not changed. Stop paragraphs cost the most and matter least when the budget is tight.
 * They are truncated first, from the end of the plan. The table and summary go last.
 *
 * Text depends on whether a slice exists. Without one there was no push (regeneration in the same iteration), so
 * there is nothing to describe as "affected by the push".
 */
export function previousRouteContext(context: RouteRegenerationContext, budgetBytes: number): string {
    const { previous, map, interdiff } = context;
    const pushed = interdiff !== null;
    const stops = [...previous.stops].sort((left, right) => left.planIndex - right.planIndex);
    const head = [
        headBlock(previous, pushed),
        summaryBlock(previous),
        stopTableBlock(stops, map, pushed),
        textsHeading(pushed),
    ].join('\n\n');
    const texts = stops.filter((stop) => stop.paragraph !== null).map((stop) => stopTextBlock(stop));
    const render = (kept: number): string =>
        `${[head, ...texts.slice(0, kept), ...(kept === texts.length ? [] : [DROPPED_TEXTS_NOTE])].join('\n\n')}\n`;

    let kept = texts.length;
    while (kept > 0 && byteLength(render(kept)) > budgetBytes) {
        kept -= 1;
    }
    return fitText(render(kept), budgetBytes, unavailableBlock('Previous route', PREVIOUS_ROUTE_UNAVAILABLE));
}

const PREVIOUS_ROUTE_UNAVAILABLE = 'the previous route did not fit in the payload budget.';
const DROPPED_TEXTS_NOTE =
    '[TRUNCATED: the remaining stop texts of the previous route were omitted by the payload budget; ' +
    'the plan table above is complete.]';

function textsHeading(pushed: boolean): string {
    return [
        '## What each stop said',
        '',
        pushed
            ? 'The prose is what the reviewer already read. Reuse the parts the push did not invalidate.'
            : 'The prose is what the reviewer already read.',
    ].join('\n');
}

function headBlock(previous: RouteSnapshot, pushed: boolean): string {
    const { harness, model } = previous.provenance;
    const by = harness === null && model === null ? 'unknown agent' : `${harness ?? 'unknown'} / ${model ?? 'unknown'}`;
    const lead = pushed
        ? [
              'The route this pull request already had, built before the push you see in the interdiff.',
              'Stop numbers carry the progress of the reviewer: keep the plan, its order and its titles wherever',
              'the code did not change, and rewrite only what the push touched.',
          ]
        : [
              'The route this pull request already had. The code has not moved since it was built: this run',
              'rebuilds the route on the same commit, and there is no push to account for.',
              'Stop numbers carry the progress of the reviewer, so a stop you keep keeps its number. Past that,',
              'the previous route is here for the numbering, not as a template to copy.',
          ];
    return [
        '# Previous route',
        '',
        ...lead,
        '',
        `- Built for commit: ${previous.commit} (base ${previous.baseCommit})`,
        `- Built at: ${previous.createdAt}`,
        `- Built by: ${by}`,
        `- Stops: ${String(previous.stops.length)}`,
    ].join('\n');
}

function summaryBlock(previous: RouteSnapshot): string {
    return ['## Summary of the previous route', '', previous.summary].join('\n');
}

/**
 * Previous pass plan: number, tier, title, anchors and, when there was a push, an "affected by this push"
 * flag. The server computes the flag from the interdiff. The model reads it instead of inferring it. Without a push,
 * there is no column. A column full of "no" would tell the model to leave everything alone.
 */
function stopTableBlock(stops: readonly RouteStop[], map: IterationMap | null, pushed: boolean): string {
    const rows = stops.map((stop) => {
        const cells = [String(stop.planIndex), stop.tier, stop.title, anchorList(stop)];
        return row(pushed ? [...cells, map === null ? '—' : yesNo(touchedByPush(stop, map))] : cells);
    });
    const lead = pushed
        ? [
              map === null
                  ? 'The server could not compute which stops the push touched: judge by the interdiff yourself.'
                  : 'The last column is the verdict of the server on whether the push touched the lines of that stop.',
              '',
              '| stop # | tier | title | anchors | touched by the push |',
              '|---|---|---|---|---|',
          ]
        : ['| stop # | tier | title | anchors |', '|---|---|---|---|'];
    return ['## Stops of the previous route', '', ...lead, ...rows].join('\n');
}

function stopTextBlock(stop: RouteStop): string {
    const bridge = stop.bridge === null ? [] : ['', `Bridge to the next stop: ${stop.bridge}`];
    return [
        `### Stop ${String(stop.planIndex)} — ${stop.tier} — ${stop.title}`,
        '',
        stop.paragraph ?? '',
        ...bridge,
    ].join('\n');
}

function touchedByPush(stop: RouteStop, map: IterationMap): boolean {
    return stop.anchors.some(
        (anchor) => map.touchedInA(anchor.path, anchor.side, { start: anchor.start, end: anchor.end }).length > 0,
    );
}

/** Human-readable stop anchors: `path:side:start-end`. */
function anchorList(stop: RouteStop): string {
    if (stop.anchors.length === 0) {
        return '—';
    }
    return stop.anchors
        .map((anchor) => `\`${anchor.path}\`:${anchor.side}:${String(anchor.start)}-${String(anchor.end)}`)
        .join('; ');
}

/**
 * Discussion added since the previous route: threads with a new comment on a file affected
 * by the push or at PR level. Each thread is printed in full because a reply needs the comment
 * it answers to make sense. New comments are marked. Drafts are never printed.
 *
 * The file is always written, even if nothing was found, to avoid another branch in the task
 * for this file too. The header depends on the slice. Without a push, "on an affected file" has no meaning.
 */
export function threadsSinceContext(context: RouteRegenerationContext, budgetBytes: number): string {
    const { threads, previous, map, interdiff } = context;
    const heading = threadsHeading(interdiff !== null);
    if (threads === null) {
        return `${[heading, '', THREADS_UNAVAILABLE].join('\n')}\n`;
    }

    const since = Date.parse(previous.createdAt);
    const selected = threads
        .filter((thread) => hasNewComment(thread, since) && onTouchedPlace(thread, map))
        .map((thread) => ({ thread, freshest: freshestAt(thread) }))
        .sort((left, right) => right.freshest - left.freshest);
    if (selected.length === 0) {
        return `${[heading, '', THREADS_EMPTY].join('\n')}\n`;
    }

    const blocks = selected.map((entry) => threadBlock(entry.thread, since));
    const render = (kept: number): string =>
        `${[heading, ...blocks.slice(0, kept), ...(kept === blocks.length ? [] : [droppedThreadsNote(blocks.length - kept)])].join('\n\n')}\n`;

    let kept = blocks.length;
    while (kept > 0 && byteLength(render(kept)) > budgetBytes) {
        kept -= 1;
    }
    return fitText(render(kept), budgetBytes, unavailableBlock('New comments', THREADS_UNAVAILABLE_BUDGET));
}

function threadsHeading(pushed: boolean): string {
    const scope = pushed
        ? [
              'Discussions with a comment written after the previous route was built, on a file the push',
              'touched or on the pull request itself.',
          ]
        : [
              'Discussions with a comment written after the previous route was built. The code has not moved',
              'since, so this is the only thing that is new.',
          ];
    return [
        '# New comments since the previous route',
        '',
        ...scope,
        'Threads are printed whole: the new comments are marked `(new)`, the older ones are there so that',
        'the answer makes sense. Unsent drafts of the reviewer are not shown at all.',
        '',
        'Cite a thread as `[thread:<id>]` with the id printed in its header — ids the server does not',
        'know are removed from your text.',
    ].join('\n');
}

const THREADS_EMPTY = 'No new comments since the previous route.';
const THREADS_UNAVAILABLE = '[UNAVAILABLE: the host did not give the discussion of this pull request.]';
const THREADS_UNAVAILABLE_BUDGET = 'the discussion did not fit in the payload budget.';

function droppedThreadsNote(count: number): string {
    return `[TRUNCATED: ${String(count)} older thread(s) omitted by the payload budget.]`;
}

function threadBlock(thread: Thread, since: number): string {
    const anchor = thread.anchor;
    const position = anchor?.position ?? null;
    const place =
        anchor === null
            ? 'PR-level'
            : `\`${anchor.path}\`${position === null ? ' (whole file)' : ` ${position.side}:${lineSpan(position.line, position.size)}`}`;
    const state = [
        thread.resolved ? 'resolved' : 'unresolved',
        ...(thread.outdated ? ['outdated'] : []),
        ...(thread.pinnedTo === null ? [] : [`pinned to ${thread.pinnedTo.commit}`]),
    ].join(', ');

    return [`## [thread:${thread.id}] — ${place}`, '', `State: ${state}`, '', ...commentLines(thread.root, since)].join(
        '\n',
    );
}

/**
 * Thread comments from top to bottom. Drafts are skipped because even the PR author has not seen them,
 * so they cannot have caused the change. The model would treat them as ordinary comments.
 */
function commentLines(comment: Comment, since: number): string[] {
    const replies = comment.replies.flatMap((reply) => commentLines(reply, since));
    if (comment.draft) {
        return replies;
    }
    const fresh = isNew(comment, since) ? ' (new)' : '';
    const body = comment.body.split('\n').map((line) => `  ${line}`);
    return [`- ${comment.author.login}, ${comment.createdAt}${fresh}:`, ...body, ...replies];
}

function lineSpan(line: number, size: number): string {
    return size <= 1 ? String(line) : `${String(line)}-${String(line + size - 1)}`;
}

/** Whether the thread has a published comment written after the previous route. */
function hasNewComment(thread: Thread, since: number): boolean {
    return flatten(thread.root).some((comment) => isNew(comment, since));
}

function isNew(comment: Comment, since: number): boolean {
    return !comment.draft && Date.parse(comment.createdAt) > since;
}

/**
 * Whether the thread's location matters for regeneration. PR-level threads always do, file threads only if the push
 * touched the file. Without a map there is nothing to filter by, so all new discussion is included.
 */
function onTouchedPlace(thread: Thread, map: IterationMap | null): boolean {
    const anchor = thread.anchor;
    if (anchor === null || map === null) {
        return true;
    }
    return map.fileStatus(anchor.path) !== 'unchanged';
}

function freshestAt(thread: Thread): number {
    return flatten(thread.root).reduce((latest, comment) => Math.max(latest, Date.parse(comment.createdAt)), 0);
}

function flatten(comment: Comment): Comment[] {
    return [comment, ...comment.replies.flatMap((reply) => flatten(reply))];
}

function yesNo(value: boolean): string {
    return value ? 'yes' : 'no';
}

function row(cells: readonly string[]): string {
    return `| ${cells.join(' | ')} |`;
}
