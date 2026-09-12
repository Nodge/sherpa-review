import { fixtureIteration } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { readStateOf } from '../progress/read-state.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { BlobLoaderProvider } from './blob-loader.tsx';
import type { FileCardActions } from './file-card.tsx';
import { expansionAnnouncement, FileCard } from './file-card.tsx';
import { createT } from '../i18n/index.js';

const t = createT('en');

const DATA = fixtureIteration('edge');

const ACTIONS: FileCardActions = {
    onViewed: () => Promise.resolve(null),
    onExpand: () => Promise.resolve({ feedback: null, content: null, expansion: new Map() }),
    onRetryParse: () => undefined,
    onOpenFile: () => undefined,
    onShowWhitespace: () => undefined,
    onSelectStart: () => undefined,
    onSelectExtend: () => undefined,
};

function render(file: FileDiff, hint = false): string {
    return renderToStaticMarkup(
        <FileCard
            file={file}
            model={parseFileDiff(toParseRequest(file))}
            mode="unified"
            content={null}
            contentAvailable={false}
            expansion={new Map()}
            read={readStateOf({ file, record: null })}
            opened={false}
            showWhitespace={false}
            initialHint={
                hint
                    ? {
                          text: 'action failed',
                          retry: () => Promise.resolve(null),
                      }
                    : null
            }
            selection={null}
            actions={ACTIONS}
        />,
    );
}

describe('file card', () => {
    it('conflicting file gets a header badge (docs/design/SPEC-elements.md §2.14, §4.1)', () => {
        const conflict = DATA.diff.files.find((file) => file.changeType === 'conflict');
        const plain = DATA.diff.files.find((file) => file.changeType === 'modify' && !file.binary);
        if (conflict === undefined || plain === undefined) {
            throw new Error('edge fixture needs a conflicting file and a regular file');
        }

        expect(render(conflict)).toContain('file-card__badge--conflict');
        expect(render(conflict)).toContain('>conflict</span>');
        expect(render(plain)).not.toContain('file-card__badge--conflict');
    });

    it('old rename path separates directories and filename for different truncation', () => {
        const renamed = DATA.diff.files.find((file) => file.oldPath !== null && file.oldPath !== file.path);
        const oldPath = renamed?.oldPath ?? null;
        if (renamed === undefined || oldPath === null) {
            throw new Error('edge fixture needs a renamed file');
        }
        const cut = oldPath.lastIndexOf('/');
        const html = render(renamed);

        expect(html).toContain(
            `<span class="file-card__old-path file-card__path-dir"><bdi>${oldPath.slice(0, cut)}</bdi></span>`,
        );
        expect(html).toContain(
            `<span class="file-card__old-path file-card__path-name"><bdi>${oldPath.slice(cut)}</bdi></span>`,
        );
    });

    it('collapsed card summary uses the supplied slice counters', () => {
        const file = DATA.diff.files.find(
            (candidate) => !candidate.binary && candidate.additions !== 3 && candidate.deletions !== 2,
        );
        if (file === undefined) {
            throw new Error('edge fixture needs a text file');
        }

        const html = renderToStaticMarkup(
            <FileCard
                file={file}
                model={parseFileDiff(toParseRequest(file))}
                mode="unified"
                content={null}
                contentAvailable={false}
                expansion={new Map()}
                read={readStateOf({ file, record: null })}
                collapseReason="manual"
                onToggleCollapse={() => undefined}
                opened
                showWhitespace={false}
                counts={{ additions: 3, deletions: 2 }}
                selection={null}
                actions={ACTIONS}
            />,
        );
        const summary = html.slice(html.indexOf('file-card__collapsed--file'));

        expect(summary).toContain('+3');
        expect(summary).toContain('−2');
        expect(summary).not.toContain(`+${String(file.additions)}`);
        expect(summary).not.toContain(`−${String(file.deletions)}`);
    });
    it('header has a menu button and context expansion, blame is in the menu and no editor action appears', () => {
        const source = DATA.diff.files.find((file) => !file.binary);
        if (source === undefined) {
            throw new Error('edge fixture needs a text file');
        }

        const html = render({ ...source, blameUrl: 'https://example.test/blame' }, true);

        // The header accepts focus so the menu can return focus here after a right click.
        expect(html).toContain('class="file-card__header" tabindex="-1"');
        expect(html).toContain('class="file-card__header-action"');
        expect(html).toContain('aria-label="File actions"');
        expect(html).toContain('>Expand the file</button>');
        // The blame link now lives in the menu instead of a separate header control.
        expect(html).not.toContain('>Blame</a>');
        expect(html).not.toContain('https://example.test/blame');
        expect(html).not.toContain('Open in editor');
        // The menu is closed, so its items are absent from the markup.
        expect(html).not.toContain('Copy file link');
        expect(html).toContain('class="file-card__action">retry</button>');
    });

    it('leaves the binary file notice without an action', () => {
        const file = DATA.diff.files.find((candidate) => candidate.binary);
        if (file === undefined) {
            throw new Error('edge fixture needs a binary file');
        }

        expect(file.image).toBeNull();
        const html = render(file);

        expect(html).toContain('<p class="file-card__notice">binary file not shown</p>');
        expect(html).not.toContain('Open in editor');
    });

    it('image without blob transport keeps the same notice and becomes an image card with transport', () => {
        const file = fixtureIteration('medium').diff.files.find((candidate) => candidate.image !== null);
        if (file === undefined) {
            throw new Error('medium fixture needs an image');
        }

        // A host without `capabilities.blobs` supplies no transport, so the card behaves as before.
        expect(render(file)).toContain('binary file not shown');

        const withBlobs = renderToStaticMarkup(
            <BlobLoaderProvider loadBlob={() => Promise.resolve(null)}>
                <FileCard
                    file={file}
                    model={parseFileDiff(toParseRequest(file))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file, record: null })}
                    opened={false}
                    showWhitespace={false}
                    selection={null}
                    actions={ACTIONS}
                />
            </BlobLoaderProvider>,
        );

        expect(withBlobs).not.toContain('binary file not shown');
        expect(withBlobs).toContain('image-card__modes');
    });

    it('image card hides the binary notice but preserves file permission changes', () => {
        const svg = fixtureIteration('medium').diff.files.find(
            (candidate) => candidate.image !== null && candidate.patch !== null,
        );
        if (svg === undefined) {
            throw new Error('medium fixture needs an svg image with a patch');
        }
        const withMode: FileDiff = { ...svg, patch: `old mode 100644\nnew mode 100755\n${svg.patch ?? ''}` };

        const html = renderToStaticMarkup(
            <BlobLoaderProvider loadBlob={() => Promise.resolve(null)}>
                <FileCard
                    file={withMode}
                    model={parseFileDiff(toParseRequest(withMode))}
                    mode="unified"
                    content={null}
                    contentAvailable={false}
                    expansion={new Map()}
                    read={readStateOf({ file: withMode, record: null })}
                    opened={false}
                    showWhitespace={false}
                    selection={null}
                    actions={ACTIONS}
                />
            </BlobLoaderProvider>,
        );

        expect(html).toContain('image-card__modes');
        expect(html).not.toContain('binary file not shown');
        expect(html).toContain(t('diff.notice.mode', '100644', '100755'));
    });
});

