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
    audit: { name: 'PCI DSS', tag: 'pci' },
};

function render(audit: FileFilter | null, pr = DATA.pr, active = false): string {
    return renderToStaticMarkup(
        <PrHeader
            pr={pr}
            counts={prHeaderCounts(DATA.diff)}
            audit={audit}
            auditActive={active}
            onToggleAudit={() => undefined}
        />,
    );
}

describe('standard PR header', () => {
    it('hides the audit chip when the lens is empty or unavailable', () => {
        expect(render(PCI)).toContain('pr-header__audit');
        expect(render({ ...PCI, count: 0, fileIds: new Set() })).not.toContain('pr-header__audit');
        expect(render({ ...PCI, available: false })).not.toContain('pr-header__audit');
        expect(render(null)).not.toContain('pr-header__audit');
    });

    it('names the audit scope from the lens name instead of its id', () => {
        const sox: FileFilter = { ...PCI, id: 'sox', audit: { name: 'SOX', tag: 'sox' } };
        const html = render(sox, DATA.pr, true);

        expect(html).toContain('SOX · 3 files');
        expect(html).toContain('title="Show only the SOX audit-scope files"');
        expect(html).toContain('aria-pressed="true"');
        expect(html).not.toContain('PCI');
    });

    it('omits the chip for a filter without audit metadata', () => {
        expect(render({ ...PCI, audit: null })).not.toContain('pr-header__audit');
    });

    it('uses two letters for a single-word login when the author has no avatar photo', () => {
        const author = { login: 'nolan', displayName: null, bot: false, avatarUrl: null };

        expect(render(null, { ...DATA.pr, author })).toContain(
            '<span class="avatar pr-header__avatar" aria-hidden="true">NO</span>',
        );
    });
});
