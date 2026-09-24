import { fixtureIteration } from '@sherpa/fixtures';
import { useMemo, useSyncExternalStore } from 'react';

import { toParseRequest } from '../../diff/model.js';
import { parseFileDiff } from '../../diff/parse.js';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { readStateOf } from '../../progress/read-state.js';
import { galleryActions } from './diff-states.tsx';

const BASE = fixtureIteration('medium').diff.files[0];
if (BASE === undefined) {
    throw new Error('missing fixture file');
}

// The card covers all markup elements: heading, bold, inline code, link,
// table, both list types, blockquote and code block. Otherwise some styles have no acceptance example.
const LINES = [
    '# Viewing contract',
    '',
    'Select **lower bound** to ask the agent what it means: the threshold is in `viewed.threshold`, ' +
        'and the explanation is in the [stop description](https://example.test/stop-2).',
    'The comment stays beside these lines in code mode too.',
    '',
    '| Status | Meaning |',
    '| --- | --- |',
    '| OK | Search complete |',
    '| Timeout | Partial result |',
    '',
    '- First category',
    '  - Independent filter',
    '',
    '1. Count lines',
    '2. Count explained lines',
    '',
    '> The counter may be incomplete.',
    '',
    '```ts',
    'const limit = 10;',
    '```',
];

const FILE = {
    ...BASE,
    fileId: 'markdown-gallery',
    path: 'docs/contract.md',
    additions: LINES.length,
    deletions: 0,
    changeType: 'add' as const,
    patch: `@@ -0,0 +1,${String(LINES.length)} @@\n${LINES.map((line) => '+' + line).join('\n')}`,
};

function State() {
    const store = useMemo(() => {
        const created = createDiffViewStore({ files: [FILE] });
        created.toggleMarkdown(FILE.fileId);
        return created;
    }, []);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const model = useMemo(() => parseFileDiff(toParseRequest(FILE)), []);

    return (
        <FileCard
            file={FILE}
            model={model}
            mode="unified"
            content={null}
            contentAvailable={false}
            expansion={new Map()}
            read={readStateOf({ file: FILE, record: null })}
            opened
            showWhitespace={false}
            markdown={snapshot.markdownShown.has(FILE.fileId)}
            selection={snapshot.selection}
            actions={galleryActions(store)}
            renderAfterLine={(_side, line) =>
                line === 3 ? (
                    // Expanded thread wrapper: its document indentation is checked against the block text.
                    <div className="thread-line">
                        <div className="file-card__notice">Reviewer comment: clarify the meaning of the lower bound.</div>
                    </div>
                ) : null
            }
        />
    );
}

export const MARKDOWN_STATES = [
    { id: 'markdown-review', title: 'document, selection and general discussion', render: () => <State /> },
];
