// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileMenuTarget } from './context-menu.tsx';
import { FileContextMenu, useContextMenu } from './context-menu.tsx';

/**
 * File context menu (SPEC §2.11): both ways to open it, wrapping keyboard navigation,
 * disabled items without actions, and focus restoration. The clipboard is mocked because jsdom has none.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FILE: FileMenuTarget = {
    path: 'services/orders/src/domain/order.ts',
    hostFileUrl: 'https://github.com/quillmart/quillmart/blob/9f3c1ab/services/orders/src/domain/order.ts',
    blameUrl: 'https://github.com/quillmart/quillmart/blame/9f3c1ab/services/orders/src/domain/order.ts',
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    setClipboard(undefined);
});

/** `undefined` means the browser has no Clipboard API. */
function setClipboard(clipboard: { writeText: (text: string) => Promise<void> } | undefined): void {
    Object.defineProperty(navigator, 'clipboard', { value: clipboard, configurable: true });
}

interface Mounted {
    readonly host: HTMLElement;
    readonly trigger: HTMLButtonElement;
    readonly onToggleViewed: ReturnType<typeof vi.fn>;
    /** Keys that reached the wrapper. The menu must stop its own keys except Esc. */
    readonly rowKeys: string[];
}

function mount(file: FileMenuTarget = FILE, viewed = false): Mounted {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onToggleViewed = vi.fn();
    const rowKeys: string[] = [];

    act(() => {
        root.render(
            <Harness
                file={file}
                viewed={viewed}
                onToggleViewed={onToggleViewed}
                onRowKey={(key) => rowKeys.push(key)}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const trigger = host.querySelector<HTMLButtonElement>('.harness-more');
    if (trigger === null) {
        throw new Error('wrapper has no "⋯" button');
    }
    return { host, trigger, onToggleViewed, rowKeys };
}

/**
 * The wrapper reproduces both entry points, the "⋯" button and a right click on the row. The row is focusable
 * and has its own keyboard handling, like the card header and tree container.
 */
function Harness({
    file,
    viewed,
    onToggleViewed,
    onRowKey,
}: {
    file: FileMenuTarget;
    viewed: boolean;
    onToggleViewed: () => void;
    onRowKey: (key: string) => void;
}) {
    const menu = useContextMenu();
    return (
        <div
            className="harness-row"
            tabIndex={-1}
            onContextMenu={menu.openAtPointer}
            onKeyDown={(event) => {
                onRowKey(event.key);
            }}
        >
            <button type="button" className="harness-more" onClick={menu.openAtButton}>
                ⋯
            </button>
            {menu.anchor === null ? null : (
                <FileContextMenu
                    file={file}
                    viewed={viewed}
                    onToggleViewed={onToggleViewed}
                    anchor={menu.anchor}
                    onClose={menu.close}
                    toggleRef={menu.toggleRef}
                />
            )}
        </div>
    );
}

function menuElement(): HTMLElement {
    const menu = document.body.querySelector<HTMLElement>('[role="menu"]');
    if (menu === null) {
        throw new Error('menu did not open');
    }
    return menu;
}

function items(): HTMLButtonElement[] {
    return [...menuElement().querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function press(key: string): void {
    act(() => {
        menuElement().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    });
}

/** Full mouse sequence. `click()` alone does not send mousedown, which the menu listens for. */
function pressTrigger(trigger: HTMLButtonElement): void {
    act(() => {
        trigger.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        trigger.click();
    });
}

describe('file context menu', () => {
    it('opens a fixed set of items with the first focused when "⋯" is clicked', () => {
        const { trigger } = mount();

        act(() => {
            trigger.click();
        });

        expect(items().map((item) => item.textContent)).toEqual([
            'Copy path',
            'Copy file link',
            'Open on the web',
            'Viewed',
        ]);
        expect(document.activeElement).toBe(items()[0]);
    });

    it('opens the same menu on a right click on the row', () => {
        const { host } = mount();

        act(() => {
            host.querySelector('.harness-row')?.dispatchEvent(
                new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }),
            );
        });

        expect(items()).toHaveLength(4);
    });

    it('wraps arrow navigation and jumps to the ends with Home and End', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        press('ArrowUp');
        expect(document.activeElement).toBe(items()[3]);
        press('ArrowDown');
        expect(document.activeElement).toBe(items()[0]);
        press('End');
        expect(document.activeElement).toBe(items()[3]);
        press('Home');
        expect(document.activeElement).toBe(items()[0]);
    });

    it('runs the "Viewed" action and closes the menu with focus restored', () => {
        const { trigger, onToggleViewed } = mount();
        act(() => {
            trigger.click();
        });

        act(() => {
            items()[3]?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('copies the path to the clipboard and closes the menu', async () => {
        const written: string[] = [];
        setClipboard({
            writeText: (text) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        await act(async () => {
            items()[0]?.click();
            await Promise.resolve();
        });

        expect(written).toEqual([FILE.path]);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it('keeps the menu open and explains the failure without a clipboard', async () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        await act(async () => {
            items()[1]?.click();
            await Promise.resolve();
        });

        expect(menuElement().querySelector('.context-menu__error')?.textContent).toBe('The clipboard is unavailable.');
    });

    it('disables the item for a file without a host link and ignores clicks', async () => {
        const written: string[] = [];
        setClipboard({
            writeText: (text) => {
                written.push(text);
                return Promise.resolve();
            },
        });
        const { trigger } = mount({ ...FILE, hostFileUrl: null });
        act(() => {
            trigger.click();
        });

        const link = items()[1];
        expect(link?.getAttribute('aria-disabled')).toBe('true');
        expect(link?.title).toBe('у хоста нет веб-ссылки');

        await act(async () => {
            link?.click();
            await Promise.resolve();
        });

        expect(written).toEqual([]);
        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
    });

    it('offers to clear the mark for a viewed file', () => {
        const { trigger } = mount(FILE, true);
        act(() => {
            trigger.click();
        });

        expect(items()[3]?.textContent).toBe('Clear the mark');
    });

    it('closes on an outside click without restoring focus', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        act(() => {
            window.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).not.toBe(trigger);
    });

    it('closes on a second click on "⋯"', () => {
        const { trigger } = mount();

        pressTrigger(trigger);
        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();

        pressTrigger(trigger);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).toBe(trigger);
    });

    it('stops menu keys from reaching the row but lets Esc through', () => {
        const { trigger, rowKeys } = mount();
        act(() => {
            trigger.click();
        });

        press('ArrowDown');
        press('Home');
        press('Enter');
        expect(rowKeys).toEqual([]);

        press('Escape');
        expect(rowKeys).toEqual(['Escape']);
    });

    it('restores focus to the row on close after a right click', () => {
        const { host } = mount();
        const row = host.querySelector<HTMLElement>('.harness-row');

        act(() => {
            row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 60 }));
        });
        act(() => {
            items()[3]?.click();
        });

        expect(document.activeElement).toBe(row);
    });

    it('closes on Tab without restoring focus', () => {
        const { trigger } = mount();
        act(() => {
            trigger.click();
        });

        press('Tab');

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(document.activeElement).not.toBe(trigger);
    });
});
