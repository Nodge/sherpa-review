import { fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { RouteSnapshot } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { createDiffViewStore } from '../diff-view/store.js';
import { createSessionStore } from '../session/session-store.js';
import { createThreadStore } from '../threads/store.js';
import { RouteWorkspace } from './route/route-workspace.tsx';
import { ViewFrame } from './view-frames.tsx';

/**
 * The ownership zone source uses the name supplied by the host (`ownershipSource`): GitHub uses
 * CODEOWNERS, another host uses its own name (MAINTAINERS here). The name appears both in the Overview header
 * and in the "My files" filter label rendered by Route and Full diff.
 */

const DATA = fixtureIteration('medium');
const FILE_IDS = new Set(DATA.diff.files.map((file) => file.fileId));
const SNAPSHOT: RouteSnapshot = (() => {
    const snapshot = routeFixtures('medium')?.states.ready?.snapshot ?? null;
    if (snapshot === null) {
        throw new Error('the medium fixture needs a ready route snapshot');
    }
    return snapshot;
})();


function render(ownershipSource: string | null, ownership = DATA.ownership): string {
    return renderToStaticMarkup(
        <ViewFrame
            view="overview"
            prKey="fixture-medium"
            session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
            diff={DATA.diff}
            lenses={{ ownership, extra: DATA.extraLenses, ownershipSource }}
            threads={DATA.threads}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            reviewHostAvailable
        />,
    );
}

describe('Overview: ownership zone source name', () => {
    it('labels zones with the CODEOWNERS source', () => {
        const html = render('CODEOWNERS');

        expect(html).toContain('CODEOWNERS · ');
        expect(html).toContain('Your ownership zone by CODEOWNERS.');
        expect(html).not.toContain('MAINTAINERS');
    });

    it('shows the host explanation even when the lens is working', () => {
        const note = 'GitHub did not tell which teams you are in (read:org scope?).';
        const ownership = DATA.ownership === null ? null : { ...DATA.ownership, note };

        expect(render('CODEOWNERS', ownership)).toContain(note);
    });

    it('labels zones with the MAINTAINERS source', () => {
        const html = render('MAINTAINERS');

        expect(html).toContain('MAINTAINERS · ');
        expect(html).toContain('Your ownership zone by MAINTAINERS.');
        expect(html).not.toContain('CODEOWNERS · ');
        expect(html).not.toContain('by CODEOWNERS');
    });
});

/** With the "My files" filter selected, the select shows the full label for the selected filter. */
function renderRoute(ownershipSource: string): string {
    return renderToStaticMarkup(
        <RouteWorkspace
            pr={DATA.pr}
            diff={DATA.diff}
            lenses={{ ownership: DATA.ownership, extra: DATA.extraLenses, ownershipSource }}
            snapshot={SNAPSHOT}
            session={createSessionStore({ initial: { view: 'route', filter: 'mine' } })}
            store={createDiffViewStore({ files: DATA.diff.files })}
            threadStore={createThreadStore(DATA.threads, FILE_IDS)}
            threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
            parse={(file) => Promise.resolve(parseFileDiff(toParseRequest(file)))}
            loadContent={() => Promise.resolve(null)}
            onSetViewed={() => Promise.resolve(0)}
            onSetStopViewed={() => Promise.resolve(0)}
        />,
    );
}

describe('Overview without lenses', () => {
    it('has no zone source in the header', () => {
        const html = renderToStaticMarkup(
            <ViewFrame
                view="overview"
                prKey="fixture-medium"
                session={createSessionStore({ initial: { view: 'overview', filter: 'all' } })}
                diff={DATA.diff}
                lenses={null}
                threads={DATA.threads}
                threadStore={createThreadStore(DATA.threads, FILE_IDS)}
                threadNow={Date.parse('2026-08-24T12:00:00.000Z')}
                reviewHostAvailable={false}
            />,
        );

        expect(html).toContain('>Ownership zone unavailable<');
        expect(html).not.toContain('CODEOWNERS · ');
    });
});

describe('"My files" filter: zone source name', () => {
    it('labels the filter with the CODEOWNERS source', () => {
        const html = renderRoute('CODEOWNERS');

        expect(html).toContain('My files · CODEOWNERS');
        expect(html).not.toContain('MAINTAINERS');
    });

    it('labels the local review filter with its own source', () => {
        const html = renderRoute('git diff');

        expect(html).toContain('My files · git diff');
        expect(html).not.toContain('My files · CODEOWNERS');
    });

    it('labels the filter with the MAINTAINERS source', () => {
        const html = renderRoute('MAINTAINERS');

        expect(html).toContain('My files · MAINTAINERS');
        expect(html).not.toContain('My files · CODEOWNERS');
    });
});
