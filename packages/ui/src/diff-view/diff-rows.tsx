import type { FileContent } from '@sherpa/protocol';
import type { ReactNode } from 'react';
import { Fragment, memo, useMemo } from 'react';

import type { DiffFileModel, DiffGap, DiffLine } from '../diff/model.js';
import { formatCount, plural } from '../text.js';
import { hiddenLinesOf } from './expand.js';
import type { LineSegment } from './line-segments.js';
import { hasTabs, lineSegments } from './line-segments.js';
import type { LineKey, LineSelection } from './selection.js';
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
    readonly renderAfterLine?: ((side: 'old' | 'new', line: number) => ReactNode) | undefined;
    readonly onCommentLine?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineFocus?: ((side: 'old' | 'new', line: number) => void) | undefined;
    readonly onLineBlur?: (() => void) | undefined;
}

export function DiffRows({
    model,
    mode,
    content,
    selection,
    renderAfterLine,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: DiffRowsProps) {
    // A one-sided file in split mode would leave half the card empty (README §1).
    const oneSided = model.onlyAdditions || model.onlyDeletions;
    const effective: DiffMode = mode === 'split' && !oneSided ? 'split' : 'unified';
    const rows = useMemo(() => buildRows(model, effective), [model, effective]);
    const selected = useMemo(() => selectedLines(model, selection), [model, selection]);

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
                    return <GapRow key={`gap-${String(index)}`} gap={row.gap} content={content} mode={effective} />;
                }
                if (row.kind === 'line') {
                    const positions = positionsOf(row.cell);
                    return (
                        <Fragment key={`row-${String(index)}`}>
                            <UnifiedRow
                                cell={row.cell}
                                selected={isSelected(selected, row.cell)}
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
    const hidden = hiddenLinesOf(gap, content);
    if (hidden === null) {
        return '↕ unchanged to the end of the file';
    }
    return `↕ ${formatCount(hidden)} ${plural(hidden, 'unchanged line', 'unchanged lines', 'unchanged lines')}`;
}

function GapRow({ gap, content, mode }: { gap: DiffGap; content: FileContent | null; mode: DiffMode }) {
    return (
        <div className={`diff-gap diff-gap--${mode}`} role="separator">
            {gapLabel(gap, content)}
        </div>
    );
}

const UnifiedRow = memo(function UnifiedRow({
    cell,
    selected,
    hunk,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell;
    selected: boolean;
    hunk: number | undefined;
    onCommentLine: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineFocus: ((side: 'old' | 'new', line: number) => void) | undefined;
    onLineBlur: (() => void) | undefined;
}) {
    const { line } = cell;
    const position = positionOf(cell, 'new');
    return (
        <div
            className={`diff-row diff-row--${line.kind}${selected ? ' is-selected' : ''}`}
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
            <span className="diff-row__gutter">{line.newLine ?? ''}</span>
            <span className="diff-row__sign">{sign(line)}</span>
            <Code line={line} />
            {position === null ? null : (
                <button
                    type="button"
                    className="diff-row__comment"
                    aria-label={`Comment on line ${String(position.line)}`}
                    onClick={() => onCommentLine?.(position.side, position.line)}
                >
                    ✎
                </button>
            )}
        </div>
    );
});

const SplitRow = memo(function SplitRow({
    left,
    right,
    leftSelected,
    rightSelected,
    hunk,
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    left: LineCell | null;
    right: LineCell | null;
    leftSelected: boolean;
    rightSelected: boolean;
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
                onCommentLine={onCommentLine}
                onLineFocus={onLineFocus}
                onLineBlur={onLineBlur}
            />
            <Side
                cell={right}
                side="new"
                selected={rightSelected}
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
    onCommentLine,
    onLineFocus,
    onLineBlur,
}: {
    cell: LineCell | null;
    side: 'old' | 'new';
    selected: boolean;
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
    const className = `diff-side diff-side--${line.kind}${selected ? ' is-selected' : ''}`;
    const key = cell.key ?? undefined;
    const position = positionOf(cell, side);
    return (
        <>
            <span className={`diff-row__gutter ${className}`} data-key={key}>
                {(side === 'old' ? line.oldLine : line.newLine) ?? ''}
            </span>
            <span className={`diff-row__sign ${className}`} data-key={key}>
                {sign(line)}
            </span>
            <Code
                line={line}
                className={className}
                keyString={key}
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
            {position === null ? null : (
                <button
                    type="button"
                    className={`diff-row__comment diff-row__comment--${side}`}
                    aria-label={`Comment on ${side === 'old' ? 'old' : 'new'} line ${String(position.line)}`}
                    onFocus={() => onLineFocus?.(position.side, position.line)}
                    onBlur={onLineBlur}
                    onClick={() => onCommentLine?.(position.side, position.line)}
                >
                    ✎
                </button>
            )}
        </>
    );
}

function Code({
    line,
    className = '',
    keyString,
    tabIndex,
    onFocus,
    onBlur,
}: {
    line: DiffLine;
    className?: string;
    keyString?: string | undefined;
    tabIndex?: number | undefined;
    onFocus?: (() => void) | undefined;
    onBlur?: (() => void) | undefined;
}) {
    const segments = lineSegments(line);
    return (
        <code
            className={`diff-row__code ${className}`}
            data-key={keyString}
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
