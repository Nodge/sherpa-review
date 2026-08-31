import type { FileContent } from '@sherpa/protocol';
import type { KeyboardEvent, ReactNode } from 'react';
import { Fragment, memo, useId, useMemo, useRef, useState } from 'react';

import type { DiffFileModel, DiffGap, DiffLine } from '../diff/model.js';
import { Icon } from '../icons/icon.tsx';
import { formatCount, plural } from '../text.js';
import type { ContextExpandRequest, GapExpandResult } from './context-expansion.js';
import type { ExpandDirection } from './expand.js';
import { EXPAND_STEP, gapKeyOf, hiddenLinesOf } from './expand.js';
import type { LineSegment } from './line-segments.js';
import { hasTabs, lineSegments } from './line-segments.js';
import type { LineKey, LineRange, LineSelection } from './selection.js';
import { lineKey, selectedLines } from './selection.js';
import type { DiffMode } from './store.js';

/**
 * Diff rows: unified (README §1 "Diff rows (unified)") and side by side. Markup and colours come
 * directly from README §1, and behaviour comes from SPEC §2.14.
 *
 * Mouse events attach to the container instead of individual rows. A large file has thousands of rows,
 * so a pair of listeners on each would be expensive. `data-key` identifies the row.
 */

interface LineCell {
    /** `null` means the line has no numbers (malformed patch), so it cannot be selected. */
    readonly key: LineKey | null;
    readonly line: DiffLine;
}

/**
 * `hunk` is set on the first line of each hunk so the single-file PR outline (T7)
 * can find the hunk start in the DOM. Other lines omit it. An attribute on every line
 * of a thousand-line file has a cost.
 */
type Row = { readonly hunk?: number } & (
    | { readonly kind: 'gap'; readonly gap: DiffGap }
    | { readonly kind: 'line'; readonly cell: LineCell }
    | { readonly kind: 'pair'; readonly left: LineCell | null; readonly right: LineCell | null }
);

export interface DiffRowsProps {
    readonly model: DiffFileModel;
    readonly mode: DiffMode;
    /** Needed only to report the trailing gap length accurately. */
    readonly content: FileContent | null;
    readonly selection: LineSelection | null;
    readonly focusedThreadRange?: LineRange | null;
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
    readonly onExpandContext?: ((request: ContextExpandRequest) => Promise<GapExpandResult>) | undefined;
    /** The third number counts changed lines from other stops. Expansion cannot reveal them. */
    readonly onContextExpanded?: ((loaded: number, hidden: number, hiddenChanged: number) => void) | undefined;
    readonly initialGapError?: boolean;
    readonly contextAvailable?: boolean;
}

const NOOP_EXPAND = (): Promise<GapExpandResult> => Promise.resolve({ feedback: null, loaded: 0, hidden: 0 });
const NOOP_ANNOUNCE = (): void => undefined;

