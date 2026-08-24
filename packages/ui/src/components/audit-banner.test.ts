import { describe, expect, it } from 'vitest';

import { auditScopeBannerVisible } from './audit-banner.tsx';

describe('audit scope banner', () => {
    it('appears only in Full diff with an active PCI filter', () => {
        expect(auditScopeBannerVisible('diff', 'pci', false, 3)).toBe(true);
        expect(auditScopeBannerVisible('overview', 'pci', false, 3)).toBe(false);
        expect(auditScopeBannerVisible('route', 'pci', false, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'all', false, 3)).toBe(false);
    });

    it('hides after dismissal and for an empty scope', () => {
        expect(auditScopeBannerVisible('diff', 'pci', true, 3)).toBe(false);
        expect(auditScopeBannerVisible('diff', 'pci', false, 0)).toBe(false);
    });
});
