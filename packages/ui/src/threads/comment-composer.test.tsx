// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ComposerTransport } from './composer.js';
import { COMPOSER_LAYOUT_KEY } from './composer-markdown.js';
import { NewCommentComposer, openNewComposer, openPrComposer, openReply, ThreadList } from './thread-list.tsx';
import { createThreadStore } from './store.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

function mount(
    layout?: 'visual' | 'markdown',
    options: {
        commentIssues?: boolean;
        kind?: 'pr' | 'line';
        save?: ComposerTransport['save'];
        update?: ComposerTransport['update'];
        delete?: ComposerTransport['delete'];
    } = {},
) {
    const transport: ComposerTransport = {
        save: options.save ?? (() => Promise.reject(new Error('this test does not save'))),
        update: options.update ?? (() => Promise.resolve()),
        delete: options.delete ?? (() => Promise.resolve()),
    };
    if (layout === undefined) {
        localStorage.removeItem(COMPOSER_LAYOUT_KEY);
    } else {
        localStorage.setItem(COMPOSER_LAYOUT_KEY, layout);
    }
    const store = createThreadStore([], new Set(['f1']));
    const key = options.kind === 'line' ? 'new:f1:new:10' : 'new:pr';
    if (options.kind === 'line') {
        openNewComposer(
            store,
            key,
            { fileId: 'f1', path: 'app.ts', position: { side: 'new', line: 10, size: 1 } },
            options.commentIssues ?? true,
        );
    } else {
        openPrComposer(store, options.commentIssues ?? true);
    }
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <NewCommentComposer
                composerKey={key}
                store={store}
                transport={transport}
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

function mountReply() {
    const thread = {
        id: 'thread-1',
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        root: {
            id: 'root-1',
            author: { login: 'reviewer', displayName: null, bot: false },
            body: 'root',
            draft: false,
            createdAt: '2026-08-24T10:00:00.000Z',
            editedAt: null,
            replies: [],
        },
    };
    const store = createThreadStore([thread], new Set());
    openReply(store, thread);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(
            <ThreadList
                threads={[thread]}
                store={store}
                actions={{
                    transport: {
                        save: () => Promise.reject(new Error('this test does not save')),
                        update: () => Promise.resolve(),
                        delete: () => Promise.resolve(),
                    },
                    resolve: () => Promise.resolve(true),
                }}
                now={Date.parse('2026-08-24T10:01:00.000Z')}
                initialLayout="markdown"
            />,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    localStorage.removeItem(COMPOSER_LAYOUT_KEY);
});

describe('comment composer', () => {
    it('shows the enabled issue control in a PR-level composer', () => {
        const { host, store } = mount('markdown');
        const issue = host.querySelector<HTMLButtonElement>('.thread-composer__issue');

        expect(issue?.textContent).toContain('Open an issue');
        expect(issue?.getAttribute('aria-pressed')).toBe('true');

        act(() => {
            issue?.click();
        });
        expect(store.getComposer('new:pr')?.issue).toBe(false);
        expect(issue?.getAttribute('aria-pressed')).toBe('false');
    });

    it('shows the issue control for a new line comment', () => {
        const { host } = mount('markdown', { kind: 'line' });
        expect(host.querySelector('.thread-composer__issue')).not.toBeNull();
    });

    it('hides the issue control for a host without the capability', () => {
        const { host } = mount('markdown', { commentIssues: false });
        expect(host.querySelector('.thread-composer__issue')).toBeNull();
    });

    it('hides the issue control for replies', () => {
        expect(mountReply().querySelector('.thread-composer__issue')).toBeNull();
    });

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

    it('shows the line range in a new comment context', () => {
        const store = createThreadStore([], new Set(['f1']));
        openNewComposer(
            store,
            'new:f1:new:10',
            {
                fileId: 'f1',
                path: 'src/app.ts',
                position: { side: 'new', line: 10, size: 3 },
            },
            true,
        );
        const host = document.createElement('div');
        document.body.append(host);
        const root = createRoot(host);
        act(() => {
            root.render(
                <NewCommentComposer
                    composerKey="new:f1:new:10"
                    store={store}
                    transport={{
                        save: () => Promise.reject(new Error('this test does not save')),
                        update: () => Promise.resolve(),
                        delete: () => Promise.resolve(),
                    }}
                    initialLayout="markdown"
                />,
            );
        });
        mounted.push(() => {
            act(() => {
                root.unmount();
            });
            host.remove();
        });

        expect(host.querySelector('.thread-composer__context')?.textContent).toContain('new comment · lines 10–12');
    });

    it('shows the actual unsaved status after input, until an explicit save', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'unsaved text', status: 'idle' });
        });

        expect(host.querySelector('.thread-composer__status')?.textContent).toBe('not saved — ⌘⏎ or the button');
    });

    it('closes the field after the first save, leaving the draft card', async () => {
        const save = vi.fn(() =>
            Promise.resolve({
                id: 'draft-1',
                author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
                body: 'ready draft',
                draft: true,
                createdAt: '2026-08-24T10:00:00.000Z',
                editedAt: null,
                replies: [],
            }),
        );
        const { host, store } = mount('markdown', {
            save,
            update: () => Promise.resolve(),
            delete: () => Promise.resolve(),
        });
        act(() => {
            store.updateComposer('new:pr', { text: 'finished draft' });
        });

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread-composer__save')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer('new:pr')).toBeNull();
            });
        });

        expect(save).toHaveBeenCalledOnce();
        expect(store.getSnapshot().threads[0]?.root).toMatchObject({ id: 'draft-1', body: 'finished draft' });
        expect(host.querySelector('.thread-composer')).toBeNull();
    });

    it('Cancel asks for confirmation when the new text is nonempty', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'keep this', status: 'idle' });
        });
        const cancel = [...host.querySelectorAll<HTMLButtonElement>('button')].find(
            (button) => button.textContent === 'Cancel',
        );

        act(() => {
            cancel?.click();
        });

        expect(host.querySelector('.thread-composer__confirm')?.textContent).toContain('Discard this draft?');
        expect(store.getComposer('new:pr')).not.toBeNull();
    });

    it('Cancel asks for confirmation before cancelling edits to a saved draft', async () => {
        const update = vi.fn(() => Promise.resolve());
        const { host, store } = mount('markdown', {
            save: () => Promise.reject(new Error('there is no first save here')),
            update,
            delete: () => Promise.resolve(),
        });
        act(() => {
            store.updateComposer('new:pr', {
                text: 'original text',
                originalText: 'original text',
                commentId: 'draft-1',
                status: 'saved',
            });
            store.updateComposer('new:pr', { text: '', status: 'idle' });
        });

        act(() => {
            [...host.querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent === 'Cancel')?.click();
        });

        expect(host.querySelector('.thread-composer__confirm')?.textContent).toContain('Discard this draft?');
        expect(update).not.toHaveBeenCalled();
        expect(store.getComposer('new:pr')?.text).toBe('');

        await act(async () => {
            [...host.querySelectorAll<HTMLButtonElement>('.thread-composer__confirm button')]
                .find((button) => button.textContent === 'discard')
                ?.click();
            await vi.waitFor(() => {
                expect(store.getComposer('new:pr')).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith('draft-1', 'original text');
    });

    it.each(['c', 'v'])('Markdown takes the plain %s key from global shortcuts', (key) => {
        const { host } = mount('markdown');
        const textarea = host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown');
        if (textarea === null) {
            throw new Error('no Markdown textarea');
        }
        const globalKeydown = vi.fn();
        document.addEventListener('keydown', globalKeydown);

        act(() => {
            textarea.dispatchEvent(
                new KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true }),
            );
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(globalKeydown).not.toHaveBeenCalled();
    });

    it.each(['c', 'v'])('visual layout takes the plain %s key from global shortcuts', async (key) => {
        const { host } = mount('visual');
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
            editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        });

        document.removeEventListener('keydown', globalKeydown);
        expect(globalKeydown).not.toHaveBeenCalled();
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