export function DiffRows({
    model,
    mode,
    content,
    selection,
    focusedThreadRange = null,
    renderAfterLine,
    onCommentLine,
    onLineFocus,
    onLineBlur,
    onExpandContext = NOOP_EXPAND,
    onContextExpanded = NOOP_ANNOUNCE,
    initialGapError = false,
    contextAvailable = true,
}: DiffRowsProps) {
    // A one-sided file in split mode would leave half the card empty (README §1).
    const oneSided = model.onlyAdditions || model.onlyDeletions;
    const effective: DiffMode = mode === 'split' && !oneSided ? 'split' : 'unified';
    const rows = useMemo(() => buildRows(model, effective), [model, effective]);
    const selected = useMemo(() => selectedLines(model, selection), [model, selection]);
    const selectionStart = selected.values().next().value ?? null;
    const firstGap = rows.find((row) => row.kind === 'gap');
    const firstGapKey = firstGap?.kind === 'gap' ? gapKeyOf(firstGap.gap) : null;

    return (
        <div
            className={`diff-rows diff-rows--${effective}`}
            data-file={model.fileId}
            title={
                mode === 'split' && oneSided
                    ? `shown full width — this file is only ${model.onlyAdditions ? 'additions' : 'deletions'}`
                    : undefined
            }
        >
            {rows.map((row, index) => {
                if (row.kind === 'gap') {
                    return (
                        <GapRow
                            key={gapKeyOf(row.gap)}
                            gap={row.gap}
                            content={content}
                            mode={effective}
                            onExpand={onExpandContext}
                            onExpanded={onContextExpanded}
                            initialError={initialGapError && gapKeyOf(row.gap) === firstGapKey}
                            contextAvailable={contextAvailable}
                        />
                    );
                }
                if (row.kind === 'line') {
                    const positions = positionsOf(row.cell);
                    return (
                        <Fragment key={`row-${String(index)}`}>
                            <UnifiedRow
                                cell={row.cell}
                                selected={isSelected(selected, row.cell)}
                                threadFocused={isThreadFocused(row.cell, focusedThreadRange)}
                                selectionStart={row.cell.key === selectionStart}
                                hunk={row.hunk}
                                onCommentLine={onCommentLine}
                                onLineFocus={onLineFocus}
                                onLineBlur={onLineBlur}
                            />
                            {positions.map((position) => (
                                <Fragment key={`${position.side}:${String(position.line)}`}>
                                    {renderAfterLine?.(position.side, position.line)}
                                </Fragment>
                            ))}
                        </Fragment>
                    );
                }
                const oldLine = row.left?.line.oldLine ?? null;
                const newLine = row.right?.line.newLine ?? null;
                const oldExtra = oldLine === null ? null : (renderAfterLine?.('old', oldLine) ?? null);
                const newExtra = newLine === null ? null : (renderAfterLine?.('new', newLine) ?? null);
                return (
                    <Fragment key={`pair-${String(index)}`}>
                        <SplitRow
                            left={row.left}
                            right={row.right}
                            leftSelected={isSelected(selected, row.left)}
                            rightSelected={isSelected(selected, row.right)}
                            leftThreadFocused={isThreadFocused(row.left, focusedThreadRange, 'old')}
                            rightThreadFocused={isThreadFocused(row.right, focusedThreadRange, 'new')}
                            selectionStart={selectionStart}
                            hunk={row.hunk}
                            onCommentLine={onCommentLine}
                            onLineFocus={onLineFocus}
                            onLineBlur={onLineBlur}
                        />
                        {oldExtra === null && newExtra === null ? null : (
                            <div className="diff-row-extras--split">
                                <div>{oldExtra}</div>
                                <div>{newExtra}</div>
                            </div>
                        )}
                    </Fragment>
                );
            })}
        </div>
    );
}

function isSelected(selected: ReadonlySet<LineKey>, cell: LineCell | null): boolean {
    return cell?.key != null && selected.has(cell.key);
}

function isThreadFocused(
    cell: LineCell | null,
    range: LineRange | null,
    side: 'old' | 'new' = range?.side ?? 'new',
): boolean {
    if (range?.side !== side) {
        return false;
    }
    const line = side === 'old' ? cell?.line.oldLine : cell?.line.newLine;
    return line != null && line >= range.line && line < range.line + Math.max(range.size, 1);
}

