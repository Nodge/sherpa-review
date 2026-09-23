import type { ReactNode } from 'react';
import { Fragment } from 'react';

import { Icon } from '../../icons/icon.tsx';
import './control-states.css';

/**
 * Basic control matrix: rows are the variants in the table in §5
 * (docs/design/SPEC-changes-2026-09-20.md), columns are rest, hover, pressed, disabled, focus.
 *
 * States are forced: `data-state` on a control enables the same `controls.css` rules
 * as live `:hover` / `:active` / `:focus-visible`. Otherwise half the table cannot be shown
 * at once, leaving nothing to compare with the design.
 */

type ControlState = 'rest' | 'hover' | 'active' | 'disabled' | 'focus';

const COLUMNS: readonly { state: ControlState; label: string }[] = [
    { state: 'rest', label: 'rest' },
    { state: 'hover', label: 'hover' },
    { state: 'active', label: 'pressed' },
    { state: 'disabled', label: 'disabled' },
    { state: 'focus', label: 'focus' },
];

/** State attributes for the control itself. */
function stateProps(state: ControlState): { 'data-state'?: string; disabled?: boolean } {
    if (state === 'rest') {
        return {};
    }
    if (state === 'disabled') {
        return { disabled: true };
    }
    return { 'data-state': state };
}

interface Row {
    readonly name: string;
    readonly where: string;
    readonly render: (state: ControlState) => ReactNode;
}

interface Section {
    readonly title: string;
    readonly rows: readonly Row[];
}

/** Button for one variant: the variant class plus a forced state. */
function ctl(variant: string, label: ReactNode, state: ControlState, extra?: string): ReactNode {
    return (
        <button type="button" className={`ctl ${variant}${extra === undefined ? '' : ` ${extra}`}`} {...stateProps(state)}>
            {label}
        </button>
    );
}

/** Segment: the active item does not react, so the state is forced on its neighbour. */
function segment(state: ControlState, small: boolean): ReactNode {
    const [active, idle] = small ? ['Visual', 'Markdown'] : ['Route', 'Full diff'];
    return (
        <div className={`ctl-tabs${small ? ' ctl-tabs--small' : ''}`}>
            <button type="button" className="ctl ctl--tab is-active">
                {active}
            </button>
            <button type="button" className="ctl ctl--tab" {...stateProps(state)}>
                {idle}
            </button>
        </div>
    );
}

function switcher(state: ControlState, on: boolean): ReactNode {
    return (
        <button
            type="button"
            className={`ctl-switch${on ? ' is-on' : ''}`}
            aria-pressed={on}
            {...stateProps(state)}
        >
            <span className="ctl-switch__track" aria-hidden="true">
                <span className="ctl-switch__knob" />
            </span>
            Open an issue
        </button>
    );
}

function checkbox(state: ControlState, on: boolean): ReactNode {
    return (
        <button type="button" className={`ctl-checkbox${on ? ' is-on' : ''}`} aria-pressed={on} {...stateProps(state)}>
            <span className="ctl-checkbox__box" aria-hidden="true">
                <Icon name="check" size={9} />
            </span>
            Mark viewed
        </button>
    );
}

