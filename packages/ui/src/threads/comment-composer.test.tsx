// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { COMPOSER_LAYOUT_KEY } from './composer-markdown.js';
import { NewCommentComposer, openPrComposer } from './thread-list.tsx';
import { createThreadStore } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

function mount(layout?: 'visual' | 'markdown') {
    if (layout === undefined) {
        localStorage.removeItem(COMPOSER_LAYOUT_KEY);
    } else {
        localStorage.setItem(COMPOSER_LAYOUT_KEY, layout);
    }
    const store = createThreadStore([], new Set());
    openPrComposer(store);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <NewCommentComposer
                composerKey="new:pr"
                store={store}
                transport={{
                    save: () => Promise.reject(new Error('test does not save')),
                    update: () => Promise.resolve(),
                    delete: () => Promise.resolve(),
                }}
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store };
}

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    localStorage.removeItem(COMPOSER_LAYOUT_KEY);
});

describe('comment composer', () => {
    it('the Markdown toolbar wraps the selection and takes ⌘K from the global shortcut', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'words' });
        });
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('no Markdown textarea');
        }
        textarea.setSelectionRange(0, 5);
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', code: 'KeyK', metaKey: true, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(store.getComposer('new:pr')?.text).toBe('[words](https://)');
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    it.each([
        ['⌘B', '\u0438', 'KeyB', '**words**'],
        ['⌘I', '\u0448', 'KeyI', '*words*'],
        ['⌘K', '\u043b', 'KeyK', '[words](https://)'],
    ])('recognises %s by physical key on a Cyrillic keyboard layout', (_title, key, code, expected) => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'words' });
        });
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('no Markdown textarea');
        }
        textarea.setSelectionRange(0, 5);

        act(() => {
            textarea.dispatchEvent(new KeyboardEvent('keydown', { key, code, metaKey: true, bubbles: true }));
        });

        expect(store.getComposer('new:pr')?.text).toBe(expected);
    });

    it('remembers the layout per user and does not add a placeholder to markdown', async () => {
        const { host, store } = mount('markdown');
        const visualButton = [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__layout button')].find(
            (button) => button.textContent === 'Visual',
        );
        act(() => {
            visualButton?.click();
        });

        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        expect(localStorage.getItem(COMPOSER_LAYOUT_KEY)).toBe('visual');
        expect(host.querySelector('.thread-composer__placeholder')?.textContent).toContain('A general remark on the PR');
        expect(host.querySelector('.ProseMirror')?.textContent).toBe('');
        expect(store.getComposer('new:pr')?.text).toBe('');
    });

    it('does not invent a save time without savedAt', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'draft', commentId: 'draft-1', status: 'saved' });
        });

        expect(host.querySelector('.thread-composer__status')?.textContent.trim()).toBe('saved as a draft');
    });

    it('visual layout formats on ⌘K without opening the global palette', async () => {
        const { host, store } = mount('visual');
        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        const editor = host.querySelector<HTMLElement>('.ProseMirror');
        if (editor === null) {
            throw new Error('no ProseMirror');
        }
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        await vi.waitFor(() => {
            expect(store.getComposer('new:pr')?.text).toBe('[text](https://)');
        });
        expect(globalKeydown).not.toHaveBeenCalled();
    });
});
