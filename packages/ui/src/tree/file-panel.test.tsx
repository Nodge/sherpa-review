// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import type { Lens } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import { FilePanel } from './file-panel.tsx';
import { createT } from '../i18n/index.js';

const t = createT('en');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count }: { count: number }) => ({
        getTotalSize: () => count * 26,
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * 26,
                size: 26,
                end: (index + 1) * 26,
                lane: 0,
            })),
        scrollToIndex: () => undefined,
    }),
}));

const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: false,
    note: 'No files of this PR are in the PCI DSS scope.',
    zones: null,
};
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [EMPTY_PCI], t});
const ACTIVE = selectFilter(FILTERS, 'all');

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(readOnly = false) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onFilter = vi.fn<(id: string) => void>();
    const onOpenFile = vi.fn<(fileId: string) => void>();
    const onToggleViewed = vi.fn<(fileId: string) => void>();

    act(() => {
        root.render(
            <ReadOnlyIterationProvider readOnly={readOnly}>
                <FilePanel
                    files={FILES}
                    filters={FILTERS}
                    activeFilter={ACTIVE}
                    onFilter={onFilter}
                    pciFileIds={new Set()}
                    mineFileIds={new Set()}
                    readState={new Map()}
                    route={null}
                    activeFileId={null}
                    onOpenFile={onOpenFile}
                    onToggleViewed={onToggleViewed}
                    writeError={null}
                    outline={null}
                    onOpenHunk={() => undefined}
                />
            </ReadOnlyIterationProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, onFilter, onOpenFile, onToggleViewed };
}

describe('tree row tags', () => {
    it('a conflicted file gets a conflict tag (SPEC §4.1)', () => {
        const { host } = mount();
        const tags = [...host.querySelectorAll('.file-tree__tag--conflict')];

        expect(tags.map((tag) => tag.textContent)).toEqual(['conflict']);
        expect(FILES.filter((file) => file.changeType === 'conflict')).toHaveLength(1);
    });
});

describe('FilePanel filter chips', () => {
    it('hides PCI and generated with zero counts and shows My files disabled with a reason', () => {
        const { host, onFilter } = mount();
        const chips = [...host.querySelectorAll<HTMLButtonElement>('.file-panel__chip')];

        expect(chips.map((chip) => chip.textContent.trim())).toEqual([`All ${String(FILES.length)}`, 'Mine 0']);
        const mine = chips[1];
        expect(mine?.disabled).toBe(true);
        expect(mine?.title).toBe('You do not own any CODEOWNERS zone touched by this PR.');
        expect(host.textContent).not.toContain('PCI');
        expect(host.textContent).not.toContain('Generated');

        act(() => {
            mine?.click();
        });
        expect(onFilter).not.toHaveBeenCalled();
    });
});

describe('FilePanel viewed checkboxes', () => {
    it('uses a button outside the tab order to toggle viewed without opening the file', () => {
        const { host, onOpenFile, onToggleViewed } = mount();
        const button = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__read');
        const row = button?.closest<HTMLElement>('[role="treeitem"]');
        const tree = host.querySelector<HTMLElement>('[role="tree"]');

        expect(button).not.toBeNull();
        expect(button?.type).toBe('button');
        expect(button?.tabIndex).toBe(-1);
        expect(button?.getAttribute('aria-pressed')).toBe('false');
        expect(button?.getAttribute('aria-hidden')).toBe('true');

        act(() => {
            button?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(FILES.map((file) => file.fileId)).toContain(onToggleViewed.mock.calls[0]?.[0]);
        expect(onOpenFile).not.toHaveBeenCalled();
        expect(row?.classList.contains('is-cursor')).toBe(true);
        expect(tree?.getAttribute('aria-activedescendant')).toBe(row?.id);
    });

    it('omits the checkbox for directories but keeps the reading summary in the row title', () => {
        const { host } = mount();
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        expect(directory).not.toBeNull();
        expect(directory?.querySelector('.file-tree__read')).toBeNull();
        expect(directory?.title).toMatch(/^\d+ of \d+ read$/);
    });
});

describe('tree file menu', () => {
    it('opens the menu with the row "⋯" button without opening the file', () => {
        const { host, onOpenFile } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');

        expect(more?.tabIndex).toBe(-1);
        act(() => {
            more?.click();
        });

        const menu = document.body.querySelector('[role="menu"]');
        expect(menu?.querySelectorAll('[role="menuitem"]')).toHaveLength(4);
        expect(more?.getAttribute('aria-expanded')).toBe('true');
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('opens the same menu on row right-click and moves the cursor to that row', () => {
        const { host, onOpenFile } = mount();
        const row = host.querySelector<HTMLElement>('.file-tree__row--file');

        act(() => {
            row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 30, clientY: 44 }));
        });

        expect(document.body.querySelector('[role="menu"]')).not.toBeNull();
        expect(row?.classList.contains('is-cursor')).toBe(true);
        expect(onOpenFile).not.toHaveBeenCalled();
    });

    it('uses the same path for Viewed from the menu as for the viewed checkbox', () => {
        const { host, onToggleViewed } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');
        act(() => {
            more?.click();
        });

        const items = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        expect(items[3]?.textContent).toBe('Viewed');
        act(() => {
            items[3]?.click();
        });

        expect(onToggleViewed).toHaveBeenCalledTimes(1);
        expect(document.body.querySelector('[role="menu"]')).toBeNull();
    });

    it('keeps menu keys out of the tree so ⏎ does not open a file and arrows do not move the cursor', () => {
        const { host, onOpenFile } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        act(() => {
            host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more')?.click();
        });
        const cursor = tree?.getAttribute('aria-activedescendant');
        const item = document.body.querySelector<HTMLButtonElement>('[role="menuitem"]');

        act(() => {
            item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
            item?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });

        expect(onOpenFile).not.toHaveBeenCalled();
        expect(tree?.getAttribute('aria-activedescendant')).toBe(cursor);
    });

    it('closes the menu on a second click of the row "⋯" button', () => {
        const { host } = mount();
        const more = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more');

        // `click()` does not send mousedown, and the toggle relies on a mousedown + click pair.
        const press = (): void => {
            act(() => {
                more?.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
                more?.click();
            });
        };
        press();
        press();

        expect(document.body.querySelector('[role="menu"]')).toBeNull();
        expect(more?.getAttribute('aria-expanded')).toBe('false');
    });

    it('disables the menu mark in a previous iteration', () => {
        const { host, onToggleViewed } = mount(true);
        act(() => {
            host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__more')?.click();
        });

        const viewed = [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')][3];
        expect(viewed?.getAttribute('aria-disabled')).toBe('true');
        expect(viewed?.title).toBe('only in the active iteration');

        act(() => {
            viewed?.click();
        });
        expect(onToggleViewed).not.toHaveBeenCalled();
    });
});

describe('read-only viewed checkboxes', () => {
    it('disables the checkbox in a previous iteration and explains why', () => {
        const { host, onToggleViewed } = mount(true);
        const button = host.querySelector<HTMLButtonElement>('.file-tree__row--file .file-tree__read');

        expect(button?.disabled).toBe(true);
        expect(button?.title).toBe('only in the active iteration');

        act(() => {
            button?.click();
        });

        expect(onToggleViewed).not.toHaveBeenCalled();
    });
});
