// @vitest-environment jsdom
import { fixtureData } from '@sherpa/fixtures';
import type { Lens } from '@sherpa/protocol';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { FilePanel } from './file-panel.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const EDGE = fixtureData('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const EMPTY_PCI: Lens = {
    id: 'pci',
    label: 'PCI DSS',
    paths: [],
    available: false,
    note: 'No files of this PR are in the PCI DSS scope.',
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
    const onFilter = vi.fn<(id: string) => void>();

    act(() => {
        root.render(
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
                onOpenFile={() => undefined}
                onToggleViewed={() => undefined}
                writeError={null}
                outline={{ state: 'empty', reason: 'Nothing to outline.' }}
                onOpenHunk={() => undefined}
                prKey="fixture-edge-zero-lenses"
                storage={null}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });

    return { host, onFilter };
}

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