function buildRows(model: DiffFileModel, mode: DiffMode): Row[] {
    if (model.content.kind !== 'text') {
        return [];
    }

    const rows: Row[] = [];
    let hunkIndex = 0;
    for (const item of model.content.blocks) {
        if (item.kind === 'gap') {
            rows.push({ kind: 'gap', gap: item });
            continue;
        }

        const first = rows.length;
        const markFirst = (): void => {
            const row = rows[first];
            if (row !== undefined) {
                rows[first] = { ...row, hunk: hunkIndex };
            }
            hunkIndex += 1;
        };

        if (mode === 'unified') {
            for (const value of item.lines) {
                rows.push({ kind: 'line', cell: { key: lineKey(value), line: value } });
            }
            markFirst();
            continue;
        }

        let index = 0;
        while (index < item.lines.length) {
            const current = item.lines[index];
            if (current === undefined) {
                break;
            }
            if (current.kind === 'context') {
                const cell = { key: lineKey(current), line: current };
                rows.push({ kind: 'pair', left: cell, right: cell });
                index += 1;
                continue;
            }

            // A run of deleted lines pairs with the following run of added lines by index within the run.
            const dels: LineCell[] = [];
            while (item.lines[index]?.kind === 'del') {
                const line = item.lines[index];
                if (line !== undefined) {
                    dels.push({ key: lineKey(line), line });
                }
                index += 1;
            }
            const adds: LineCell[] = [];
            while (item.lines[index]?.kind === 'add') {
                const line = item.lines[index];
                if (line !== undefined) {
                    adds.push({ key: lineKey(line), line });
                }
                index += 1;
            }

            for (let i = 0; i < Math.max(dels.length, adds.length); i += 1) {
                rows.push({ kind: 'pair', left: dels[i] ?? null, right: adds[i] ?? null });
            }
        }
        markFirst();
    }
    return rows;
}

function gapLabel(gap: DiffGap, content: FileContent | null): string {
    const changed = gap.hiddenChanged ?? 0;
    const hidden = hiddenLinesOf(gap, content);
    const unchanged =
        hidden === null
            ? 'unchanged to the end of the file'
            : `${formatCount(hidden)} ${plural(hidden, 'unchanged line', 'unchanged lines', 'unchanged lines')}`;
    if (changed === 0) {
        return unchanged;
    }
    // Clip to the stop anchors. Changed lines outside the slice are explained in other stops.
    const elsewhere = `${formatCount(changed)} ${plural(changed, 'changed line', 'changed lines', 'changed lines')} — in other stops`;
    return hidden === 0 ? elsewhere : `${unchanged} and ${elsewhere}`;
}

