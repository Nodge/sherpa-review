import type { Locale } from '@sherpa/protocol';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import type { MessageKey, Translate } from '../i18n/index.js';
import { useLocale, useT } from '../i18n/index.js';
import { formatDateTime, relativeTime } from '../i18n/index.js';
import { Icon } from '../icons/icon.tsx';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { localeNameKey } from '../route/generation.js';
import type { PickerRow, PickerRows, Viewing, ViewingLabel } from './viewing.js';
import { rowSelection, sameViewing } from './viewing.js';
import './snapshot-picker.css';

/**
 * Snapshot picker (docs/design/README.md §1: indicator on the right of the PR header, §6: "Snapshots" card on Overview).
 * The prototype has no menu. It uses the indicator tokens and follows the file filter
 * select: Esc closes it and restores focus, arrows navigate, ⏎ selects.
 *
 * Select a slice between iterations by Shift+clicking (or Shift+⏎ in the menu) a timeline
 * row. See `rowSelection` for the rules.
 */

/** First 7 hex characters. The full commit goes in `title`. */
export function shortCommit(commit: string): string {
    return commit.slice(0, 7);
}

const STATUS_LABELS = {
    current: 'iteration.status.current',
    stale: 'iteration.status.stale',
    gone: 'iteration.status.gone',
    noRoute: 'iteration.status.noRoute',
    slice: 'iteration.status.slice',
    activeIteration: 'iteration.status.activeIteration',
    previousIteration: 'iteration.status.previousIteration',
} as const satisfies Readonly<Record<string, MessageKey>>;

/**
 * Status label. Local review has no PR: an iteration disappears from working-tree
 * history, so the wording must describe what the reviewer sees on screen.
 */
function statusText(status: keyof typeof STATUS_LABELS, t: Translate, localHost: boolean): string {
    return t(status === 'gone' && localHost ? 'iteration.status.goneLocal' : STATUS_LABELS[status]);
}

/** "snapshot 9f3c1ab · current", "diff a71d4e2 · no route" or "slice 9f3c1ab → a71d4e2". */
export function pillText(label: ViewingLabel, t: Translate, localHost = false): string {
    if (label.kind === 'slice') {
        return t('iteration.pill.slice', shortCommit(label.baseCommit), shortCommit(label.commit));
    }
    const status = statusText(label.status, t, localHost);
    return label.kind === 'snapshot'
        ? t('iteration.pill.snapshot', shortCommit(label.commit), status)
        : t('iteration.pill.diff', shortCommit(label.commit), status);
}

/** Full selected commits in the indicator tooltip let the reviewer compare them with the host. */
export function pillTitle(label: ViewingLabel, t: Translate): string {
    if (label.kind === 'slice') {
        return t('iteration.title.slice', label.baseCommit, label.commit);
    }
    return label.kind === 'snapshot'
        ? t('iteration.title.snapshot', label.commit)
        : t('iteration.title.iteration', label.commit);
}

/**
 * Row time. Usually rounded ("6 hr. ago"), but if the commit cannot distinguish the row,
 * use the exact time so 2 iterations of the same commit do not look identical.
 */
function rowTime(row: PickerRow, now: number, locale: Locale): string | null {
    if (row.createdAt === null) {
        return null;
    }
    return row.ambiguous ? formatDateTime(row.createdAt, locale) : relativeTime(row.createdAt, now, locale);
}

/**
 * Menu row: "9f3c1ab · 6 hr. ago · sonnet-5 · current" for a snapshot and
 * "a71d4e2 · active iteration · no route" for an iteration without a route.
 */
export function rowText(row: PickerRow, now: number, t: Translate, locale: Locale, localHost = false): string {
    const time = rowTime(row, now, locale);
    if (row.kind === 'diff') {
        // An iteration without a route shows no time. Its commit and status already identify it.
        const parts = [row.short];
        if (row.ambiguous && time !== null) {
            parts.push(time);
        }
        parts.push(statusText(row.status, t, localHost), t(STATUS_LABELS.noRoute));
        return parts.join(' · ');
    }
    const parts = [row.short];
    if (time !== null) {
        parts.push(time);
    }
    if (row.model !== null && row.model !== '') {
        parts.push(row.model);
    }
    parts.push(statusText(row.status, t, localHost));
    return parts.join(' · ');
}

