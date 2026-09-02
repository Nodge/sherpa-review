import { fixtureIteration } from '@sherpa/fixtures';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FileFilter } from '../filters/lens-filters.js';
import { PrHeader, prHeaderCounts } from './pr-header.tsx';

const DATA = fixtureIteration('medium');
const PCI: FileFilter = {
    id: 'pci',
    label: 'PCI DSS files',
    shortLabel: 'PCI',
    count: 3,
    available: true,
    note: null,
    fileIds: new Set(DATA.diff.files.slice(0, 3).map((file) => file.fileId)),
};

function render(pci: FileFilter | null): string {
    return renderToStaticMarkup(
        <PrHeader
            pr={DATA.pr}
            counts={prHeaderCounts(DATA.diff)}
            pci={pci}
            pciActive={false}
            onTogglePci={() => undefined}
        />,
    );
}

describe('standard PR header', () => {
    it('hides the PCI chip when the lens has zero files or is unavailable', () => {
        expect(render(PCI)).toContain('pr-header__pci');
        expect(render({ ...PCI, count: 0, fileIds: new Set() })).not.toContain('pr-header__pci');
        expect(render({ ...PCI, available: false })).not.toContain('pr-header__pci');
        expect(render(null)).not.toContain('pr-header__pci');
    });
});