function GapRow({
    gap,
    content,
    mode,
    onExpand,
    onExpanded,
    initialError,
    contextAvailable,
}: {
    gap: DiffGap;
    content: FileContent | null;
    mode: DiffMode;
    onExpand: (request: ContextExpandRequest) => Promise<GapExpandResult>;
    onExpanded: (loaded: number, hidden: number, hiddenChanged: number) => void;
    initialError: boolean;
    contextAvailable: boolean;
}) {
    const hidden = hiddenLinesOf(gap, content);
    const directions = contextAvailable ? gapDirections(gap, hidden) : [];
    const [selected, setSelected] = useState<ExpandDirection>(directions[0] ?? 'all');
    const [hovered, setHovered] = useState<ExpandDirection | null>(null);
    const [loading, setLoading] = useState(false);
    const [pendingState, setPendingState] = useState(false);
    const [failed, setFailed] = useState(initialError);
    const targetIdPrefix = useId();
    const pending = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const active = directions.includes(selected) ? selected : (directions[0] ?? 'all');
    const key = gapKeyOf(gap);
    const targetId = (direction: ExpandDirection): string => `${targetIdPrefix}-${direction}`;

    const run = (direction: ExpandDirection): void => {
        if (pending.current || directions.length === 0) {
            return;
        }
        pending.current = true;
        setPendingState(true);
        setSelected(direction);
        setFailed(false);
        timer.current = setTimeout(() => {
            setLoading(true);
        }, 150);
        const amount = hidden === null ? EXPAND_STEP : Math.min(EXPAND_STEP, hidden);
        void onExpand({ kind: 'gap', gapKey: key, direction, ...(direction === 'all' ? { amount } : {}) }).then(
            (result) => {
                if (timer.current !== null) {
                    clearTimeout(timer.current);
                }
                timer.current = null;
                pending.current = false;
                setPendingState(false);
                setLoading(false);
                if (result.feedback !== null) {
                    setFailed(true);
                    return;
                }
                // Expansion leaves changed lines from other stops alone. The gap hides the same count as before.
                onExpanded(result.loaded, result.hidden, gap.hiddenChanged ?? 0);
            },
            () => {
                if (timer.current !== null) {
                    clearTimeout(timer.current);
                }
                timer.current = null;
                pending.current = false;
                setPendingState(false);
                setLoading(false);
                setFailed(true);
            },
        );
    };

    if (failed) {
        return (
            <button
                type="button"
                className={`diff-gap diff-gap--${mode} diff-gap--error`}
                data-gap-key={key}
                onClick={() => {
                    run(active);
                }}
            >
                <span className="diff-gap__error-label">could not load · retry</span>
            </button>
        );
    }

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            if (directions.length > 1) {
                const index = directions.indexOf(active);
                const step = event.key === 'ArrowRight' ? 1 : -1;
                setSelected(directions[(index + step + directions.length) % directions.length] ?? active);
            }
            return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            run(active);
        }
    };

    const label = loading ? 'loading…' : gapCounterLabel(gap, content, hovered);
    const target = (direction: ExpandDirection): ReactNode => {
        if (!directions.includes(direction)) {
            return <span className="diff-gap__empty" aria-hidden="true" />;
        }
        const icon = direction === 'all' ? 'updown' : direction === 'up' ? 'arrow-up' : 'arrow-down';
        return (
            <button
                type="button"
                id={targetId(direction)}
                className={`diff-gap__target${active === direction ? ' is-active' : ''}`}
                data-direction={direction}
                role="radio"
                tabIndex={-1}
                disabled={pendingState}
                aria-checked={active === direction}
                aria-label={gapAriaLabel(direction, hidden)}
                onMouseEnter={() => {
                    setHovered(direction);
                }}
                onMouseLeave={() => {
                    setHovered(null);
                }}
                onClick={() => {
                    run(direction);
                }}
            >
                <Icon name={icon} size={13} />
            </button>
        );
    };

    return (
        <div
            className={`diff-gap diff-gap--${mode}${loading ? ' is-loading' : ''}`}
            data-gap-key={key}
            data-edge={gap.edge}
            data-hidden={hidden ?? 'unknown'}
            role="radiogroup"
            aria-label="direction to expand the hidden context"
            aria-activedescendant={directions.length === 0 ? undefined : targetId(active)}
            tabIndex={directions.length === 0 ? undefined : 0}
            onKeyDown={onKeyDown}
        >
            <span className="diff-gap__slot diff-gap__slot--up">{target(directions.includes('all') ? 'all' : 'up')}</span>
            <span className="diff-gap__slot diff-gap__slot--down">{target('down')}</span>
            <span className="diff-gap__counter">{label}</span>
        </div>
    );
}

function gapDirections(gap: DiffGap, hidden: number | null): readonly ExpandDirection[] {
    if (hidden === 0) {
        return [];
    }
    if (hidden !== null && hidden < EXPAND_STEP) {
        return ['all'];
    }
    if (gap.edge === 'leading') {
        return ['up'];
    }
    if (gap.edge === 'trailing') {
        return ['down'];
    }
    return ['up', 'down'];
}

function gapCounterLabel(gap: DiffGap, content: FileContent | null, hovered: ExpandDirection | null): string {
    const hidden = hiddenLinesOf(gap, content);
    const base = gapLabel(gap, content);
    // Invite expansion only when there is context to expand: a gap with only other stops' changes has no targets.
    if (hidden !== null && hidden > 0 && hidden < EXPAND_STEP) {
        return `${base} — expand`;
    }
    if (hovered === 'up' || hovered === 'down') {
        return `+${String(EXPAND_STEP)} lines ${hovered === 'up' ? 'up' : 'down'} · ${base}`;
    }
    return base;
}

function gapAriaLabel(direction: ExpandDirection, hidden: number | null): string {
    const amount = hidden === null ? EXPAND_STEP : Math.min(EXPAND_STEP, hidden);
    const hiddenLabel = hidden === null ? 'lines hidden to the end of the file' : `${String(hidden)} lines hidden`;
    if (direction === 'all') {
        return `load ${String(amount)} lines, ${hiddenLabel}`;
    }
    return `load ${String(amount)} lines ${direction === 'up' ? 'up' : 'down'}, ${hiddenLabel}`;
}

