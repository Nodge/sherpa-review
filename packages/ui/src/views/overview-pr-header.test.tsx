import { fixtureIteration } from '@sherpa/fixtures';
import type { Lens, PrChecks, PrMeta } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { ViewFrame } from './view-frames.tsx';

/**
 * PR header in Overview (prototype `docs/design/Sherpa.dc.html`, Overview screen): number and diff counters
 * in the metadata row, author with time, branches and check status.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const NOW = Date.parse('2026-08-24T12:00:00.000Z');

function render(
    options: {
        pr?: PrMeta | null;
        checks?: PrChecks | null;
        withDiff?: boolean;
        extraLenses?: Lens[];
    } = {},
): string {
    const pr =
        options.pr === undefined
            ? { ...DATA.pr, ...(options.checks === undefined ? {} : { checks: options.checks }) }
            : options.pr;
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            pr={pr}
            diff={options.withDiff === false ? null : DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: options.extraLenses ?? DATA.extraLenses, ownershipSource: 'CODEOWNERS' }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={NOW}
            reviewHostAvailable
        />,
    );
}

describe('PR header in Overview', () => {
    it('metadata row: PR number, diff counters and audit scope chip', () => {
        const html = render();

        expect(html).toContain('PR 4821');
        expect(html).toContain(`+${String(sum('additions'))}`);
        expect(html).toContain(`−${String(sum('deletions'))}`);
        expect(html).toContain(`${String(DATA.diff.files.length)} file`);
        expect(html).toContain('PCI DSS');
    });

    it('keeps only the PR number in the metadata row without a diff', () => {
        const html = render({ withDiff: false });

        expect(html).toContain('PR 4821');
        expect(html).not.toContain(`${String(DATA.diff.files.length)} files`);
        expect(html).not.toContain('PCI DSS');
    });

    it('has no audit scope chip when the PR does not touch it or the lens is unavailable', () => {
        const pci = DATA.extraLenses.find((lens) => lens.id === 'pci');
        if (pci === undefined) {
            throw new Error('medium fixture has no pci lens');
        }

        expect(render()).toContain('pr-header__audit-tag');
        expect(render({ extraLenses: [{ ...pci, paths: [] }] })).not.toContain('pr-header__audit-tag');
        expect(render({ extraLenses: [{ ...pci, available: false }] })).not.toContain('pr-header__audit-tag');
        expect(render({ extraLenses: [{ ...pci, audit: null }] })).not.toContain('pr-header__audit-tag');
    });

    it('uses the lens description name in the UI language for the audit scope marker', () => {
        const pci = DATA.extraLenses.find((lens) => lens.audit !== null);
        if (pci === undefined) {
            throw new Error('medium fixture has no audit lens');
        }
        const sox: Lens = {
            ...pci,
            id: 'sox',
            audit: { name: { en: 'SOX', ru: 'SOX-audit' }, short: { en: 'SOX', ru: 'SOX' }, tag: 'sox' },
        };

        const html = render({ extraLenses: [sox] });

        expect(html).toContain('<span class="pr-header__audit-tag">SOX</span>');
        expect(html).not.toContain('PCI DSS');
    });

    it('author row: login, relative time, branches and check status', () => {
        const html = render({ checks: 'passed' });

        expect(html).toContain(DATA.pr.author.login);
        expect(html).toContain('ago');
        expect(html).toContain(`${DATA.pr.toBranch} ← ${DATA.pr.fromBranch}`);
        expect(html).toContain('checks passed');
        // Overview has no avatar. It remains in the Route and Full diff headers.
        expect(html).not.toContain('pr-header__avatar');
    });

    it('labels failed and pending checks with their respective states', () => {
        expect(render({ checks: 'failed' })).toContain('checks failed');
        expect(render({ checks: 'pending' })).toContain('checks running');
    });

    it('does not render the segment without a check status', () => {
        const html = render({ checks: null });

        expect(html).not.toContain('pr-header__checks');
        expect(html).toContain(`${DATA.pr.toBranch} ← ${DATA.pr.fromBranch}`);
    });

    it('has no header before metadata arrives', () => {
        const html = render({ pr: null });

        expect(html).not.toContain('pr-header');
        // The rest of Overview still renders as before.
        expect(html).toContain('Files by ownership zone');
    });
});

function sum(key: 'additions' | 'deletions'): number {
    return DATA.diff.files.reduce((total, file) => total + file[key], 0);
}
