// @vitest-environment jsdom
import { fixtureData } from '@sherpa/fixtures';
import type { Lens } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { FilterSelect } from './filter-select.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EDGE = fixtureData('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: true,
    note: null,
    zones: null,
};
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [EMPTY_PCI] });
const ACTIVE = selectFilter(FILTERS, 'all');

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

function mount() {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const onSelect = vi.fn<(id: string) => void>();

    act(() => {
        root.render(<FilterSelect filters={FILTERS} active={ACTIVE} onSelect={onSelect} />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    const button = host.querySelector<HTMLButtonElement>('.filter-select__button');
    if (button === null) {
        throw new Error('filter select has no button');
    }
    act(() => {
        button.click();
    });

    return { host, onSelect };
}

describe('FilterSelect items', () => {
    it('hides empty lenses and prevents selecting disabled "My files" by mouse or keyboard', () => {
        const { host, onSelect } = mount();
        const options = [...host.querySelectorAll<HTMLElement>('[role="option"]')];

        expect(options.map((option) => option.textContent.trim())).toEqual([
            `All files${String(FILES.length)}`,
            'My files · CODEOWNERS0',
        ]);
        const mine = options[1];
        expect(mine?.getAttribute('aria-disabled')).toBe('true');
        expect(mine?.title).toBe('You do not own any CODEOWNERS zone touched by this PR.');
        expect(host.textContent).not.toContain('PCI');
        expect(host.textContent).not.toContain('Generated');

        act(() => {
            mine?.click();
        });
        expect(onSelect).not.toHaveBeenCalled();
        expect(host.querySelector('[role="listbox"]')).not.toBeNull();

        const list = host.querySelector<HTMLElement>('[role="listbox"]');
        if (list === null) {
            throw new Error('filter select did not open its list');
        }
        act(() => {
            list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
        });
        act(() => {
            list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        expect(onSelect).not.toHaveBeenCalled();
        expect(host.querySelector('[role="listbox"]')).not.toBeNull();
    });
});
