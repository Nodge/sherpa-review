import { fixtureData } from '@sherpa/fixtures';
import type { FileDiff } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { toParseRequest } from '../diff/model.js';
import { parseFileDiff } from '../diff/parse.js';
import { readStateOf } from '../progress/read-state.js';
import type { FileCardActions } from './file-card.tsx';
import { FileCard } from './file-card.tsx';

const DATA = fixtureData('edge');

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