const UnifiedRow = memo(function UnifiedRow({
    cell,
    selected,
    threadFocused,
    selectionStart,
    hunk,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell;
    selected: boolean;
    threadFocused: boolean;
    selectionStart: boolean;
    hunk: number | undefined;
    onCommentLine: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    const { line } = cell;
    const position = positionOf(cell, 'new');
    return (
        <div
            className={`diff-row diff-row--${line.kind}${selected ? ' is-selected' : ''}${threadFocused ? ' is-thread-focused' : ''}`}
            data-key={cell.key ?? undefined}
            data-hunk={hunk}
            tabIndex={position === null ? undefined : 0}
            onFocus={() => {
                if (position !== null) {
                    onLineFocus?.(position.side, position.line);
                }
            }}
            onBlur={onLineBlur}
        >
            <span className="diff-row__gutter">{line.oldLine ?? ''}</span>
            <span className="diff-row__gutter diff-row__gutter--comment">
                {line.newLine ?? ''}
                {position === null ? null : (
                    <CommentButton
                        side={position.side}
                        line={position.line}
                        selectionStart={selectionStart}
                        onCommentLine={onCommentLine}
                    />
                )}
            </span>
            <span className="diff-row__sign">{sign(line)}</span>
            <Code line={line} />
        </div>
    );
});

const SplitRow = memo(function SplitRow({
    left,
    right,
    leftSelected,
    rightSelected,
    leftThreadFocused,
    rightThreadFocused,
    selectionStart,
    hunk,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    left: LineCell | null;
    right: LineCell | null;
    leftSelected: boolean;
    rightSelected: boolean;
    leftThreadFocused: boolean;
    rightThreadFocused: boolean;
    selectionStart: LineKey | null;
    hunk: number | undefined;
    onCommentLine: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    return (
        <div className="diff-row diff-row--pair" data-hunk={hunk}>
            <Side
                cell={left}
                side="old"
                selected={leftSelected}
                threadFocused={leftThreadFocused}
                selectionStart={left?.key === selectionStart && left !== right}
                onCommentLine={onCommentLine}
                onLineFocus={onLineFocus}
                onLineBlur={onLineBlur}
            />
            <Side
                cell={right}
                side="new"
                selected={rightSelected}
                threadFocused={rightThreadFocused}
                selectionStart={right?.key === selectionStart}
                onCommentLine={onCommentLine}
                onLineFocus={onLineFocus}
                onLineBlur={onLineBlur}
            />
        </div>
    );
});

function Side({
    cell,
    side,
    selected,
    threadFocused,
    selectionStart,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell | null;
    side: 'old' | 'new';
    selected: boolean;
    threadFocused: boolean;
    selectionStart: boolean;
    onCommentLine: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    if (cell === null) {
        return (
            <>
                <span className="diff-row__gutter diff-row__gutter--empty" />
                <span className="diff-row__sign diff-row__sign--empty" />
                <span className="diff-row__code diff-row__code--empty" />
            </>
        );
    }

    const { line } = cell;
    const className = `diff-side diff-side--${line.kind}${selected ? ' is-selected' : ''}${threadFocused ? ' is-thread-focused' : ''}`;
    const key = cell.key ?? undefined;
    const position = positionOf(cell, side);
    return (
        <>
            <span className={`diff-row__gutter diff-row__gutter--comment ${className}`} data-key={key} data-side={side}>
                {(side === 'old' ? line.oldLine : line.newLine) ?? ''}
                {position === null ? null : (
                    <CommentButton
                        side={position.side}
                        line={position.line}
                        split
                        selectionStart={selectionStart}
                        onFocus={() => onLineFocus?.(position.side, position.line)}
                        onBlur={onLineBlur}
                        onCommentLine={onCommentLine}
                    />
                )}
            </span>
            <span className={`diff-row__sign ${className}`} data-key={key} data-side={side}>
                {sign(line)}
            </span>
            <Code
                line={line}
                className={className}
                keyString={key}
                side={side}
                tabIndex={position === null ? undefined : 0}
                onFocus={
                    position === null
                        ? undefined
                        : () => {
                              onLineFocus?.(position.side, position.line);
                          }
                }
                onBlur={onLineBlur}
            />
        </>
    );
}

function CommentButton({
    side,
    line,
    split = false,
    selectionStart,
    onFocus,
    onBlur,
    onCommentLine,
}: {
    side: 'old' | 'new';
    line: number;
    split?: boolean;
    selectionStart: boolean;
    onFocus?: (() => void) | undefined;
    onBlur?: (() => void) | undefined;
    onCommentLine: ((side: 'old' | 'new', line: number) => void) | undefined;
}) {
    const sideLabel = side === 'old' ? 'old' : 'new';
    return (
        <button
            type="button"
            className={`diff-row__comment${selectionStart ? ' is-selection-start' : ''}`}
            aria-label={split ? `Comment on ${sideLabel} line ${String(line)}` : `Comment on line ${String(line)}`}
            onFocus={onFocus}
            onBlur={onBlur}
            onClick={() => onCommentLine?.(side, line)}
        >
            <Icon name="pencil" size={15} />
        </button>
    );
}

function Code({
    line,
    className = '',
    keyString,
    side,
    tabIndex,
    onFocus,
    onBlur,
}: {
    line: DiffLine;
    className?: string;
    keyString?: string | undefined;
    side?: 'old' | 'new' | undefined;
    tabIndex?: number | undefined;
    onFocus?: (() => void) | undefined;
    onBlur?: (() => void) | undefined;
}) {
    const segments = lineSegments(line);
    return (
        <code
            className={`diff-row__code ${className}`}
            data-key={keyString}
            data-side={side}
            tabIndex={tabIndex}
            onFocus={onFocus}
            onBlur={onBlur}
            title={hasTabs(line) ? 'tabs are shown as four spaces' : undefined}
        >
            {segments.length === 0 ? ' ' : segments.map((segment, index) => <Segment key={index} segment={segment} />)}
            {line.noNewline === true ? <span className="diff-row__no-newline"> ⏎ no newline at the end of the file</span> : null}
        </code>
    );
}

function Segment({ segment }: { segment: LineSegment }) {
    const classes = [
        segment.kind === null ? null : `syntax-${segment.kind}`,
        segment.word ? 'diff-word' : null,
        segment.trailing ? 'diff-trailing' : null,
    ].filter((value) => value !== null);

    if (classes.length === 0) {
        return segment.text;
    }
    return <span className={classes.join(' ')}>{segment.text}</span>;
}

function positionsOf(cell: LineCell): { side: 'old' | 'new'; line: number }[] {
    const positions: { side: 'old' | 'new'; line: number }[] = [];
    if (cell.line.oldLine !== null) {
        positions.push({ side: 'old', line: cell.line.oldLine });
    }
    if (cell.line.newLine !== null) {
        positions.push({ side: 'new', line: cell.line.newLine });
    }
    return positions;
}

function positionOf(cell: LineCell | null, preferred: 'old' | 'new'): { side: 'old' | 'new'; line: number } | null {
    if (cell === null) {
        return null;
    }
    const preferredLine = preferred === 'old' ? cell.line.oldLine : cell.line.newLine;
    if (preferredLine !== null) {
        return { side: preferred, line: preferredLine };
    }
    const side = preferred === 'old' ? 'new' : 'old';
    const line = side === 'old' ? cell.line.oldLine : cell.line.newLine;
    return line === null ? null : { side, line };
}

function sign(line: DiffLine): string {
    if (line.kind === 'add') {
        return '+';
    }
    return line.kind === 'del' ? '−' : '';
}