/**
 * Snapshot provenance in words: "claude-code · sonnet-5 · 9f3c1ab" (docs/design/README.md §13). The route language
 * follows the same rule as the Overview indicator: append it only when it differs from the
 * tab language.
 */
export function provenanceText(row: PickerRow, t: Translate, uiLocale: Locale): string {
    const locale = row.locale ?? 'en';
    return join([row.harness, row.model, row.short, locale === uiLocale ? null : t(localeNameKey(locale))]);
}

/** The tooltip shows the same text with the full commit so the reviewer can compare it with the host. */
export function rowTitle(row: PickerRow): string {
    return join([row.harness, row.model, row.commit]);
}

function join(parts: readonly (string | null)[]): string {
    return parts.filter((part) => part !== null && part !== '').join(' · ');
}

/**
 * Rows marked by the selection. `current` marks the current snapshot row: it is absent from the URL,
 * but it is what the reviewer is viewing. A slice marks both edges, using the first row in
 * each iteration group. Intermediate rows are not marked.
 */
export function selectedRows(rows: readonly PickerRow[], viewing: Viewing): ReadonlySet<PickerRow> {
    if (viewing.kind === 'slice') {
        return new Set(
            [viewing.base, viewing.head]
                .map((diffId) => rows.find((row) => row.diffId === diffId))
                .filter((row) => row !== undefined),
        );
    }
    return new Set(
        rows.filter((row) =>
            viewing.kind === 'current' ? row.kind === 'snapshot' && row.latest : sameViewing(row.viewing, viewing),
        ),
    );
}

/** Shift+click hint: only when the host supports slices and there are iterations to compare. */
export function sliceHintVisible(rows: PickerRows): boolean {
    return rows.sliceOrder.size >= 2;
}

/** Shift+click on a row selects a slice, so the browser must not also select text. */
function keepSelectionOnShift(event: ReactMouseEvent): void {
    if (event.shiftKey) {
        event.preventDefault();
    }
}

export interface SnapshotMenu {
    readonly rows: PickerRows;
    readonly viewing: Viewing;
    /** Reference time for relative timestamps, injected to keep the gallery deterministic. */
    readonly now: number;
    /** Local review uses different wording for a past iteration because there is no PR. */
    readonly localHost?: boolean;
    readonly onSelect: (viewing: Viewing) => void;
    /** The gallery shows an open menu. */
    readonly initialOpen?: boolean;
}

export interface SnapshotPillProps {
    readonly label: ViewingLabel;
    /** Local review uses different wording for a past iteration because there is no PR. */
    readonly localHost?: boolean;
    /** Without a menu, the indicator is static because there is nothing to select. */
    readonly menu?: SnapshotMenu;
}

export function SnapshotPill({ label, localHost = false, menu }: SnapshotPillProps) {
    const t = useT();
    const text = pillText(label, t, localHost);
    const title = pillTitle(label, t);
    if (menu === undefined) {
        return (
            <span className="snapshot-pill" title={title}>
                {text}
            </span>
        );
    }
    return <SnapshotPillMenu label={label} text={text} title={title} menu={menu} />;
}

