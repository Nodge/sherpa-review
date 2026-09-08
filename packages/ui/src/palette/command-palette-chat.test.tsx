// @vitest-environment jsdom
import type { AgentNote, ChatAnchor, ChatExchange } from '@sherpa/protocol';
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { PrStateProvider } from '../pr-state/context.tsx';
import { createUiPrStateStore } from '../pr-state/pr-state-store.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { createShortcutRegistry } from '../shortcuts/registry.js';
import type { PaletteChat } from './command-palette.tsx';
import { CommandPalette } from './command-palette.tsx';

/** `@` mode: this PR's chat history in the palette (docs/design/SPEC-elements.md §2.18). */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

HTMLElement.prototype.scrollIntoView = function noopScrollIntoView(): void {
    return undefined;
};

const NOW = Date.parse('2026-08-20T10:00:00.000Z');
const LIVE_FILE = 'file-live';
const GONE_FILE = 'file-gone';

function anchor(fileId: string, path: string): ChatAnchor {
    return { diffId: 'diff-1', fileId, path, side: 'new', start: 48, end: 54 };
}

function exchange(spec: Partial<ChatExchange> & { id: number; question: string }): ChatExchange {
    return {
        anchor: null,
        status: 'done',
        taskId: null,
        answer: null,
        progressText: null,
        error: null,
        locale: null,
        createdAt: `2026-08-20T09:${String(spec.id).padStart(2, '0')}:00.000Z`,
        updatedAt: `2026-08-20T09:${String(spec.id).padStart(2, '0')}:00.000Z`,
        ...spec,
    };
}

const EXCHANGES: readonly ChatExchange[] = [
    exchange({ id: 11, question: 'Why does a closed window return 409?', anchor: anchor(LIVE_FILE, 'api/handlers.ts'), answer: 'The status is chosen by the reason for refusal.' }),
    exchange({ id: 12, question: 'Break down the PR by mechanism', answer: 'The 30-minute rule moved into the domain.' }),
    exchange({ id: 13, question: 'What about the courier?', anchor: anchor(GONE_FILE, 'domain/edit-policy.ts'), answer: 'Dispatch closes the window.' }),
    exchange({ id: 14, question: 'Is there a risk of a leak?', status: 'running' }),
    exchange({ id: 15, question: 'Compare the contract with the previous one', status: 'cancelled' }),
    exchange({ id: 16, question: 'Check the statuses', status: 'failed', error: 'The agent did not answer.' }),
    exchange({ id: 17, question: 'How is a mixed cart calculated?', answer: 'Using the shortest time limit.' }),
    exchange({ id: 18, question: 'Why does the policy need explain?', answer: 'For tests.' }),
    exchange({ id: 19, question: 'What about the audit?', answer: 'Written in the same handler.' }),
];

const NOTES: readonly AgentNote[] = [
    {
        id: 1,
        exchangeId: 13,
        anchor: anchor(GONE_FILE, 'domain/edit-policy.ts'),
        text: 'Dispatch closes the window.',
        lostAnchor: true,
        origin: { commit: 'c0ffee', anchor: anchor(GONE_FILE, 'domain/edit-policy.ts') },
        createdAt: '2026-08-20T09:13:00.000Z',
    },
];

const selected: { exchange: ChatExchange; anchorAlive: boolean }[] = [];
const mounted: (() => void)[] = [];

afterEach(() => {
    selected.length = 0;
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

type ChatOverrides = Partial<Pick<PaletteChat, 'exchanges' | 'loading' | 'error'>>;

function Harness({ query, chat = true, overrides }: { query: string; chat?: boolean; overrides?: ChatOverrides | undefined }) {
    const [registry] = useState(() => createShortcutRegistry());
    const [prState] = useState(() => createUiPrStateStore());
    const [open, setOpen] = useState(true);
    const [paletteChat] = useState<PaletteChat>(() => ({
        exchanges: EXCHANGES,
        notes: NOTES,
        liveFileIds: new Set([LIVE_FILE]),
        now: NOW,
        onSelect: (exchange, anchorAlive) => {
            selected.push({ exchange, anchorAlive });
        },
        ...overrides,
    }));

    return (
        <ShortcutsProvider registry={registry}>
            <PrStateProvider store={prState}>
                <CommandPalette
                    open={open}
                    source={null}
                    chat={chat ? paletteChat : undefined}
                    initialQuery={query}
                    onOpen={() => {
                        setOpen(true);
                    }}
                    onClose={() => {
                        setOpen(false);
                    }}
                />
            </PrStateProvider>
        </ShortcutsProvider>
    );
}

function mount(query: string, options: { chat?: boolean; overrides?: ChatOverrides } = {}): HTMLElement {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<Harness query={query} chat={options.chat ?? true} overrides={options.overrides} />);
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        host.remove();
    });
    return host;
}

