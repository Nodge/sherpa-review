// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { UiSettingsPatch } from '@sherpa/protocol';

import { SettingsProvider } from '../settings/context.tsx';
import { createUiSettingsStore } from '../settings/settings-store.js';
import type { ComposerTransport } from './composer.js';
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
        update: options.update ?? (() => Promise.resolve({ outcome: 'saved' as const })),
        delete: options.delete ?? (() => Promise.resolve()),
    };
    // Layout comes from global settings, not localStorage, so mock that boundary.
    const patches: UiSettingsPatch[] = [];
    const settings = createUiSettingsStore({
        ...(layout === undefined ? {} : { initial: { composerLayout: layout } }),
        send: (patch) => {
            patches.push(patch);
            return Promise.resolve(settings.getSnapshot());
        },
    });
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
            <SettingsProvider store={settings}>
                <NewCommentComposer composerKey={key} store={store} transport={transport} />
            </SettingsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return { host, store, settings, patches };
}

function mountReply() {
    const thread = {
        id: 'thread-1',
        anchor: null,
        resolved: false,
        resolvedBy: null,
        outdated: false,
        pinnedTo: null,
        root: {
            id: 'root-1',
            author: { login: 'reviewer', displayName: null, bot: false },
            body: 'root',
            draft: false,
            issue: null,
            resolved: null,
            createdAt: '2026-08-24T10:00:00.000Z',
            editedAt: null,
            replies: [],
        },
    };
    const store = createThreadStore([thread], new Set());
    openReply(store, thread, true);
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
                        update: () => Promise.resolve({ outcome: 'saved' as const }),
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
});

