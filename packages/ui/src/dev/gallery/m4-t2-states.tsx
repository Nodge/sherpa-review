import { chatFixtures, fixtureData, fixtureIteration, routeFixtures } from '@sherpa/fixtures';
import type { AgentNote, RouteSnapshot, RouteStop, Thread } from '@sherpa/protocol';
import type { ReactNode } from 'react';

import { shortCommit } from '../../i18n/index.js';

/**
 * The "Iterations" group has placeholders for second-pass screens (README §9, SPEC §2.16–2.17, §4.1).
 * M4-T8…T11 build the real components. Each state already has its own id and fixture data
 * to render, so those tasks change only the rendering and leave the registry alone.
 */

const V1 = fixtureIteration('medium');
const V2 = fixtureIteration('medium', 1);
const ITERATIONS = fixtureData('medium').iterations;
const SECOND_PASS = routeFixtures('medium')?.secondPass?.snapshot ?? null;
const FIRST_PASS = routeFixtures('medium')?.states.ready?.snapshot ?? null;
const NOTES_AFTER_PUSH = chatFixtures('medium')?.notesAfterPush ?? [];


function changedStops(snapshot: RouteSnapshot | null): RouteStop[] {
    return (snapshot?.stops ?? []).filter((stop) => stop.change !== null);
}

function stopByChange(kind: 'new' | 'changed'): RouteStop | undefined {
    return changedStops(SECOND_PASS).find((stop) => stop.change?.kind === kind);
}

function planNumber(stop: RouteStop | undefined): string {
    return String(stop?.planIndex ?? 0).padStart(2, '0');
}

const PINNED_THREAD: Thread | undefined = V2.threads.find(
    (thread) => thread.pinnedTo !== null && thread.pinnedTo.diffId !== V2.diff.diffId,
);
const LOST_NOTE: AgentNote | undefined = NOTES_AFTER_PUSH.find((note) => note.lostAnchor);

export const M4_T2_STATES = [
    {
        id: 'iterations-stale-banner',
        title: '"route is stale" banner',
        render: () => (
            <Draft owner="M4-T8" what="stale route banner">
                <Line label="route built for" value={shortCommit(FIRST_PASS?.commit ?? '')} />
                <Line label="PR is now on" value={shortCommit(V2.diff.headCommit)} />
                <Line label="affected stops" value={String(changedStops(SECOND_PASS).length)} />
            </Draft>
        ),
    },
    {
        id: 'iterations-second-pass-banner',
        title: 'second-pass banner with progress carryover',
        render: () => (
            <Draft owner="M4-T8" what="banner for changes since the last pass">
                <Line
                    label="progress carryover"
                    value={`${String(SECOND_PASS?.carried?.kept ?? 0)} of ${String(SECOND_PASS?.carried?.total ?? 0)}`}
                />
                <Line label="previous snapshot" value={SECOND_PASS?.previousSnapshotId ?? '—'} />
            </Draft>
        ),
    },
    {
        id: 'iterations-filter-new',
        title: '"changed stops only" filter',
        render: () => (
            <Draft owner="M4-T8" what="route filter for changed stops">
                <Line
                    label="remaining after filtering"
                    value={changedStops(SECOND_PASS)
                        .map((stop) => planNumber(stop))
                        .join(' · ')}
                />
                <Line label="total stops" value={String(SECOND_PASS?.stops.length ?? 0)} />
            </Draft>
        ),
    },
    {
        id: 'iterations-stop-changed',
        title: '"changed" stop badge',
        render: () => <StopDraft owner="M4-T8" kind="changed" />,
    },
    {
        id: 'iterations-stop-new',
        title: '"new" stop badge',
        render: () => <StopDraft owner="M4-T8" kind="new" />,
    },
    {
        id: 'iterations-why-changed',
        title: '"why this stop changed" block',
        render: () => (
            <Draft owner="M4-T8" what="stop change explanation">
                <Line label="stop" value={planNumber(stopByChange('changed'))} />
                <Paragraph text={stopByChange('changed')?.change?.reason ?? ''} />
                <Line
                    label="threads explaining the change"
                    value={(stopByChange('changed')?.change?.threadIds ?? []).join(', ') || '—'}
                />
            </Draft>
        ),
    },
    {
        id: 'iterations-snapshot-picker',
        title: 'snapshot and iteration selection',
        render: () => (
            <Draft owner="M4-T9" what="snapshot switcher">
                {ITERATIONS.map((iteration) => (
                    <Line
                        key={iteration.iteration.diffId}
                        label={shortCommit(iteration.iteration.headCommit)}
                        value={`iteration ${iteration.iteration.diffId}${iteration.replaces === null ? '' : ` · replaced ${iteration.replaces}`}`}
                    />
                ))}
            </Draft>
        ),
    },
    {
        id: 'iterations-old-snapshot-readonly',
        title: 'previous snapshot in read-only mode',
        render: () => (
            <Draft owner="M4-T9" what="old snapshot read-only mode">
                <Line label="snapshot" value={FIRST_PASS?.snapshotId ?? '—'} />
                <Line label="snapshot iteration" value={shortCommit(V1.diff.headCommit)} />
                {/* Read-only mode starts exactly when the active iteration differs. */}
                <Line label="active iteration" value={shortCommit(V2.diff.headCommit)} />
            </Draft>
        ),
    },
    {
        id: 'iterations-thread-pinned',
        title: 'thread pinned to an old commit',
        render: () => (
            <Draft owner="M4-T10" what="pinned-to chip and viewing at an old commit">
                <Line label="thread" value={PINNED_THREAD?.id ?? '—'} />
                <Line label="pinned to" value={shortCommit(PINNED_THREAD?.pinnedTo?.commit ?? '')} />
                <Line label="outdated" value={PINNED_THREAD?.outdated === true ? 'yes' : 'no'} />
                <Paragraph text={PINNED_THREAD?.root.body ?? ''} />
            </Draft>
        ),
    },
    {
        id: 'iterations-notes-lost',
        title: 'notes with lost anchors',
        render: () => (
            <Draft owner="M4-T11" what="notification about lost notes">
                <Line
                    label="lost anchors"
                    value={`${String(NOTES_AFTER_PUSH.filter((note) => note.lostAnchor).length)} of ${String(NOTES_AFTER_PUSH.length)}`}
                />
                <Line label="original anchor" value={anchorLabel(LOST_NOTE)} />
                <Paragraph text={LOST_NOTE?.text ?? ''} />
            </Draft>
        ),
    },
] as const;

