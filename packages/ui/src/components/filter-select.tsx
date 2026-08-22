import { useCallback, useEffect, useId, useRef, useState } from 'react';

import type { FileFilter } from '../filters/lens-filters.js';
import './filter-select.css';

/**
 * File filter select (SPEC §2.7, README §Filters): a "label + count" button and a
 * 250px dropdown with a ✓ beside the active item.
 *
 * Keyboard follows SPEC: ↓ opens, ↑/↓ navigate, ⏎ selects, Esc and an outside click close
 * and restore focus to the button. Arrow keys can still reach disabled items so the reviewer can read
 * why they are unavailable, but cannot select them.
 */

export interface FilterSelectProps {
    readonly filters: readonly FileFilter[];
    readonly active: FileFilter;
    readonly onSelect: (id: string) => void;
}

export function FilterSelect({ filters, active, onSelect }: FilterSelectProps) {
    const [open, setOpen] = useState(false);
    const [cursor, setCursor] = useState(0);
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

    const openAt = (): void => {
        setCursor(Math.max(0, filters.indexOf(active)));
        setOpen(true);
    };

    // An outside click closes the list and restores focus to the button (SPEC §2.7). Button focus
    // is temporary. If the reviewer clicked a focusable element, the browser immediately moves focus
    // there. This prevents the keyboard from losing focus altogether.
    useEffect(() => {
        if (!open) {
            return;
        }
        const onPointerDown = (event: MouseEvent): void => {
            const { target } = event;
            const inside = target instanceof Node && rootRef.current?.contains(target) === true;
            if (!inside) {
                close(true);
            }
        };
        window.addEventListener('mousedown', onPointerDown);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
        };
    }, [close, open]);

    // Focus moves to the list. `aria-activedescendant` moves selection inside it,
    // so arrow keys do not move focus across ten buttons.
    useEffect(() => {
        if (open) {
            listRef.current?.focus();
        }
    }, [open]);

    const choose = (index: number): void => {
        const filter = filters[index];
        if (filter?.available !== true) {
            return;
        }
        onSelect(filter.id);
        close(true);
    };

    return (
        <div className="filter-select" ref={rootRef}>
            <button
                type="button"
                ref={buttonRef}
                className={`filter-select__button${active.fileIds === null ? '' : ' is-active'}`}
                aria-haspopup="listbox"
                aria-expanded={open}
                onClick={() => {
                    if (open) {
                        close(false);
                    } else {
                        openAt();
                    }
                }}
                onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' && !open) {
                        event.preventDefault();
                        openAt();
                    }
                }}
            >
                {active.label}
                <span className="filter-select__count">{active.count}</span>
                <span className="filter-select__caret" aria-hidden="true">
                    ⌄
                </span>
            </button>

            {open ? (
                <div
                    className="filter-select__menu"
                    role="listbox"
                    ref={listRef}
                    tabIndex={-1}
                    aria-label="File filter"
                    aria-activedescendant={`${listId}-${String(cursor)}`}
                    onKeyDown={(event) => {
                        if (event.key === 'ArrowDown') {
                            event.preventDefault();
                            setCursor((index) => Math.min(index + 1, filters.length - 1));
                        } else if (event.key === 'ArrowUp') {
                            event.preventDefault();
                            setCursor((index) => Math.max(index - 1, 0));
                        } else if (event.key === 'Enter' || event.key === ' ') {
                            event.preventDefault();
                            choose(cursor);
                        } else if (event.key === 'Escape') {
                            event.preventDefault();
                            close(true);
                        } else if (event.key === 'Tab') {
                            close(false);
                        }
                    }}
                >
                    {filters.map((filter, index) => (
                        <div
                            key={filter.id}
                            id={`${listId}-${String(index)}`}
                            role="option"
                            aria-selected={filter.id === active.id}
                            aria-disabled={!filter.available}
                            title={filter.available ? undefined : (filter.note ?? 'filter unavailable')}
                            className={`filter-select__option${index === cursor ? ' is-cursor' : ''}`}
                            onMouseEnter={() => {
                                setCursor(index);
                            }}
                            onClick={() => {
                                choose(index);
                            }}
                        >
                            <span className="filter-select__tick" aria-hidden="true">
                                {filter.id === active.id ? '✓' : ''}
                            </span>
                            <span className="filter-select__label">{filter.label}</span>
                            <span className="filter-select__count">{filter.count}</span>
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    );
}
