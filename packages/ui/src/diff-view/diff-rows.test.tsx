// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { FileContent } from '@sherpa/protocol';

import { parseFileDiff } from '../diff/parse.js';
import { clipModelToAnchors } from '../route/anchor-clip.js';
import { DiffRows } from './diff-rows.tsx';
import type { LineSelection } from './selection.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MODEL = parseFileDiff({
    fileId: 'f1',
    path: 'src/example.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -1,3 +1,3 @@\n const alpha = 1;\n-const beta = 2;\n+const beta = 3;\n export { alpha, beta };',
});

const SELECTION: LineSelection = { fileId: 'f1', anchor: 'd2', focus: 'c3:3' };
const GAP_MODEL = parseFileDiff({
    fileId: 'f2',
    path: 'src/gaps.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -21,1 +21,1 @@\n-old-21\n+new-21\n@@ -51,1 +51,1 @@\n-old-51\n+new-51\n',
});
const REMAINDER_MODEL = parseFileDiff({
    fileId: 'f3',
    path: 'src/remainder.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: '@@ -21,1 +21,1 @@\n-old-21\n+new-21\n@@ -41,1 +41,1 @@\n-old-41\n+new-41\n',
});
const GAP_LINES = Array.from({ length: 80 }, (_, index) => `line-${String(index + 1)}`);
const GAP_CONTENT: FileContent = { oldText: GAP_LINES.join('\n'), newText: GAP_LINES.join('\n') };
const LONG_MODEL = parseFileDiff({
    fileId: 'f-long',
    path: 'src/long.ts',
    oldPath: null,
    changeType: 'modify',
    binary: false,
    patch: [
        '@@ -1,1 +1,1 @@',
        `-const endpoint = "https://wrap-fixture.invalid/payload/${'b'.repeat(600)}/orders";`,
        `+\tconst endpoint = "https://wrap-fixture.invalid/payload/${'a'.repeat(600)}/orders";   `,
        '\\ No newline at end of file',
    ].join('\n'),
});

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

function renderGaps(mode: 'unified' | 'split', model = GAP_MODEL): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToStaticMarkup(
        <DiffRows model={model} mode={mode} content={GAP_CONTENT} selection={null} />,
    );
    return host;
}

describe('context gap bars', () => {
    it.each(['unified', 'split'] as const)('preserve directions and one tab stop in mode %s', (mode) => {
        const host = renderGaps(mode);
        const leading = host.querySelector<HTMLElement>('.diff-gap[data-edge="leading"]');
        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const trailing = host.querySelector<HTMLElement>('.diff-gap[data-edge="trailing"]');

        expect(leading?.querySelectorAll('[data-direction="up"]')).toHaveLength(1);
        expect(leading?.querySelectorAll('[data-direction="down"]')).toHaveLength(0);
        expect(inner?.querySelectorAll('[data-direction="up"], [data-direction="down"]')).toHaveLength(2);
        expect(trailing?.querySelectorAll('[data-direction="up"]')).toHaveLength(0);
        expect(trailing?.querySelectorAll('[data-direction="down"]')).toHaveLength(1);

        for (const gap of [leading, inner, trailing]) {
            expect(gap?.getAttribute('tabindex')).toBe('0');
            expect(gap?.querySelectorAll('button[tabindex="-1"]')).toHaveLength(
                gap?.querySelectorAll('button').length ?? 0,
            );
        }
    });

    it('remainder smaller than the step produces one updown target with an exact aria-label', () => {
        const host = renderGaps('unified', REMAINDER_MODEL);
        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const target = inner?.querySelector<HTMLButtonElement>('[data-direction="all"]');

        expect(target).not.toBeNull();
        expect(target?.getAttribute('aria-label')).toBe('load 19 lines, 19 lines hidden');
        expect(target?.querySelector('svg[data-icon="updown"]')).not.toBeNull();
        expect(inner?.textContent).toContain('19 unchanged lines — expand');
    });

    it('arrow keys change the selected direction visually and through aria-activedescendant', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(<DiffRows model={GAP_MODEL} mode="unified" content={GAP_CONTENT} selection={null} />);
        });

        const inner = host.querySelector<HTMLElement>('.diff-gap[data-edge="inner"]');
        const up = inner?.querySelector<HTMLElement>('[data-direction="up"]');
        const down = inner?.querySelector<HTMLElement>('[data-direction="down"]');
        if (inner === null || up === null || up === undefined || down === null || down === undefined) {
            throw new Error('inner gap bar did not render both directions');
        }

        expect(inner.getAttribute('role')).toBe('radiogroup');
        expect(inner.getAttribute('aria-activedescendant')).toBe(up.id);
        expect(up.classList.contains('is-active')).toBe(true);
        expect(up.getAttribute('aria-checked')).toBe('true');
        expect(down.getAttribute('aria-checked')).toBe('false');

        act(() => {
            inner.focus();
            inner.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
        });

        expect(inner.getAttribute('aria-activedescendant')).toBe(down.id);
        expect(down.classList.contains('is-active')).toBe(true);
        expect(down.getAttribute('aria-checked')).toBe('true');
        expect(up.getAttribute('aria-checked')).toBe('false');

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

describe('long line wrapping', () => {
    it('preserves tabs and markup in a long line', () => {
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <DiffRows
                    model={LONG_MODEL}
                    mode="unified"
                    content={null}
                    selection={{ fileId: LONG_MODEL.fileId, anchor: 'a1', focus: 'a1' }}
                    onCommentLine={() => undefined}
                />,
            );
        });

        const code = host.querySelector<HTMLElement>('.diff-row--add .diff-row__code');
        if (code === null) {
            throw new Error('long line did not render');
        }

        // jsdom does not apply CSS. E2E checks the computed white-space/overflow-wrap.
        expect(code.classList.contains('diff-row__code')).toBe(true);
        expect(code.textContent).toContain('    const endpoint');
        expect(code.querySelector('.diff-word')).not.toBeNull();
        expect(code.querySelector('.diff-trailing')?.textContent).toBe('   ');
        expect(code.querySelector('.diff-row__no-newline')).not.toBeNull();
        expect(code.closest('.diff-row')?.classList.contains('is-selected')).toBe(true);

        act(() => {
            root.unmount();
        });
        host.remove();
    });
});

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

describe('route slice gap bar', () => {
    /** Only changes from other stops lie between new lines 2 and 5. There is no context to expand. */
    function clippedGap(): HTMLElement {
        const model = parseFileDiff({
            fileId: 'f-clip',
            path: 'src/clip.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            patch: ['@@ -1,2 +1,6 @@', ' alpha', '+one', '+', '+two', '+three', ' omega', ''].join('\n'),
        });
        const clipped = clipModelToAnchors(model, [
            { side: 'new', start: 2, end: 2 },
            { side: 'new', start: 5, end: 5 },
        ]);
        const host = document.createElement('div');
        host.innerHTML = renderToStaticMarkup(
            <DiffRows model={clipped.model} mode="unified" content={null} selection={null} />,
        );
        return host;
    }

    it('gap containing only changed lines from other stops offers no expansion and takes no tab stop', () => {
        const gap = clippedGap().querySelector<HTMLElement>('.diff-gap');

        expect(gap?.getAttribute('data-hidden')).toBe('0');
        expect(gap?.textContent).toBe('2 changed lines — in other stops');
        expect(gap?.querySelectorAll('[data-direction]')).toHaveLength(0);
        expect(gap?.getAttribute('tabindex')).toBeNull();
    });
});