function SnapshotPillMenu({
    text,
    title,
    menu,
}: {
    label: ViewingLabel;
    text: string;
    title: string;
    menu: SnapshotMenu;
}) {
    const t = useT();
    const locale = useLocale();
    const [open, setOpen] = useState(menu.initialOpen ?? false);
    const flat = menu.rows.iterations;
    const selected = selectedRows(flat, menu.viewing);
    const selectedIndex = flat.findIndex((row) => selected.has(row));
    const [cursor, setCursor] = useState(Math.max(selectedIndex, 0));
    const rootRef = useRef<HTMLDivElement | null>(null);
    const buttonRef = useRef<HTMLButtonElement | null>(null);
    const listRef = useRef<HTMLDivElement | null>(null);
    const listId = useId();

    const close = useCallback((returnFocus: boolean): void => {
        setOpen(false);
        if (returnFocus) {
            buttonRef.current?.focus();
        }
    }, []);

    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: MouseEvent): void => {
            const { target } = event;
            if (!(target instanceof Node) || rootRef.current?.contains(target) !== true) {
                close(true);
            }
        };
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [close, open]);

    useEscapeLayer('popover', () => {
        close(true);
    }, open);

    // Focus moves to the list. `aria-activedescendant` moves the selection within it.
    useEffect(() => {
        if (open) {
            listRef.current?.focus();
        }
    }, [open]);

    const choose = (index: number, shift: boolean): void => {
        const row = flat[index];
        if (row === undefined) {
            return;
        }
        menu.onSelect(rowSelection(menu.rows, menu.viewing, row, shift));
        close(true);
    };

    const renderRow = (row: PickerRow, index: number) => {
        const checked = selected.has(row);
        return (
            <div
                key={`${row.kind}:${row.id}`}
                id={`${listId}-${String(index)}`}
                role="menuitemradio"
                aria-checked={checked}
                title={rowTitle(row)}
                data-snapshot={row.kind === 'snapshot' ? row.id : undefined}
                data-diff={row.kind === 'diff' ? row.id : undefined}
                className={`snapshot-picker__row${index === cursor ? ' is-cursor' : ''}`}
                onMouseEnter={() => {
                    setCursor(index);
                }}
                onMouseDown={keepSelectionOnShift}
                onClick={(event) => {
                    choose(index, event.shiftKey);
                }}
            >
                <span className="snapshot-picker__tick" aria-hidden="true">
                    {checked ? <Icon name="check" size={13} /> : null}
                </span>
                <span className="snapshot-picker__row-text">
                    {rowText(row, menu.now, t, locale, menu.localHost ?? false)}
                </span>
            </div>
        );
    };

    return (
        <div className="snapshot-picker" ref={rootRef}>
            <button
                type="button"
                ref={buttonRef}
                className="ctl snapshot-pill snapshot-pill--button"
                aria-haspopup="menu"
                aria-expanded={open}
                title={title}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        setCursor(Math.max(selectedIndex, 0));
                        setOpen(true);
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && !open) {
                        event.preventDefault();
                        setCursor(Math.max(selectedIndex, 0));
                        setOpen(true);
                    }
                }}
            >
                {text}
                <span className="snapshot-pill__caret" aria-hidden="true">
                    <Icon name="chev-down" size={13} />
                </span>
            </button>

            {open ? (
                <div
                    className="snapshot-picker__menu"
                    role="menu"
                    ref={listRef}
                    tabIndex={-1}
                    aria-label={t('iteration.menu.aria')}
                    aria-activedescendant={`${listId}-${String(cursor)}`}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setCursor((index) => Math.min(index + 1, flat.length - 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setCursor((index) => Math.max(index - 1, 0));
                        } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose(cursor, event.key === 'Enter' && event.shiftKey);
                        } else if (event.key === 'Tab') {
                            close(false);
                        }
                    }}
                >
                    <div className="snapshot-picker__section">{t('iteration.menu.timeline')}</div>
                    {flat.map(renderRow)}
                    {sliceHintVisible(menu.rows) ? (
                        <div className="snapshot-picker__hint">{t('iteration.menu.sliceHint')}</div>
                    ) : null}
                </div>
            ) : null}
        </div>
    );
}

/**
 * "Snapshots" card on Overview (docs/design/README.md §6): the same rows as the indicator menu,
 * plus a separate provenance line for each snapshot (docs/design/SPEC-elements.md §4.4).
 */
export function SnapshotsCard({
    rows,
    viewing,
    now,
    localHost = false,
    onSelect,
}: Omit<SnapshotMenu, 'initialOpen'>) {
    const t = useT();
    const locale = useLocale();
    const all = rows.iterations;
    if (all.length === 0) {
        return <p className="overview-card__empty">{t('iteration.empty')}</p>;
    }
    const selected = selectedRows(all, viewing);
    return (
        <ul className="snapshot-list">
            {all.map((row) => {
                const checked = selected.has(row);
                return (
                    <li key={`${row.kind}:${row.id}`}>
                        <button
                            type="button"
                            className={`snapshot-list__row${checked ? ' is-current' : ''}`}
                            aria-pressed={checked}
                            title={rowTitle(row)}
                            data-snapshot={row.kind === 'snapshot' ? row.id : undefined}
                            data-diff={row.kind === 'diff' ? row.id : undefined}
                            onMouseDown={keepSelectionOnShift}
                            onClick={(event) => {
                                onSelect(rowSelection(rows, viewing, row, event.shiftKey));
                            }}
                        >
                            <span className="snapshot-list__line">{rowText(row, now, t, locale, localHost)}</span>
                            {row.kind === 'snapshot' ? (
                                <span className="snapshot-list__provenance">
                                    {provenanceText(row, t, locale)}
                                </span>
                            ) : null}
                        </button>
                    </li>
                );
            })}
        </ul>
    );
}
