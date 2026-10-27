// @vitest-environment jsdom
import { fixtureIteration, PCI_AUDIT } from '@sherpa/fixtures';
import type { FileDiff, Lens } from '@sherpa/protocol';
import { createRef } from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FileFilter } from '../filters/lens-filters.js';
import { buildFileFilters, findAuditFilter, selectFilter } from '../filters/lens-filters.js';
import { ReadOnlyIterationProvider } from '../iterations/read-only.tsx';
import type { FileReadState, ReadState } from '../progress/read-state.js';
import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { FilePanelProps, FileTreeCursor } from './file-panel.tsx';
import { FilePanel } from './file-panel.tsx';
import { createT } from '../i18n/index.js';

const t = createT('en');

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const virtual = vi.hoisted(() => ({ measure: vi.fn() }));

vi.mock('@tanstack/react-virtual', () => ({
    defaultRangeExtractor: () => [],
    useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
        measure: virtual.measure,
        getTotalSize: () => count * estimateSize(),
        getVirtualItems: () =>
            Array.from({ length: count }, (_, index) => ({
                index,
                key: index,
                start: index * estimateSize(),
                size: estimateSize(),
                end: (index + 1) * estimateSize(),
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
    audit: PCI_AUDIT,
};
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [EMPTY_PCI], t});

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount(
    readOnly = false,
    filters: readonly FileFilter[] = FILTERS,
    settings: UiSettingsStore = createUiSettingsStore({ loaded: true }),
    props: Partial<FilePanelProps> = {},
) {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onFilter = vi.fn<(id: string) => void>();
    const onOpenFile = vi.fn<(fileId: string) => void>();
    const onToggleViewed = vi.fn<(fileId: string) => void>();
    const cursorRef = createRef<FileTreeCursor>();
    const prState = createUiPrStateStore();

    act(() => {
        root.render(
            <SettingsProvider store={settings}>
                <PrStateProvider store={prState}>
                    <ReadOnlyIterationProvider readOnly={readOnly}>
                        <FilePanel
                            files={FILES}
                            filters={filters}
                            activeFilter={selectFilter(filters, 'all')}
                            onFilter={onFilter}
                            auditFilter={null}
                            mineFileIds={new Set()}
                            readState={new Map()}
                            route={null}
                            activeFileId={null}
                            onOpenFile={onOpenFile}
                            onToggleViewed={onToggleViewed}
                            writeError={null}
                            outline={null}
                            onOpenHunk={() => undefined}
                            cursorRef={cursorRef}
                            {...props}
                        />
                    </ReadOnlyIterationProvider>
                </PrStateProvider>
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, onFilter, onOpenFile, onToggleViewed, cursorRef };
}

describe('tree row tags', () => {
    it('gives a conflicting file the conflict tag (SPEC-elements §4.1)', () => {
        const { host } = mount();
        const tags = [...host.querySelectorAll('.file-tree__tag--conflict')];

        expect(tags.map((tag) => tag.textContent)).toEqual(['conflict']);
        expect(FILES.filter((file) => file.changeType === 'conflict')).toHaveLength(1);
    });

    it('gives audit-filter files its tag regardless of scope', () => {
        const [first] = FILES;
        if (first === undefined) {
            throw new Error('the edge fixture has no files');
        }
        const sox: Lens = {
            id: 'sox',
            label: 'SOX',
            paths: [first.path],
            available: true,
            note: null,
            zones: null,
            audit: { name: { en: 'SOX', ru: 'SOX' }, short: { en: 'SOX', ru: 'SOX' }, tag: 'sox' },
        };
        const filters = buildFileFilters({ files: FILES, ownership: null, extra: [sox], t });
        const { host } = mount(false, filters, undefined, { auditFilter: findAuditFilter(filters) });
        const tags = [...host.querySelectorAll('.file-tree__tag')].filter(
            (tag) => !tag.classList.contains('file-tree__tag--conflict') && !tag.classList.contains('file-tree__tag--gen'),
        );

        expect(tags.map((tag) => tag.textContent)).toEqual(['sox']);
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

    it('omits the chip row when All files is the only filter', () => {
        const single = buildFileFilters({ files: FILES, ownership: null, extra: [EMPTY_PCI], t });
        expect(single.map((filter) => filter.id)).toEqual(['all']);

        const { host } = mount(false, single);

        expect(host.querySelector('.file-panel__chips')).toBeNull();
        expect(host.querySelector('.file-panel__search')).not.toBeNull();
    });

    it('shows the chip row for 2 or more filters', () => {
        const { host } = mount();

        expect(host.querySelectorAll('.file-panel__chips .file-panel__chip')).toHaveLength(2);
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

    it('omits the chevron slot on files and aligns files and directories at the same level', () => {
        const { host } = mount();
        const rows = [...host.querySelectorAll<HTMLElement>('.file-tree__row')];
        const files = rows.filter((row) => row.classList.contains('file-tree__row--file'));

        expect(files.length).toBeGreaterThan(0);
        for (const row of files) {
            expect(row.querySelector('.file-tree__chevron')).toBeNull();
        }
        const indentsByLevel = new Map<string, Set<string>>();
        for (const row of rows) {
            const level = row.getAttribute('aria-level') ?? '';
            indentsByLevel.set(level, (indentsByLevel.get(level) ?? new Set()).add(row.style.paddingLeft));
        }
        for (const indents of indentsByLevel.values()) {
            expect(indents.size).toBe(1);
        }
    });
});

describe('dimming read items in the tree', () => {
    function file(path: string, patch: Partial<FileDiff> = {}): FileDiff {
        return {
            fileId: `f-${path}`,
            path,
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 10,
            deletions: 2,
            patch: null,
            viewed: null,
            blameUrl: null,
            hostFileUrl: null,
            image: null,
            ...patch,
        };
    }

    function read(state: ReadState): FileReadState {
        return { state, seen: state === 'read' ? 12 : state === 'partial' ? 5 : 0, total: 12, pinned: false, generatedDefault: false };
    }

    const files = [
        file('done/a.ts'),
        file('done/b.ts'),
        file('mixed/c.ts'),
        file('mixed/d.ts'),
        file('mixed/e.ts'),
        // A generated file without a progress record is read by default (`readStateOf`).
        file('gen/schema.ts', { generated: true }),
    ];
    const readState = new Map<string, FileReadState>([
        ['f-done/a.ts', read('read')],
        ['f-done/b.ts', read('read')],
        ['f-mixed/c.ts', read('read')],
        ['f-mixed/d.ts', read('partial')],
        ['f-mixed/e.ts', read('unread')],
    ]);

    function mountTree(props: Partial<FilePanelProps> = {}) {
        // My files includes only `mixed`, so `done` and `gen` become roots outside your ownership zone.
        return mount(false, FILTERS, undefined, {
            files,
            readState,
            mineFileIds: new Set(['f-mixed/c.ts', 'f-mixed/d.ts', 'f-mixed/e.ts']),
            ...props,
        });
    }

    function row(host: HTMLElement, kind: 'file' | 'dir', name: string): HTMLElement {
        const found = [...host.querySelectorAll<HTMLElement>(`.file-tree__row--${kind}`)].find(
            (candidate) => candidate.querySelector('.file-tree__label-name')?.textContent === name,
        );
        if (found === undefined) {
            throw new Error(`the tree has no row ${kind} ${name}`);
        }
        return found;
    }

    it('gives a read file is-read but omits it for partial and unread files', () => {
        const { host } = mountTree();

        expect(row(host, 'file', 'a.ts').classList.contains('is-read')).toBe(true);
        expect(row(host, 'file', 'c.ts').classList.contains('is-read')).toBe(true);
        expect(row(host, 'file', 'd.ts').classList.contains('is-read')).toBe(false);
        expect(row(host, 'file', 'e.ts').classList.contains('is-read')).toBe(false);
    });

    it('dims a directory only when all its files are read', () => {
        const { host } = mountTree();

        expect(row(host, 'dir', 'done').classList.contains('is-read')).toBe(true);
        expect(row(host, 'dir', 'mixed').classList.contains('is-read')).toBe(false);
    });

    it('marks both a generated row and a root outside your ownership zone as read', () => {
        const { host } = mountTree();

        expect([...row(host, 'file', 'schema.ts').classList]).toEqual(
            expect.arrayContaining(['is-generated', 'is-read']),
        );
        expect([...row(host, 'dir', 'done').classList]).toEqual(expect.arrayContaining(['is-foreign', 'is-read']));
        expect([...row(host, 'dir', 'gen').classList]).toEqual(
            expect.arrayContaining(['is-generated', 'is-foreign', 'is-read']),
        );
    });

    it('counts visible files for a directory and dims it when the lens has no unread files', () => {
        const { host } = mountTree({
            files: files.filter((candidate) => candidate.path !== 'mixed/d.ts' && candidate.path !== 'mixed/e.ts'),
        });

        expect(row(host, 'dir', 'mixed').classList.contains('is-read')).toBe(true);
    });

    it('gives an active read row both classes and relies on CSS to prevent dimming', () => {
        const { host } = mountTree({ activeFileId: 'f-done/a.ts' });

        expect([...row(host, 'file', 'a.ts').classList]).toEqual(expect.arrayContaining(['is-active', 'is-read']));
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

/**
 * The `v` command belongs to the full diff view and has 2 targets: a file card and a tree row.
 * The panel only exposes its cursor and marks file rows with `data-file` so a row
 * under the mouse can be a target too.
 */
describe('tree cursor for the `v` key', () => {
    it('sets data-file on a file row but not on a directory row', () => {
        const { host } = mount();
        const file = host.querySelector<HTMLElement>('.file-tree__row--file');
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        expect(FILES.map((candidate) => candidate.fileId)).toContain(file?.dataset.file);
        expect(directory?.dataset.file).toBeUndefined();
    });

    it('exposes the cursor only while the tree has focus', () => {
        const { host, cursorRef } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        const row = host.querySelector<HTMLElement>('.file-tree__row--file');

        // No cursor yet because the tree has not been navigated.
        expect(cursorRef.current?.cursorFileId()).toBeNull();

        act(() => {
            row?.click();
        });
        // The cursor is set, but focus is outside the tree, so it supplies no target.
        expect(cursorRef.current?.cursorFileId()).toBeNull();

        act(() => {
            tree?.focus();
        });
        expect(cursorRef.current?.cursorFileId()).toBe(row?.dataset.file);

        act(() => {
            tree?.blur();
        });
        expect(cursorRef.current?.cursorFileId()).toBeNull();
    });

    it('returns no file when the cursor is on a directory', () => {
        const { host, cursorRef } = mount();
        const tree = host.querySelector<HTMLElement>('[role="tree"]');
        const directory = host.querySelector<HTMLElement>('.file-tree__row--dir');

        act(() => {
            directory?.click();
            tree?.focus();
        });

        expect(cursorRef.current?.cursorFileId()).toBeNull();
    });
});


describe('tree geometry from CSS', () => {
    it('uses subtree sizes when settings differ and updates them on theme changes', async () => {
        const style = document.createElement('style');
        style.textContent = `
            .file-tree { --tree-row-height: 31px; --tree-indent-step: 27px; }
            [data-theme="sample-light"] .file-tree { --tree-row-height: 19px; --tree-indent-step: 15px; }
        `;
        document.head.append(style);
        mounted.push(() => {
            style.remove();
        });
        const settings = createUiSettingsStore({ loaded: true, initial: { style: 'sample' } });
        const { host } = mount(false, FILTERS, settings);
        const rows = [...host.querySelectorAll<HTMLElement>('[role="treeitem"]')];
        const secondRow = rows[1];
        expect(secondRow?.style.top).toBe('31px');
        const nestedRow = rows.find((row) => row.getAttribute('aria-level') === '2');
        expect(nestedRow?.style.paddingLeft).toBe('53px');

        virtual.measure.mockClear();
        await act(async () => {
            host.setAttribute('data-theme', 'sample-light');
            await Promise.resolve();
        });

        expect(secondRow?.style.top).toBe('19px');
        // The shared 26px indentation for the route marker stays on both files and directories.
        expect(nestedRow?.style.paddingLeft).toBe('41px');
        expect(virtual.measure).toHaveBeenCalled();
    });
});