const SECTIONS: readonly Section[] = [
    {
        title: 'Buttons · fill: hover moves the background one level, pressed moves it one more',
        rows: [
            {
                name: 'Primary',
                where: 'Ship, Ask the agent, Next',
                render: (state) => ctl('ctl--primary', 'Ship · 2', state),
            },
            {
                name: 'Attention',
                where: 'What changed…',
                render: (state) => ctl('ctl--attention', 'What changed…', state),
            },
            {
                name: 'Secondary solid',
                where: 'Save draft, Retry, Regenerate, Copy command',
                render: (state) => ctl('ctl--secondary', 'Save draft', state),
            },
            {
                name: 'Danger solid',
                where: 'Delete',
                render: (state) => ctl('ctl--danger', 'Delete', state),
            },
            {
                name: 'Viewed toggle · off',
                where: 'stop viewed mark',
                render: (state) => ctl('ctl--toggle', 'Mark viewed', state),
            },
            {
                name: 'Viewed toggle · on',
                where: 'stop viewed mark',
                render: (state) =>
                    ctl(
                        'ctl--toggle',
                        <>
                            <Icon name="check" size={13} />
                            Viewed
                        </>,
                        state,
                        'is-on',
                    ),
            },
            {
                name: 'Resolve toggle · off',
                where: 'comment header with an issue',
                render: (state) =>
                    ctl(
                        'ctl--toggle ctl--toggle-compact',
                        <>
                            <Icon name="dot" size={11} className="ctl__dot" />
                            Resolve
                        </>,
                        state,
                    ),
            },
            {
                name: 'Resolve toggle · on',
                where: 'comment header with an issue',
                render: (state) =>
                    ctl(
                        'ctl--toggle ctl--toggle-compact',
                        <>
                            <Icon name="check" size={11} />
                            Resolved
                        </>,
                        state,
                        'is-on',
                    ),
            },
        ],
    },
    {
        title: 'Buttons with and without borders',
        rows: [
            {
                name: 'Ghost',
                where: 'Cancel, Feedback, Search, Agent',
                render: (state) => ctl('ctl--ghost', 'Cancel', state),
            },
            {
                name: 'Danger ghost',
                where: 'Request changes',
                render: (state) => ctl('ctl--danger-ghost', 'Request changes', state),
            },
            {
                name: 'Quiet mono',
                where: '⇄ unified, collapse all',
                render: (state) => ctl('ctl--quiet', '⇄ unified', state),
            },
            {
                name: 'Link',
                where: 'read the full diff',
                render: (state) => ctl('ctl--link', 'Read the full diff →', state),
            },
            {
                name: 'Link · muted',
                where: 'Resolve, retry, cancel',
                render: (state) => ctl('ctl--link-muted', 'retry', state),
            },
            {
                name: 'Link · danger',
                where: 'Delete below a comment or note',
                render: (state) => ctl('ctl--link-danger', 'Delete', state),
            },
        ],
    },
    {
        title: 'Switch, tabs, chips · active segment does not react to hover',
        rows: [
            { name: 'Switch · off', where: 'Open an issue', render: (state) => switcher(state, false) },
            { name: 'Switch · on', where: 'Open an issue', render: (state) => switcher(state, true) },
            {
                name: 'Tabs / segment',
                where: 'view, preset, zone',
                render: (state) => segment(state, false),
            },
            {
                name: 'Segment · small',
                where: 'Visual | Markdown',
                render: (state) => segment(state, true),
            },
            {
                name: 'Filter chip · off',
                where: 'People · Bots · Resolved',
                render: (state) => ctl('ctl--chip', 'Bots 2', state),
            },
            {
                name: 'Filter chip · on',
                where: 'People · Bots · Resolved',
                render: (state) => ctl('ctl--chip', 'People 3', state, 'is-on'),
            },
        ],
    },
    {
        title: 'Icon buttons and checkbox',
        rows: [
            {
                name: 'Icon ghost 25×25',
                where: 'pencil, ✕',
                render: (state) => ctl('ctl--icon', <Icon name="pencil" size={14} />, state),
            },
            {
                name: 'Icon danger 25×25',
                where: 'trash',
                render: (state) => ctl('ctl--icon-danger', <Icon name="trash" size={14} />, state),
            },
            {
                name: 'Toolbar icon 26×24',
                where: 'composer toolbar',
                render: (state) => ctl('ctl--toolbar-icon', <Icon name="bold" size={14} />, state),
            },
            {
                name: 'Chevron 20×20',
                where: 'thread expansion, "⋯" in the tree',
                render: (state) => ctl('ctl--chevron', <Icon name="chev-down" size={13} />, state),
            },
            {
                name: 'Checkbox 12px · off',
                where: 'viewed mark in the file header',
                render: (state) => checkbox(state, false),
            },
            {
                name: 'Checkbox 12px · on',
                where: 'viewed mark in the file header',
                render: (state) => checkbox(state, true),
            },
        ],
    },
];

function ControlMatrix() {
    return (
        <div className="control-matrix">
            <div className="control-matrix__head">control · where</div>
            {COLUMNS.map((column) => (
                <div key={column.state} className="control-matrix__head">
                    {column.label}
                </div>
            ))}
            {SECTIONS.map((section) => (
                <Fragment key={section.title}>
                    <div className="control-matrix__group">{section.title}</div>
                    {section.rows.map((row) => (
                        <Fragment key={row.name}>
                            <div className="control-matrix__label">
                                <span className="control-matrix__name">{row.name}</span>
                                <span className="control-matrix__where">{row.where}</span>
                            </div>
                            {COLUMNS.map((column) => (
                                <div key={column.state} className="control-matrix__cell">
                                    {row.render(column.state)}
                                </div>
                            ))}
                        </Fragment>
                    ))}
                </Fragment>
            ))}
        </div>
    );
}

export const CONTROL_STATES = [
    {
        id: 'controls-matrix',
        group: 'Controls',
        title: 'states, dark theme',
        render: () => <ControlMatrix />,
    },
    {
        id: 'controls-matrix-light',
        group: 'Controls',
        title: 'states, light theme',
        render: () => (
            <div data-theme="light" className="gallery-themed">
                <ControlMatrix />
            </div>
        ),
    },
];
