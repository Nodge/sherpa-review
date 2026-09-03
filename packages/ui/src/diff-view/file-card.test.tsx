import { fixtureIteration } from '@sherpa/fixtures';
import type { FileContent, FileDiff } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { readStateOf } from '../progress/read-state.js';
import type { AnchorSpan } from '../route/anchor-clip.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import type { FileCardActions } from './file-card.tsx';
import { expansionAnnouncement, FileCard } from './file-card.tsx';

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
    it('a conflicted file gets a badge in the header (SPEC §2.14, §4.1)', () => {
        const conflict = DATA.diff.files.find((file) => file.changeType === 'conflict');
        const plain = DATA.diff.files.find((file) => file.changeType === 'modify' && !file.binary);
        if (conflict === undefined || plain === undefined) {
            throw new Error('edge fixture needs a conflicting file and a regular file');
        }

        expect(render(conflict)).toContain('file-card__badge--conflict');
        expect(render(conflict)).toContain('>conflict</span>');
        expect(render(plain)).not.toContain('file-card__badge--conflict');
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
    it('keeps Blame and context expansion as buttons, without copy/open actions', () => {
        const source = DATA.diff.files.find((file) => !file.binary);
        if (source === undefined) {
            throw new Error('edge fixture needs a text file');
        }

        const html = render({ ...source, blameUrl: 'https://example.test/blame' }, true);

        expect(html).toContain('class="file-card__header-action"');
        expect(html).toContain('>Blame</a>');
        expect(html).toContain('>Expand the file</button>');
        expect(html).not.toContain('Copy file link');
        expect(html).not.toContain('Open in editor');
        expect(html).toContain('class="file-card__action">retry</button>');
    });

    it('leaves the binary file notice without an action', () => {
        const file = DATA.diff.files.find((candidate) => candidate.binary);
        if (file === undefined) {
            throw new Error('edge fixture needs a binary file');
        }

        const html = render(file);

        expect(html).toContain('<p class="file-card__notice">binary file not shown</p>');
        expect(html).not.toContain('Open in editor');
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
        expect(expansionAnnouncement(20, 59, 0)).toBe('20 lines loaded, 59 hidden');
        expect(expansionAnnouncement(14, 0, 0)).toBe('14 lines loaded, 0 hidden');
    });

    it('reports changed lines from other stops in a route slice instead of saying 0 hidden', () => {
        expect(expansionAnnouncement(5, 0, 2)).toBe('5 lines loaded, 2 changed lines — in other stops');
    });

    it('reports both counts in a route slice with remaining context', () => {
        expect(expansionAnnouncement(20, 7, 3)).toBe(
            '20 lines loaded, 7 hidden, 3 changed lines — in other stops',
        );
    });
});
