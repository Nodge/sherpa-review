import type { ChatExchange, FileDiff } from '@sherpa/protocol';

import { SelectionPopover } from '../../components/selection-popover.tsx';
import { parseFileDiff } from '../../diff/parse.js';
import type { LineSelection } from '../../diff-view/selection.js';

const FILE: FileDiff = {
    fileId: 'gallery-selection-file',
    path: 'src/review/cache.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    patch: ['@@ -40,3 +40,5 @@', ' const cached = readCache(key);', '-return cached;', '+if (cached !== null) {', '+    return cached;', '+}', ' return load(key);', ''].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const SELECTION: LineSelection = {
    fileId: FILE.fileId,
    side: 'new',
    anchor: 'a41',
    focus: 'a43',
};
const EXCHANGE: ChatExchange = {
    id: 17,
    question: 'Why is null checked separately?',
    anchor: {
        fileId: FILE.fileId,
        path: FILE.path,
        side: 'new',
        start: 41,
        end: 43,
    },
    status: 'queued',
    answer: null,
    progressText: null,
    error: null,
    createdAt: '2026-09-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
};

export const M3_T5_STATES = [
    { id: 'selection-popover-rest', title: 'idle', render: () => <PopoverState mode="rest" connected /> },
    { id: 'selection-popover-question', title: 'entering a question', render: () => <PopoverState mode="question" connected /> },
    { id: 'selection-popover-disabled', title: 'agent disconnected', render: () => <PopoverState mode="rest" connected={false} /> },
    { id: 'selection-popover-in-flight', title: 'question sent', render: () => <PopoverState mode="sent" connected /> },
] as const;

function PopoverState({ mode, connected }: { mode: 'rest' | 'question' | 'sent'; connected: boolean }) {
    return (
        <div className="gallery-selection-popover selection-popover-host">
            <div className="gallery-selection-popover__card">
                <div className="gallery-selection-popover__header">cache.ts</div>
                <div className="gallery-selection-popover__row">40&nbsp;&nbsp; const cached = readCache(key);</div>
                <div className="gallery-selection-popover__row is-selected">41 + if (cached !== null) &#123;</div>
                <div className="gallery-selection-popover__row is-selected">42 + &nbsp;&nbsp;&nbsp; return cached;</div>
                <div className="gallery-selection-popover__row is-selected">43 + &#125;</div>
                <div className="gallery-selection-popover__row">44&nbsp;&nbsp; return load(key);</div>
            </div>
            <SelectionPopover
                host={null}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected={connected}
                onAsk={() => Promise.resolve(EXCHANGE)}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode, position: { left: 130, top: 142 } }}
            />
        </div>
    );
}