describe('"Expand file" in a route slice', () => {
    const CLIP_SOURCE: FileDiff = {
        fileId: 'f-clip',
        path: 'src/clip.ts',
        oldPath: null,
        changeType: 'modify',
        binary: false,
        generated: false,
        additions: 4,
        deletions: 0,
        patch: ['@@ -1,2 +1,6 @@', ' alpha', '+one', '+', '+two', '+three', ' omega', ''].join('\n'),
        viewed: null,
        blameUrl: null,
        hostFileUrl: null,
        image: null,
    };
    const CLIP_CONTENT: FileContent = {
        oldText: 'alpha\nomega\n',
        newText: 'alpha\none\n\ntwo\nthree\nomega\n',
    };

    function renderClipped(anchors: readonly AnchorSpan[]): string {
        const model = parseFileDiff(toParseRequest(CLIP_SOURCE));
        return renderToStaticMarkup(
            <FileCard
                file={CLIP_SOURCE}
                model={clipModelToAnchors(model, anchors).model}
                mode="unified"
                content={CLIP_CONTENT}
                contentAvailable
                expansion={new Map()}
                read={readStateOf({ file: CLIP_SOURCE, record: null })}
                opened={false}
                showWhitespace={false}
                selection={null}
                actions={ACTIONS}
            />,
        );
    }

    it('reports changed lines from other stops instead of saying the whole file is visible', () => {
        // Only changes from other stops lie between anchors at new lines 2 and 5: hiddenLines 0, hiddenChanged 2.
        const html = renderClipped([
            { side: 'new', start: 2, end: 2 },
            { side: 'new', start: 5, end: 5 },
        ]);

        expect(html).toContain('all context is on screen; 2 changed lines — in other stops');
        expect(html).not.toContain('the whole file is already on screen');
        expect(html).toContain('disabled=""');
    });

    it('keeps the original text when no changed lines from other stops remain', () => {
        const html = renderClipped([{ side: 'new', start: 2, end: 5 }]);

        expect(html).toContain('the whole file is already on screen');
        expect(html).not.toContain('in other stops');
    });
});

describe('announcement after loading more context', () => {
    it('reports two counts in Full diff, including a zero remainder', () => {
        expect(expansionAnnouncement(20, 59, 0, t)).toBe('20 lines loaded, 59 hidden');
        expect(expansionAnnouncement(14, 0, 0, t)).toBe('14 lines loaded, 0 hidden');
    });

    it('reports changed lines from other stops in a route slice instead of saying 0 hidden', () => {
        expect(expansionAnnouncement(5, 0, 2, t)).toBe('5 lines loaded, 2 changed lines — in other stops');
    });

    it('reports both counts in a route slice with remaining context', () => {
        expect(expansionAnnouncement(20, 7, 3, t)).toBe(
            '20 lines loaded, 7 hidden, 3 changed lines — in other stops',
        );
    });
});