function anchorLabel(note: AgentNote | undefined): string {
    if (note === undefined) {
        return '—';
    }
    const { path, start, end } = note.origin.anchor;
    return `${path}:${String(start)}–${String(end)}`;
}

function StopDraft({ owner, kind }: { owner: string; kind: 'new' | 'changed' }) {
    const stop = stopByChange(kind);
    return (
        <Draft owner={owner} what={`"${kind}" stop badge`}>
            <Line label="stop" value={`${planNumber(stop)} · ${stop?.title ?? '—'}`} />
            <Line label="classification" value={kind} />
            <Paragraph text={stop?.change?.reason ?? ''} />
        </Draft>
    );
}

/** Placeholder structure: task owner label plus the fixture data that will bring the state to life. */
function Draft({ owner, what, children }: { owner: string; what: string; children: ReactNode }) {
    return (
        <div
            style={{
                background: 'var(--surface-panel)',
                border: '1px solid var(--border-standard)',
                borderRadius: 8,
                padding: 16,
                display: 'flex',
                flexDirection: 'column',
                gap: 8,
                maxWidth: 720,
            }}
        >
            <div style={{ font: '10px/1.4 var(--font-mono)', color: 'var(--attention-text-dim)', letterSpacing: '0.08em' }}>
                PLACEHOLDER {owner} · {what}
            </div>
            {children}
        </div>
    );
}

function Line({ label, value }: { label: string; value: string }) {
    return (
        <div style={{ display: 'flex', gap: 12, font: '11.5px/1.5 var(--font-mono)' }}>
            <span style={{ color: 'var(--text-dim)', minWidth: 160 }}>{label}</span>
            <span style={{ color: 'var(--text-secondary)' }}>{value}</span>
        </div>
    );
}

function Paragraph({ text }: { text: string }) {
    return <p style={{ margin: 0, font: '12.5px/1.6 var(--font-sans)', color: 'var(--text-body)' }}>{text}</p>;
}
