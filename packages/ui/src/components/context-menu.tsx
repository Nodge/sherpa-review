import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useT } from '../i18n/index.js';
import { useReadOnlyIteration, useReadOnlyReason } from '../iterations/read-only.tsx';
import { useEscapeLayer } from '../shortcuts/context.tsx';
import { copyText } from './clipboard.js';
import './context-menu.css';

/**
 * File context menu (docs/design/SPEC-elements.md §2.11). Opens on a right click on the
 * card header or tree row, or through their "⋯" button. Item order is fixed.
 * Unavailable items stay disabled so the menu does not change shape between files.
 * The only optional item is "Comment on file" for image cards:
 * comments on other files attach to a line.
 *
 * The menu uses a portal in `body`. Cards clip their contents with `overflow`, and tree rows
 * are virtualized, so a menu inside them would only survive until the next scroll.
 */

/** Anchor point, at the pointer (right click) or below the button, aligned right ("⋯" button). */
export interface ContextMenuAnchor {
    readonly x: number;
    readonly y: number;
    readonly align: 'left' | 'right';
}

/** Action result. A string is an error shown with the menu left open. `null` closes it. */
type ItemOutcome = string | null;

export interface ContextMenuItem {
    readonly id: string;
    readonly label: string;
    readonly disabled?: boolean;
    /** Item tooltip. Explains why a disabled item is unavailable. */
    readonly title?: string | undefined;
    /** Draw a separator before this item. */
    readonly separatorBefore?: boolean;
    readonly onSelect: () => ItemOutcome | Promise<ItemOutcome>;
}

export interface ContextMenuProps {
    readonly items: readonly ContextMenuItem[];
    readonly anchor: ContextMenuAnchor;
    readonly label: string;
    /** `returnFocus` means the keyboard closed the menu, so focus must return to its origin. */
    readonly onClose: (returnFocus: boolean) => void;
    /**
     * The "⋯" button that opened the menu. Its mousedown does not close the menu, otherwise the toggle
     * would close on mousedown and immediately reopen on click.
     */
    readonly toggleRef?: RefObject<HTMLElement | null> | undefined;
}

/** Gap between the button and menu, and minimum distance from the window edge. */
const GAP = 4;
const VIEWPORT_MARGIN = 8;

/**
 * The component sets the menu width instead of CSS. The same value positions
 * its right edge against the button, and that calculation must not depend on whether CSS has loaded.
 */
const MENU_WIDTH = 240;

