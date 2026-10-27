import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FileFilter } from '../filters/lens-filters.js';

import { AuditScopeBanner, auditScopeBannerVisible } from './audit-banner.tsx';

describe('audit scope banner', () => {
    it('appears where the audit filter hides files: Full diff and the route', () => {
        expect(auditScopeBannerVisible('diff', 'sox', 'sox', false, 3)).toBe(true);
        expect(auditScopeBannerVisible('route', 'sox', 'sox', false, 3)).toBe(true);
        expect(auditScopeBannerVisible('overview', 'sox', 'sox', false, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'all', 'sox', false, 3)).toBe(false);
    });

    it('recognizes the audit filter by its contents, not its id, and shows no banner without an audit lens', () => {
        expect(auditScopeBannerVisible('diff', 'pci', null, false, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'pci', 'sox', false, 3)).toBe(false);
    });

    it('hides after dismissal and for an empty scope', () => {
        expect(auditScopeBannerVisible('diff', 'sox', 'sox', true, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'sox', 'sox', false, 0)).toBe(false);
    });
});

describe('audit scope banner text', () => {
    const SOX: FileFilter = {
        id: 'sox',
        label: 'SOX files',
        shortLabel: 'SOX',
        count: 2,
        available: true,
        note: null,
        fileIds: new Set(['a', 'b']),
        audit: { name: 'SOX', tag: 'sox' },
    };

    it('uses the scope name from the lens description', () => {
        const html = renderToStaticMarkup(
            createElement(AuditScopeBanner, {
                filter: SOX,
                stats: { files: 2, changedLines: 10, totalFiles: 5, totalChangedLines: 40 },
                paths: ['src/a.ts', 'src/b.ts'],
                onShowAll: () => undefined,
                onDismiss: () => undefined,
            }),
        );

        expect(html).toContain('<span class="audit-banner__tag">SOX</span>');
        expect(html).toContain('src/a.ts, src/b.ts');
        expect(html).not.toContain('PCI');
    });
});
