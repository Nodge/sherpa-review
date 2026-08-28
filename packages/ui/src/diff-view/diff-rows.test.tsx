// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { parseFileDiff } from '../diff/parse.js';
import { DiffRows } from './diff-rows.tsx';
import type { LineSelection } from './selection.js';

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'src/example.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -1,3 +1,3 @@\n const alpha = 1;\n-const beta = 2;\n+const beta = 3;\n export { alpha, beta };',
});

const SELECTION: LineSelection = { fileId: 'f1', anchor: 'd2', focus: 'c3:3' };

function render(mode: 'unified' | 'split'): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
        <DiffRows
            model={MODEL}
            mode={mode}
            content={null}
            selection={SELECTION}
            onCommentLine={() => undefined}
        />,
    );
    return host;
}

describe('line comment button', () => {
    it.each(['unified', 'split'] as const)('sits in the gutter and uses a 15px pencil in mode %s', (mode) => {
        const host = render(mode);
        const buttons = [...host.querySelectorAll<HTMLButtonElement>('.diff-row__comment')];

        expect(buttons.length).toBeGreaterThan(0);
        for (const button of buttons) {
            expect(button.parentElement?.classList.contains('diff-row__gutter--comment')).toBe(true);
            expect(button.querySelector('svg[data-icon="pencil"]')?.getAttribute('width')).toBe('15');
        }
    });

    it.each(['unified', 'split'] as const)('selection shows the button only on the first line in mode %s', (mode) => {
        const host = render(mode);
        const visible = host.querySelectorAll('.diff-row__comment.is-selection-start');

        expect(visible).toHaveLength(1);
        const key =
            mode === 'unified'
                ? visible[0]?.closest('.diff-row')?.getAttribute('data-key')
                : visible[0]?.parentElement?.getAttribute('data-key');
        expect(key).toBe('d2');
    });
});