export function ContextMenu({ items, anchor, label, onClose, toggleRef }: ContextMenuProps) {
    const menuRef = useRef<HTMLDivElement | null>(null);
    const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const [cursor, setCursor] = useState(0);
    const [error, setError] = useState<string | null>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

    const close = useCallback(
        (returnFocus: boolean) => {
            onClose(returnFocus);
        },
        [onClose],
    );

    // Clamp the menu to the viewport. Otherwise a pointer near the bottom would push it below the screen,
    // and a button near the right edge would push it past that edge. Ignore windows without dimensions
    // (hidden tabs, offscreen rendering), which would always put the menu in the top-left corner.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (menu === null) {
            return;
        }
        const viewportWidth = window.innerWidth === 0 ? Number.POSITIVE_INFINITY : window.innerWidth;
        const viewportHeight = window.innerHeight === 0 ? Number.POSITIVE_INFINITY : window.innerHeight;
        const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - MENU_WIDTH - VIEWPORT_MARGIN);
        const maxTop = Math.max(VIEWPORT_MARGIN, viewportHeight - menu.offsetHeight - VIEWPORT_MARGIN);
        const wanted = anchor.align === 'right' ? anchor.x - MENU_WIDTH : anchor.x;
        setPosition({
            left: Math.min(Math.max(VIEWPORT_MARGIN, wanted), maxLeft),
            top: Math.min(Math.max(VIEWPORT_MARGIN, anchor.y), maxTop),
        });
    }, [anchor]);

    useEffect(() => {
        itemRefs.current[0]?.focus();
    }, []);

    // Outside clicks, scrolling and window resizing close the menu. It is anchored to a screen point,
    // not an element, so any of these events would make it point at the wrong place. The button
    // that opened it is an exception because its click toggles the menu.
    useEffect(() => {
        const onPointerDown = (event: globalThis.MouseEvent): void => {
            const { target } = event;
            if (!(target instanceof Node)) {
                close(false);
                return;
            }
            if (menuRef.current?.contains(target) === true || toggleRef?.current?.contains(target) === true) {
                return;
            }
            close(false);
        };
        const onViewportChange = (): void => {
            close(false);
        };
        window.addEventListener('mousedown', onPointerDown);
        window.addEventListener('scroll', onViewportChange, true);
        window.addEventListener('resize', onViewportChange);
        return () => {
            window.removeEventListener('mousedown', onPointerDown);
            window.removeEventListener('scroll', onViewportChange, true);
            window.removeEventListener('resize', onViewportChange);
        };
    }, [close, toggleRef]);

    useEscapeLayer('popover', () => {
        close(true);
    });

    const focusItem = (index: number): void => {
        const next = (index + items.length) % items.length;
        setCursor(next);
        itemRefs.current[next]?.focus();
    };

    const run = (item: ContextMenuItem): void => {
        if (item.disabled === true) {
            return;
        }
        const finish = (outcome: ItemOutcome): void => {
            if (typeof outcome === 'string') {
                setError(outcome);
            } else {
                close(true);
            }
        };
        const outcome = item.onSelect();
        if (outcome instanceof Promise) {
            void outcome.then(finish, (caught: unknown) => {
                setError(caught instanceof Error ? caught.message : String(caught));
            });
        } else {
            finish(outcome);
        }
    };

    const style =
        position === null
            ? { left: 0, top: 0, width: MENU_WIDTH, visibility: 'hidden' as const }
            : { left: position.left, top: position.top, width: MENU_WIDTH };

    return createPortal(
        <div
            className="context-menu"
            role="menu"
            aria-label={label}
            ref={menuRef}
            style={style}
            onKeyDown={(event) => {
                // The portal is in `body`, but events bubble to its parent in the React tree.
                // Tree keyboard handling (arrows, ⏎ to open a file) must not receive menu events.
                // Esc is an exception. The registry handles it through a window listener, which
                // must receive the event.
                if (event.key !== 'Escape') {
                    event.stopPropagation();
                }
                if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    focusItem(cursor + 1);
                } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    focusItem(cursor - 1);
                } else if (event.key === 'Home') {
                    event.preventDefault();
                    focusItem(0);
                } else if (event.key === 'End') {
                    event.preventDefault();
                    focusItem(items.length - 1);
                } else if (event.key === 'Tab') {
                    close(false);
                }
            }}
            onContextMenu={(event) => {
                event.preventDefault();
            }}
        >
            {items.map((item, index) => (
                <div key={item.id} className="context-menu__slot">
                    {item.separatorBefore === true ? <div className="context-menu__separator" role="none" /> : null}
                    <button
                        type="button"
                        role="menuitem"
                        className="context-menu__item"
                        ref={(element) => {
                            itemRefs.current[index] = element;
                        }}
                        aria-disabled={item.disabled === true ? true : undefined}
                        title={item.title}
                        onFocus={() => {
                            setCursor(index);
                        }}
                        onMouseEnter={() => {
                            itemRefs.current[index]?.focus();
                        }}
                        onClick={() => {
                            run(item);
                        }}
                    >
                        {item.label}
                    </button>
                </div>
            ))}
            {error === null ? null : (
                <p className="context-menu__error" role="status">
                    {error}
                </p>
            )}
        </div>,
        document.body,
    );
}

/**
 * Menu opening and focus restoration. After a right click, focus returns to the origin (the nearest
 * focusable ancestor, which is the `role="tree"` container with its cursor for the tree). The "⋯" button
 * gets focus back itself.
 */
export interface ContextMenuController {
    readonly anchor: ContextMenuAnchor | null;
    readonly open: boolean;
    /** Passed to `ContextMenu` so the "⋯" button can toggle the menu. */
    readonly toggleRef: RefObject<HTMLElement | null>;
    readonly openAtPointer: (event: ReactMouseEvent) => void;
    readonly openAtButton: (event: ReactMouseEvent<HTMLButtonElement>) => void;
    readonly close: (returnFocus: boolean) => void;
}

