import type { FileContent } from '@sherpa/protocol';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { expandFileContext, expandGap, gapKeyOf } from '../diff-view/expand.js';
import type { LineSelection } from '../diff-view/selection.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import {
    calculateSelectionPopoverPosition,
    chatAnchorFromSelection,
    SelectionPopover,
    selectionAskDisabled,
    selectionScrolledPast,
} from './selection-popover.tsx';

const DIFF_ID = 'iter-1';
const FILE = {
    fileId: 'f1',
    path: 'src/cache.ts',
    oldPath: null,
    changeType: 'modify' as const,
    binary: false,
    additions: 3,
    deletions: 1,
    generated: false,
    viewed: false,
    blameUrl: null,
    hostFileUrl: null,
    patch: ['@@ -10,3 +10,5 @@', ' keep', '-old', '+new', '+extra', ' tail', ''].join('\n'),
};
const MODEL = parseFileDiff(FILE);
const SELECTION: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'a11', focus: 'a12' };
describe('Selection popover', () => {
    it('sits below the range and flips above it near the viewport bottom', () => {
        const base = {
            host: { top: 20, left: 100, width: 800, scrollTop: 300, scrollLeft: 0 },
            selection: { top: 200, bottom: 240, left: 220, right: 620 },
            popover: { width: 360, height: 44 },
            viewportHeight: 700,
        };

        expect(calculateSelectionPopoverPosition(base)).toEqual({ left: 140, top: 528, placement: 'below' });
        expect(
            calculateSelectionPopoverPosition({
                ...base,
                selection: { ...base.selection, top: 640, bottom: 680 },
            }),
        ).toEqual({ left: 140, top: 868, placement: 'above' });
        expect(calculateSelectionPopoverPosition({ ...base, gap: 120 }).top).toBe(580);
    });

    it('stays clear of the sticky toolbar and floating action bar', () => {
        const base = {
            host: { top: 20, left: 100, width: 800, scrollTop: 300, scrollLeft: 0 },
            selection: { top: 580, bottom: 600, left: 220, right: 620 },
            popover: { width: 360, height: 44 },
            viewportHeight: 700,
            viewportTop: 50,
            viewportBottom: 631,
        };

        expect(calculateSelectionPopoverPosition(base)).toEqual({ left: 140, top: 808, placement: 'above' });
        expect(
            calculateSelectionPopoverPosition({
                ...base,
                selection: { ...base.selection, top: 60, bottom: 80 },
                viewportBottom: 100,
            }),
        ).toEqual({ left: 140, top: 338, placement: 'above' });
    });

    it('closes only after scrolling more than 200px from the opening position', () => {
        expect(selectionScrolledPast(500, 300)).toBe(false);
        expect(selectionScrolledPast(500, 299)).toBe(true);
        expect(selectionScrolledPast(500, 701)).toBe(true);
    });

    it('builds a contract anchor from the selection side and range', () => {
        expect(chatAnchorFromSelection(FILE, MODEL, SELECTION, DIFF_ID)).toEqual({
            diffId: DIFF_ID,
            fileId: 'f1',
            path: 'src/cache.ts',
            side: 'new',
            start: 11,
            end: 12,
        });
        expect(chatAnchorFromSelection(FILE, MODEL, { ...SELECTION, fileId: 'other' }, DIFF_ID)).toBeNull();
    });

    it('counts expanded lines using the model rendered by the card', () => {
        if (MODEL.content.kind !== 'text') {
            throw new Error('the test needs a text model');
        }
        const gap = MODEL.content.blocks.find((block) => block.kind === 'gap' && block.edge === 'leading');
        if (gap?.kind !== 'gap') {
            throw new Error('the test needs a leading gap');
        }
        const lines = Array.from({ length: 20 }, (_, index) => `line-${String(index + 1)}`);
        const content: FileContent = { oldText: lines.join('\n'), newText: lines.join('\n') };
        const expanded = expandFileContext(MODEL, content, expandGap(new Map(), gapKeyOf(gap), 'up', 2));
        const selection: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'c8:8', focus: 'c9:9' };

        expect(chatAnchorFromSelection(FILE, MODEL, selection, DIFF_ID)).toBeNull();
        expect(chatAnchorFromSelection(FILE, expanded, selection, DIFF_ID)).toEqual({
            diffId: DIFF_ID,
            fileId: FILE.fileId,
            path: FILE.path,
            side: 'new',
            start: 8,
            end: 9,
        });
        expect(
            renderToStaticMarkup(
                <SelectionPopover
                    host={null}
                    diffId={DIFF_ID}
                    file={FILE}
                    model={expanded}
                    selection={selection}
                    dragging={false}
                    agentConnected
                    onAsk={() => undefined}
                    onComment={() => undefined}
                    onClear={() => undefined}
                    gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
                />,
            ),
        ).toContain('2 lines selected');
    });

    it('counts a route range using only lines in the card slice', () => {
        const routeFile = {
            ...FILE,
            patch: ['@@ -1,10 +1,10 @@', ' one', '-old-2', '+new-2', ' three', ' four', ' five', ' six', ' seven', ' eight', '-old-9', '+new-9', ' ten'].join('\n'),
        };
        const raw = parseFileDiff(routeFile);
        const clipped = clipModelToAnchors(
            raw,
            [
                { side: 'new', start: 2, end: 2 },
                { side: 'new', start: 9, end: 9 },
            ],
            0,
        ).model;
        const selection: LineSelection = { fileId: FILE.fileId, side: 'new', anchor: 'a2', focus: 'a9' };
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={routeFile}
                model={clipped}
                selection={selection}
                dragging={false}
                agentConnected
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('2 lines selected');
        expect(html).not.toContain('9 lines selected');
    });

    it('collapses the popover to a chip for a real non-terminal exchange with the same anchor', () => {
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected
                inFlight
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'sent', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('asked · the answer will land here');
        expect(html).not.toContain('Ask the agent');
    });

    it('blocks only the question when the agent is disconnected and sets the exact title', () => {
        expect(selectionAskDisabled(false)).toBe(true);
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected={false}
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('disabled=""');
        expect(html).toContain('title="Reconnect the agent to ask about a selection"');
        expect(html).toContain('Comment');
        expect(html).toContain('Copy link');
    });

    it('gives a custom disabled reason priority over a connected agent and explains it in the title', () => {
        const html = renderToStaticMarkup(
            <SelectionPopover
                host={null}
                diffId={DIFF_ID}
                file={FILE}
                model={MODEL}
                selection={SELECTION}
                dragging={false}
                agentConnected
                askDisabledReason="a question cannot be anchored to a file in a slice"
                onAsk={() => undefined}
                onComment={() => undefined}
                onClear={() => undefined}
                gallery={{ mode: 'rest', position: { left: 20, top: 20 } }}
            />,
        );

        expect(html).toContain('title="a question cannot be anchored to a file in a slice"');
        expect(html).not.toContain('title="Reconnect the agent to ask about a selection"');
    });
});
