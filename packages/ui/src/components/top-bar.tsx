import { Fragment, useEffect, useRef, useState } from 'react';

import type { BreadcrumbSegment } from '../pr-key.js';
import type { ViewId } from '../session/views.js';
import type { AgentPillView } from './agent-pill-view.js';
import { CommandBox } from './command-box.tsx';
import './top-bar.css';
import { ViewTabs } from './view-tabs.tsx';

/**
 * Top bar (README §0): mark, breadcrumb, view tabs, agent status, search and avatar.
 * The Feedback button comes in M5 with the feedback channel, so it is absent here.
 */
export interface TopBarProps {
    /** Distribution version from the UI package.json, injected at build time. */
    readonly version: string;
    /** Brandcrumb segments from left to right. The last is the PR itself, and a link once metadata is known. */
    readonly breadcrumb: readonly BreadcrumbSegment[];
    readonly agent: AgentPillView;
    readonly reconnectCommand: string;
    readonly view: ViewId;
    readonly onSelectView: (view: ViewId) => void;
    readonly onOpenSearch: () => void;
}

export function TopBar({
    version,
    breadcrumb,
    agent,
    reconnectCommand: command,
    view,
    onSelectView,
    onOpenSearch,
}: TopBarProps) {
    return (
        <header className="top-bar">
            <div className="top-bar__brand">
                <span className="top-bar__mark" aria-hidden="true" />
                <span className="top-bar__wordmark">Sherpa</span>
                <span className="top-bar__version">{version}</span>
            </div>

            <nav className="top-bar__breadcrumb" aria-label="Pull request">
                {breadcrumb.map((segment, index) => (
                    <Fragment key={`${String(index)}:${segment.text}`}>
                        {index === 0 ? null : (
                            <span className="top-bar__breadcrumb-separator" aria-hidden="true">
                                /
                            </span>
                        )}
                        {segment.href === null ? (
                            <span className="top-bar__breadcrumb-item">{segment.text}</span>
                        ) : (
                            // Normal navigation: open the PR on its host in the reviewer's browser.
                            <a className="top-bar__breadcrumb-item" href={segment.href}>
                                {segment.text}
                            </a>
                        )}
                    </Fragment>
                ))}
            </nav>

            <div className="top-bar__spacer" />
            <ViewTabs view={view} onSelect={onSelectView} />
            <div className="top-bar__spacer" />

            <AgentPill view={agent} reconnectCommand={command} />
            <SearchButton onClick={onOpenSearch} />

            {/* The UI does not know the actual user until M1-T10, so do not invent initials. */}
            <div className="top-bar__avatar" aria-hidden="true" />
        </header>
    );
}

/** The pill opens reconnect or a temporary status popover. The full chat panel arrives in M3. */
export function AgentPill({
    view,
    reconnectCommand: command,
    defaultOpen = false,
}: {
    view: AgentPillView;
    reconnectCommand: string;
    defaultOpen?: boolean;
}) {
    const [open, setOpen] = useState(defaultOpen);
    const [announcement, setAnnouncement] = useState('');
    const wrapperRef = useRef<HTMLDivElement | null>(null);
    const previousTone = useRef(view.tone);

    useEffect(() => {
        const wasDisconnected = previousTone.current === 'disconnected';
        previousTone.current = view.tone;
        const next =
            view.tone === 'disconnected'
                ? wasDisconnected
                    ? null
                    : 'Agent disconnected. The reader remains fully functional.'
                : '';
        if (next === null) {
            return;
        }
        const timer = window.setTimeout(() => {
            setAnnouncement(next);
        }, 0);
        return () => {
            window.clearTimeout(timer);
        };
    }, [view.tone]);

    useEffect(() => {
        if (!open) {
            return;
        }
        const closeOutside = (event: MouseEvent): void => {
            if (event.target instanceof Node && !wrapperRef.current?.contains(event.target)) {
                setOpen(false);
            }
        };
        const closeOnEscape = (event: KeyboardEvent): void => {
            if (event.key === 'Escape') {
                setOpen(false);
            }
        };
        document.addEventListener('mousedown', closeOutside);
        document.addEventListener('keydown', closeOnEscape);
        return () => {
            document.removeEventListener('mousedown', closeOutside);
            document.removeEventListener('keydown', closeOnEscape);
        };
    }, [open]);

    return (
        <div ref={wrapperRef} className="agent-pill-wrap">
            <button
                type="button"
                className={`ghost-button agent-pill agent-pill--${view.tone}`}
                title={view.title}
                aria-haspopup="dialog"
                aria-expanded={open}
                onClick={() => {
                    setOpen((value) => !value);
                }}
            >
                <span className="agent-pill__dot" aria-hidden="true" />
                <span className="agent-pill__label">{view.label}</span>
            </button>
            {open ? (
                <div className="agent-popover" role="dialog" aria-label="Agent status">
                    <div className="agent-popover__title">
                        {view.tone === 'disconnected' ? 'Connect agent' : 'Agent status'}
                    </div>
                    {view.tone === 'disconnected' ? (
                        <CommandBox
                            command={command}
                            hint="Run in any harness to make this session a worker."
                            actionLabel="Copy"
                        />
                    ) : (
                        <>
                            <p className="agent-popover__status">{view.title}</p>
                            <p className="agent-popover__note">Agent chat will appear here in M3.</p>
                        </>
                    )}
                </div>
            ) : null}
            <span className="visually-hidden" role="status" aria-live="polite">
                {announcement}
            </span>
        </div>
    );
}

/** Search button opens the same palette as the global ⌘K/Ctrl-K shortcut. */
function SearchButton({ onClick }: { onClick: () => void }) {
    return (
        <button type="button" className="ghost-button search-button" onClick={onClick}>
            Search
            <span className="search-button__hint">⌘K</span>
        </button>
    );
}