describe('comment composer', () => {
    it('shows an enabled issue switch in the PR-level composer', () => {
        const { host, store } = mount('markdown');
        const issue = host.querySelector<HTMLButtonElement>('.thread-composer__issue');

        expect(issue?.textContent).toContain('Open an issue');
        expect(issue?.getAttribute('role')).toBe('switch');
        expect(issue?.getAttribute('aria-checked')).toBe('true');
        expect(issue?.getAttribute('aria-label')).toBe('Open an issue, on');

        act(() => {
            issue?.click();
        });
        expect(store.getComposer('new:pr')?.issue).toBe(false);
        expect(issue?.getAttribute('aria-checked')).toBe('false');
        expect(issue?.getAttribute('aria-label')).toBe('Open an issue, off');
    });

    it('places the switch in the first composer row, directly above the editor border', () => {
        const { host } = mount('markdown');
        const composer = host.querySelector('.thread-composer');
        const order = [...(composer?.children ?? [])].map((node) => node.className);

        expect(order.slice(0, 2)).toEqual(['thread-composer__issue-row', 'thread-composer__editor']);
        expect(host.querySelector('.thread-composer__context')).toBeNull();
    });

    it('shows the issue switch for a new line comment', () => {
        const { host } = mount('markdown', { kind: 'line' });
        expect(host.querySelector('.thread-composer__issue')).not.toBeNull();
    });

    it('omits the issue row from the DOM when the host lacks the capability', () => {
        const { host } = mount('markdown', { commentIssues: false });
        expect(host.querySelector('.thread-composer__issue')).toBeNull();
        expect(host.querySelector('.thread-composer__issue-row')).toBeNull();
    });

    it('shows the issue switch for a reply', () => {
        const issue = mountReply().querySelector('.thread-composer__issue');
        expect(issue?.getAttribute('aria-checked')).toBe('true');
    });

    it('keeps autosave status below the field, outside the button row', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'text', status: 'error' });
        });
        const status = host.querySelector('.thread-composer__status-line .thread-composer__status');

        expect(status?.className).toContain('is-error');
        expect(host.querySelector('.thread-composer__actions .thread-composer__status')).toBeNull();
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

    it('saves the layout in global settings without adding the placeholder to markdown', async () => {
        const { host, store, settings, patches } = mount('markdown');
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
        expect(settings.getSnapshot().composerLayout).toBe('visual');
        expect(patches).toEqual([{ composerLayout: 'visual' }]);
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

    it('has no context heading above the switch in a new comment composer', () => {
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
                        update: () => Promise.resolve({ outcome: 'saved' as const }),
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

        expect(host.querySelector('.thread-composer__context')).toBeNull();
        expect(host.querySelector('.thread-composer__issue-row')).not.toBeNull();
        expect(host.textContent).not.toContain('New comment');
    });

    it('shows the actual unsaved status after input, until an explicit save', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', { text: 'unsaved text', status: 'idle' });
        });

        expect(host.querySelector('.thread-composer__status')?.textContent).toBe('not saved — ⌘⏎ or the button');
    });

    // Draft buffer: the text is on the server, but the host has not accepted it yet.
    it('a buffered composer promises to deliver the text and offers a retry', () => {
        const { host, store } = mount('markdown');
        act(() => {
            store.updateComposer('new:pr', {
                text: 'waiting for connection',
                status: 'buffered',
                bufferEntry: {
                    id: 'ck-1',
                    draft: { body: 'waiting for connection', parentId: null, anchor: null },
                    commentId: null,
                    state: 'failed',
                    error: 'review host: 502',
                    attempts: 1,
                    createdAt: '2026-09-03T10:00:00.000Z',
                    updatedAt: '2026-09-03T10:00:00.000Z',
                },
            });
        });

        const status = host.querySelector('.thread-composer__status');
        expect(status?.textContent).toBe('we will save it once the connection is back · retry');
        expect(status?.getAttribute('title')).toBe('review host: 502');
        // The text stays editable. The buffer holds it without locking it.
        expect(host.querySelector<HTMLTextAreaElement>('.thread-composer__markdown')?.disabled).toBe(false);
    });

    it('closes the field after the first save, leaving the draft card', async () => {
        const save = vi.fn(() =>
            Promise.resolve({
                outcome: 'saved' as const,
                comment: {
                    id: 'draft-1',
                    author: { login: 'alice', displayName: 'Alice Ingram', bot: false },
                    body: 'finished draft',
                    draft: true,
                    issue: null,
                    resolved: null,
                    createdAt: '2026-08-24T10:00:00.000Z',
                    editedAt: null,
                    replies: [],
                },
            }),
        );
        const { host, store } = mount('markdown', {
            save,
            update: () => Promise.resolve({ outcome: 'saved' as const }),
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

    it('Cancel asks to confirm deletion when new text is nonempty', () => {
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

        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Delete the draft?');
        // Confirmation replaces the buttons. There is no second "Cancel" or "Save draft" on screen.
        expect(host.querySelector('.thread-composer__actions')).toBeNull();
        expect(host.querySelector('.thread-composer__status')).toBeNull();
        expect(store.getComposer('new:pr')).not.toBeNull();
    });

    it('Cancel asks for confirmation before cancelling edits to a saved draft', async () => {
        const update = vi.fn(() => Promise.resolve({ outcome: 'saved' as const }));
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

        expect(host.querySelector('.thread__delete-confirm')?.textContent).toContain('Delete the draft?');
        expect(update).not.toHaveBeenCalled();
        expect(store.getComposer('new:pr')?.text).toBe('');

        await act(async () => {
            host.querySelector<HTMLButtonElement>('.thread__delete-confirm-button')?.click();
            await vi.waitFor(() => {
                expect(store.getComposer('new:pr')).toBeNull();
            });
        });

        expect(update).toHaveBeenCalledWith('draft-1', 'original text', undefined, expect.any(String));
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

    /**
     * Recreating ProseMirror put the cursor at the start of the document, making typing run backwards.
     * The editor node must survive composer text changes.
     */
    it('visual layout does not recreate the editor on every letter', async () => {
        const { host, store } = mount('visual');
        await act(async () => {
            await vi.waitFor(() => {
                expect(host.querySelector('.ProseMirror')).not.toBeNull();
            });
        });
        const editor = host.querySelector('.ProseMirror');

        for (const text of ['a', 'ab', 'abc']) {
            act(() => {
                store.updateComposer('new:pr', { text });
            });
        }

        expect(host.querySelector('.ProseMirror')).toBe(editor);
    });
});