function rows(host: HTMLElement): HTMLButtonElement[] {
    return [...host.querySelectorAll<HTMLButtonElement>('.command-palette__item')];
}

function rowText(host: HTMLElement, index: number): string {
    const row = rows(host)[index];
    if (row === undefined) {
        throw new Error(`no row ${String(index)} in the palette results`);
    }
    return row.textContent;
}

function notice(host: HTMLElement): string | undefined {
    return host.querySelector('.command-palette__notice')?.textContent;
}

function announcement(host: HTMLElement): string | undefined {
    return host.querySelector('[role="status"]')?.textContent;
}

function pressEnter(host: HTMLElement): void {
    const overlay = host.querySelector('.command-palette__overlay');
    if (overlay === null) {
        throw new Error('palette is not open');
    }
    act(() => {
        overlay.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
}

describe('chat history in the palette', () => {
    it('an empty @ shows the last 8 exchanges, newest first', () => {
        const host = mount('@');

        expect(rows(host)).toHaveLength(8);
        expect(rowText(host, 0)).toContain('What about the audit?');
        expect(host.querySelector('.command-palette__group-label')?.textContent).toBe('Chat history');
        // Exchange eleven is ninth by recency, so it is absent from the results.
        expect(host.textContent).not.toContain('Why does a closed window return 409?');
    });

    it('searches both the question and answer for text after @', () => {
        const host = mount('@ window');

        expect(rows(host).map((row) => row.textContent)).toEqual([
            expect.stringContaining('What about the courier?'),
            expect.stringContaining('Why does a closed window return 409?'),
        ]);
    });

    it('includes the time, location and anchor annotations in the row', () => {
        const host = mount('@ window');

        expect(rowText(host, 0)).toContain('edit-policy.ts:48–54');
        expect(rowText(host, 0)).toContain('anchor is not in this iteration');
        expect(rowText(host, 0)).toContain('the note lost its anchor');
        expect(rowText(host, 1)).toContain('handlers.ts:48–54');
        expect(rowText(host, 1)).not.toContain('anchor is not in this iteration');
        expect(rowText(host, 1)).toContain('ago');
    });

    it('marks unanchored questions and unfinished exchanges', () => {
        const host = mount('@');

        expect(rowText(host, 5)).toContain('Is there a risk of a leak?');
        expect(rowText(host, 5)).toContain('question about the whole PR');
        expect(rowText(host, 5)).toContain('still answering');
        expect(rowText(host, 4)).toContain('cancelled');
        expect(rowText(host, 3)).toContain('no answer');
    });

    it('returns the exchange with a live anchor on ⏎', () => {
        const host = mount('@ 409');

        pressEnter(host);

        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(11);
        expect(selected[0]?.anchorAlive).toBe(true);
        expect(host.querySelector('.command-palette')).toBeNull();
    });

    it('returns anchorAlive false on ⏎ for a dead anchor or an unanchored question', () => {
        const gone = mount('@ courier');
        pressEnter(gone);
        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(13);
        expect(selected[0]?.anchorAlive).toBe(false);

        selected.length = 0;
        const wholePr = mount('@ mechanism');
        pressEnter(wholePr);
        expect(selected).toHaveLength(1);
        expect(selected[0]?.exchange.id).toBe(12);
        expect(selected[0]?.anchorAlive).toBe(false);
    });

    it('does not offer diff search in @ mode without history', () => {
        const host = mount('@', { chat: false });

        expect(rows(host)).toEqual([]);
        expect(host.querySelector('.command-palette__notice')?.textContent).toContain('The chat history is empty');
        expect(host.textContent).not.toContain('Search the diff contents');
    });

    it('mentions the query when search has no matches', () => {
        const host = mount('@ cache');

        expect(rows(host)).toEqual([]);
        expect(host.querySelector('.command-palette__notice')?.textContent).toBe('Nothing matches “cache”');
    });

    it('does not present unloaded history as empty', () => {
        const loading = mount('@', { overrides: { exchanges: [], loading: true } });
        expect(notice(loading)).toBe('The chat history is still loading');

        const failed = mount('@ window', { overrides: { exchanges: [], error: 'the server is silent' } });
        expect(notice(failed)).toBe('Could not load the chat history: the server is silent');
    });

    it('announces empty history as state guidance rather than a search result', () => {
        const host = mount('@', { overrides: { exchanges: [] } });

        expect(notice(host)).toBe('The chat history is empty — ask the agent about a selection or the PR');
        expect(announcement(host)).toBe('The chat history is empty — ask the agent about a selection or the PR');
        // A nonempty query is a search, so the screen reader gets the short "nothing found" announcement.
        expect(announcement(mount('@ cache'))).toBe('Nothing matches');
    });
});
