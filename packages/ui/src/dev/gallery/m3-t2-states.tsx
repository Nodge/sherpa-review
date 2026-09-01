import { chatFixtures, fixtureData } from '@sherpa/fixtures';
import type { AgentNote, ChatAnchor, ChatExchange } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { reconnectCommand } from '../../components/reconnect-command.js';

const DATA = fixtureData('medium');
const CHAT = (() => {
    const fixtures = chatFixtures('medium');
    if (fixtures === null) {
        throw new Error('the medium fixture needs chat history');
    }
    return fixtures;
})();

function exchange(id: number): ChatExchange {
    const found = CHAT.exchanges.find((item) => item.id === id);
    if (found === undefined) {
        throw new Error(`chat fixture has no exchange ${String(id)}`);
    }
    return found;
}

function note(id: number): AgentNote {
    const found = CHAT.notes.find((item) => item.id === id);
    if (found === undefined) {
        throw new Error(`note ${String(id)} is missing from the chat fixture`);
    }
    return found;
}

function fileName(path: string): string {
    return path.split('/').at(-1) ?? path;
}

function anchorLabel(anchor: ChatAnchor): string {
    return `${fileName(anchor.path)}:${String(anchor.start)}–${String(anchor.end)}`;
}

function anchorLines(anchor: ChatAnchor): number {
    return anchor.end - anchor.start + 1;
}

