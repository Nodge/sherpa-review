import { Fragment } from 'react';

import type { ViewId } from '../session/views.js';
import type { AgentPillView } from './agent-pill-view.js';
import './top-bar.css';
import { ViewTabs } from './view-tabs.tsx';

/**
 * Top bar (README §0): mark, breadcrumb, view tabs, agent status, search and avatar.
 * The Feedback button comes in M5 with the feedback channel, so it is absent here.
 */
export interface TopBarProps {
    /** Distribution version from the UI package.json, injected at build time. */
    readonly version: string;
    /** Breadcrumb segments from left to right. The last is the PR itself. */
    readonly breadcrumb: readonly string[];
    readonly agent: AgentPillView;
    readonly view: ViewId;
    readonly onSelectView: (view: ViewId) => void;
}

export function TopBar({ version, breadcrumb, agent, view, onSelectView }: TopBarProps) {
    return (
        <header className="top-bar">
            <div className="top-bar__brand">
                <span className="top-bar__mark" aria-hidden="true" />
                <span className="top-bar__wordmark">Sherpa</span>
                <span className="top-bar__version">{version}</span>
            </div>

            <nav className="top-bar__breadcrumb" aria-label="Pull request">
                {breadcrumb.map((segment, index) => (
                    <Fragment key={`${String(index)}:${segment}`}>
                        {index === 0 ? null : (
                            <span className="top-bar__breadcrumb-separator" aria-hidden="true">
                                /
                            </span>
                        )}
                        <span className="top-bar__breadcrumb-item">{segment}</span>
                    </Fragment>
                ))}
            </nav>

            <div className="top-bar__spacer" />
            <ViewTabs view={view} onSelect={onSelectView} />
            <div className="top-bar__spacer" />

            <AgentPill view={agent} />
            <SearchButton />

            {/* The UI does not know the actual user until M1-T10, so do not invent initials. */}
            <div className="top-bar__avatar" aria-hidden="true" />
        </header>
    );
}

/**
 * Agent status. Clicking does nothing yet. The reconnection popover comes in M1-T15,
 * chat in M3 (SPEC §2.2).
 */
export function AgentPill({ view }: { view: AgentPillView }) {
    return (
        <Fragment>
            <button type="button" className={`ghost-button agent-pill agent-pill--${view.tone}`} title={view.title}>
                <span className="agent-pill__dot" aria-hidden="true" />
                <span className="agent-pill__label">{view.label}</span>
            </button>
            {/*
             * SPEC §2.2: announce agent disconnection once through a polite region. The region
             * is separate from the label, which also changes with the queue length. A screen reader would read
             * every such change. Here, text only appears on disconnection and clears when the agent
             * returns, with one announcement per transition.
             */}
            <span className="visually-hidden" role="status">
                {view.tone === 'disconnected' ? view.label : ''}
            </span>
        </Fragment>
    );
}

/** Search button styled to match the design. The command palette comes in M1-T9. */
function SearchButton() {
    return (
        <button type="button" className="ghost-button search-button">
            Search
            <span className="search-button__hint">⌘K</span>
        </button>
    );
}
