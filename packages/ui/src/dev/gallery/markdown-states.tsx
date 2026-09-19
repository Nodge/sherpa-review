import { fixtureIteration } from '@sherpa/fixtures';
import { useMemo, useSyncExternalStore } from 'react';
import { FileCard } from '../../diff-view/file-card.tsx';
import { createDiffViewStore } from '../../diff-view/store.js';
import { parseFileDiff } from '../../diff/parse.js';
import { toParseRequest } from '../../diff/model.js';
import { readStateOf } from '../../progress/read-state.js';
import { galleryActions } from './diff-states.tsx';
const base = fixtureIteration('medium').diff.files[0];
if (base === undefined) throw new Error('fixture file is missing');
const text = '# Viewing contract\n\nSelect **lower bound** to ask the agent what it means.\nThe comment stays at these lines in code view too.\n\n| Status | Meaning |\n| --- | --- |\n| OK | Search complete |\n| Timeout | Partial result |\n\n- First category\n  - Independent filter\n\n> The counter may be incomplete.\n\n```ts\nconst limit = 10;\n```';
const file = { ...base, fileId: 'markdown-gallery', path: 'docs/contract.md', additions: text.split('\n').length, deletions: 0, changeType: 'add' as const, patch: `@@ -0,0 +1,${String(text.split('\n').length)} @@\n${text.split('\n').map((line) => '+' + line).join('\n')}` };
function State() {
    const store = useMemo(() => createDiffViewStore({ files: [file] }), []);
    const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
    const model = useMemo(() => parseFileDiff(toParseRequest(file)), []);
    return <FileCard file={file} model={model} mode="unified" content={null} contentAvailable={false} expansion={new Map()} read={readStateOf({ file, record: null })} opened showWhitespace={false} selection={snapshot.selection} actions={galleryActions(store)} initialMarkdown renderAfterLine={(_side, line) => line === 3 ? <div className="file-card__notice">Reviewer comment: clarify what the lower bound means.</div> : null} />;
}
export const MARKDOWN_STATES = [{ id: 'markdown-review', title: 'document, selection and shared discussion', render: () => <State /> }];