export function useContextMenu(): ContextMenuController {
    const [anchor, setAnchor] = useState<ContextMenuAnchor | null>(null);
    const origin = useRef<HTMLElement | null>(null);
    const toggleRef = useRef<HTMLElement | null>(null);

    const close = useCallback((returnFocus: boolean) => {
        setAnchor(null);
        const element = origin.current;
        origin.current = null;
        toggleRef.current = null;
        if (returnFocus && element !== null) {
            const focusable = element.closest<HTMLElement>('[tabindex], button, a[href]') ?? element;
            focusable.focus();
        }
    }, []);

    return {
        anchor,
        open: anchor !== null,
        toggleRef,
        openAtPointer: useCallback((event: ReactMouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            origin.current = event.currentTarget as HTMLElement;
            toggleRef.current = null;
            setAnchor({ x: event.clientX, y: event.clientY, align: 'left' });
        }, []),
        openAtButton: useCallback(
            (event: ReactMouseEvent<HTMLButtonElement>) => {
                event.stopPropagation();
                const button = event.currentTarget;
                // A second click on the same button closes the menu. Its mousedown leaves the menu alone,
                // so the full toggle happens here.
                if (toggleRef.current === button) {
                    close(true);
                    return;
                }
                origin.current = button;
                toggleRef.current = button;
                const box = button.getBoundingClientRect();
                setAnchor({ x: box.right, y: box.bottom + GAP, align: 'right' });
            },
            [close],
        ),
        close,
    };
}

/** File data used by the menu, the path and both host links. */
export interface FileMenuTarget {
    readonly path: string;
    readonly hostFileUrl: string | null;
    readonly blameUrl: string | null;
}

export interface FileContextMenuProps {
    readonly file: FileMenuTarget;
    readonly viewed: boolean;
    /** Why the viewed-mark item is disabled. `null` means enabled. */
    readonly viewedDisabledReason?: string | null;
    readonly onToggleViewed: () => void;
    /**
     * File comment without a line. Image cards have no lines but still need a place for comments.
     * Without a handler, the item is absent from the menu.
     */
    readonly onCommentFile?: (() => void) | undefined;
    readonly anchor: ContextMenuAnchor;
    readonly onClose: (returnFocus: boolean) => void;
    readonly toggleRef?: RefObject<HTMLElement | null> | undefined;
}

/**
 * Single-file menu: copy path and links, open the file on the web, toggle viewed. Marks
 * is only available in the active iteration, so read-only mode disables the last item
 * with the same reason as the viewed checkbox.
 */
export function FileContextMenu({
    file,
    viewed,
    viewedDisabledReason = null,
    onToggleViewed,
    onCommentFile,
    anchor,
    onClose,
    toggleRef,
}: FileContextMenuProps) {
    const t = useT();
    const readOnly = useReadOnlyIteration();
    const readOnlyReason = useReadOnlyReason();

    const copy = async (text: string): Promise<string | null> => {
        const outcome = await copyText(text);
        if (outcome === 'unavailable') {
            return t('selection.clipboardUnavailable');
        }
        return outcome === 'failed' ? t('selection.copyFailed') : null;
    };

    const items: ContextMenuItem[] = [
        {
            id: 'copy-path',
            label: t('file.menu.copyPath'),
            onSelect: () => copy(file.path),
        },
        {
            id: 'copy-link',
            label: t('file.menu.copyLink'),
            disabled: file.hostFileUrl === null,
            title: file.hostFileUrl === null ? t('file.menu.copyLinkUnavailable') : undefined,
            onSelect: () => copy(file.hostFileUrl ?? ''),
        },
        {
            id: 'open-web',
            label: t('file.menu.openWeb'),
            disabled: file.blameUrl === null,
            title: file.blameUrl === null ? t('file.menu.copyLinkUnavailable') : undefined,
            onSelect: () => {
                if (file.blameUrl !== null) {
                    window.open(file.blameUrl, '_blank', 'noopener');
                }
                return null;
            },
        },
    ];

    if (onCommentFile !== undefined) {
        items.push({
            id: 'comment-file',
            label: t('file.menu.commentFile'),
            disabled: readOnly,
            title: readOnly ? readOnlyReason : undefined,
            separatorBefore: true,
            onSelect: () => {
                onCommentFile();
                return null;
            },
        });
    }

    items.push({
        id: 'viewed',
        label: viewed ? t('file.menu.unmarkViewed') : t('file.menu.markViewed'),
        disabled: readOnly || viewedDisabledReason !== null,
        title: readOnly ? readOnlyReason : (viewedDisabledReason ?? undefined),
        separatorBefore: onCommentFile === undefined,
        onSelect: () => {
            onToggleViewed();
            return null;
        },
    });

    return <ContextMenu items={items} anchor={anchor} label={file.path} onClose={onClose} toggleRef={toggleRef} />;
}