function firstWords(text: string): string {
    const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? text;
    return firstLine.replace(/[`*_#]/g, '').slice(0, 64);
}

function DemoCard({ title, children }: { title: string; children: ReactNode }) {
    return (
        <section className="gallery-chat-demo">
            <header className="gallery-chat-demo__header">
                <strong>{title}</strong>
                <span>{DATA.pr.title}</span>
            </header>
            <div className="gallery-chat-demo__body">{children}</div>
        </section>
    );
}

function ContextChip({ anchor }: { anchor: ChatAnchor }) {
    return <span className="gallery-chat-demo__chip">↳ {anchorLabel(anchor)}</span>;
}

function MarkdownDraft({ children }: { children: string }) {
    return <pre className="gallery-chat-demo__markdown">{children}</pre>;
}

function ChatEmptyState() {
    const examples = [
        'What does this PR change in the domain model?',
        'Where is behaviour not covered by tests?',
        'What risks remain outside the diff?',
    ];

    return (
        <DemoCard title="Chat with the agent">
            <p>Ask about the whole PR or select lines and ask about them.</p>
            <div className="gallery-chat-demo__examples">
                {examples.map((example) => (
                    <button key={example} type="button">
                        {example}
                    </button>
                ))}
            </div>
            <textarea aria-label="Question to the agent" placeholder="Ask a question" rows={3} />
        </DemoCard>
    );
}

function ChatQueuedState() {
    const item = exchange(3);
    return (
        <DemoCard title="Chat with the agent">
            <div className="gallery-chat-demo__banner">Generating the route · your question is next</div>
            <div className="gallery-chat-demo__message">
                <strong>You</strong>
                <p>{item.question}</p>
            </div>
        </DemoCard>
    );
}

function ChatAnsweringState() {
    const item = exchange(4);
    return (
        <DemoCard title="Chat with the agent">
            <div className="gallery-chat-demo__message">
                <strong>You</strong>
                {item.anchor === null ? null : <ContextChip anchor={item.anchor} />}
                <p>{item.question}</p>
            </div>
            <div className="gallery-chat-demo__working">
                <span aria-hidden>•••</span>
                <span>{item.progressText}</span>
            </div>
        </DemoCard>
    );
}

function ChatFailedState() {
    const item = exchange(5);
    return (
        <DemoCard title="Chat with the agent">
            <div className="gallery-chat-demo__message">
                <strong>You</strong>
                <p>{item.question}</p>
            </div>
            <div className="gallery-chat-demo__error">
                <strong>No answer came back</strong>
                <p>{item.error}</p>
                <button type="button">Retry</button>
            </div>
        </DemoCard>
    );
}

function ChatDisconnectedState() {
    return (
        <DemoCard title="Chat with the agent">
            <div className="gallery-chat-demo__notice">
                Agent disconnected. Reconnect the session with <code>{reconnectCommand('fixture-medium')}</code>.
            </div>
            <textarea aria-label="Question to the agent" disabled placeholder="Composer unavailable until reconnection" rows={3} />
        </DemoCard>
    );
}

function CollapsedNoteState() {
    const item = note(1);
    return (
        <DemoCard title="Note beside code">
            <div className="gallery-chat-demo__note-collapsed">
                ◆ Agent note · {firstWords(item.text)} · {String(anchorLines(item.anchor))} lines
            </div>
        </DemoCard>
    );
}

function ExpandedNoteState() {
    const item = note(1);
    return (
        <DemoCard title={`Note at ${anchorLabel(item.anchor)}`}>
            <article className="gallery-chat-demo__note">
                <strong>Asked at lines {item.anchor.start}–{item.anchor.end}</strong>
                <span className="gallery-chat-demo__meta">Model answer · not published</span>
                <MarkdownDraft>{item.text}</MarkdownDraft>
                <div className="gallery-chat-demo__actions">
                    <button type="button">Open in the chat</button>
                    <button type="button">Turn into a comment draft</button>
                    <button type="button">Collapse</button>
                    <button type="button">Delete</button>
                </div>
            </article>
        </DemoCard>
    );
}

function StackedNotesState() {
    const items = [note(4), note(3), note(2)];
    return (
        <DemoCard title={`Stack at ${fileName(items[0]?.anchor.path ?? '')}`}>
            <div className="gallery-chat-demo__stack-title">{items.length} notes here</div>
            <div className="gallery-chat-demo__stack">
                {items.map((item) => (
                    <article key={item.id} className="gallery-chat-demo__stack-item">
                        <strong>{anchorLabel(item.anchor)}</strong>
                        <span>{firstWords(item.text)}</span>
                    </article>
                ))}
            </div>
        </DemoCard>
    );
}

function SelectionPopoverState() {
    const anchor = exchange(1).anchor;
    if (anchor === null) {
        throw new Error('exchange 1 must be anchored to a selection');
    }
    return (
        <DemoCard title={`Selection in ${fileName(anchor.path)}`}>
            <div className="gallery-chat-demo__popover">
                <strong>{anchorLines(anchor)} lines selected</strong>
                <div className="gallery-chat-demo__actions">
                    <button type="button" className="gallery-chat-demo__primary">
                        Ask the agent
                    </button>
                    <button type="button">Comment</button>
                    <button type="button">Copy link</button>
                </div>
            </div>
        </DemoCard>
    );
}

function SelectionInFlightState() {
    const anchor = exchange(4).anchor;
    if (anchor === null) {
        throw new Error('exchange 4 must be anchored to a selection');
    }
    return (
        <DemoCard title={`Selection in ${fileName(anchor.path)}`}>
            <div className="gallery-chat-demo__in-flight">Asked · the answer will land here</div>
        </DemoCard>
    );
}

export interface M3T2GalleryState {
    readonly id: string;
    readonly title: string;
    readonly render: () => ReactNode;
}

export const M3_T2_STATES: readonly M3T2GalleryState[] = [
    { id: 'chat-empty', title: 'panel: empty history and example questions', render: () => <ChatEmptyState /> },
    { id: 'chat-queued', title: 'panel: question waits for the route to finish', render: () => <ChatQueuedState /> },
    { id: 'chat-answering', title: 'panel: agent answers and reports progress', render: () => <ChatAnsweringState /> },
    { id: 'chat-failed', title: 'panel: error saved, retry available', render: () => <ChatFailedState /> },
    { id: 'chat-disconnected', title: 'panel: agent disconnected, composer disabled', render: () => <ChatDisconnectedState /> },
    { id: 'agent-note-collapsed', title: 'note: one line', render: () => <CollapsedNoteState /> },
    { id: 'agent-note-expanded', title: 'note: markdown and actions', render: () => <ExpandedNoteState /> },
    { id: 'agent-note-stack', title: 'notes: 3 overlapping ranges', render: () => <StackedNotesState /> },
    { id: 'selection-popover', title: 'popover: selection actions', render: () => <SelectionPopoverState /> },
    { id: 'selection-popover-in-flight', title: 'popover: question already sent', render: () => <SelectionInFlightState /> },
];
