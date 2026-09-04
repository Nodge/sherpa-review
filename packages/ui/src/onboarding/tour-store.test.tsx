// @vitest-environment jsdom
import { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import { createUiSettingsStore, DEFAULT_UI_SETTINGS } from '../settings/settings-store.js';
import { canonicalIndex } from './tour-model.js';
import type { TourRunState } from './tour-store.js';
import { useTourActive, useTourRun } from './tour-store.js';

/**
 * Tour start and persistence. Both depend on global settings, and both can fail
 * silently: a tour started with defaults overwrites a completed one on the server, while a step number from a pass of another
 * length resumes at the wrong place.
 */

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
});

/** What the hooks returned in the last render: published by an effect instead of assignment during render. */
const probe: { active: boolean; run: TourRunState | null } = { active: false, run: null };

function ActiveProbe() {
    const active = useTourActive(true);
    useEffect(() => {
        probe.active = active;
    });
    return null;
}

function RunProbe({ agentConnected }: { agentConnected: boolean }) {
    const run = useTourRun({ agentConnected, onOpenChat: NOOP, onCloseChat: NOOP });
    useEffect(() => {
        probe.run = run;
    });
    return null;
}

const NOOP = (): void => undefined;

function mount(settings: UiSettingsStore, node: React.ReactNode): () => void {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    act(() => {
        root.render(<SettingsProvider store={settings}>{node}</SettingsProvider>);
    });
    const unmount = (): void => {
        act(() => {
            root.unmount();
        });
        host.remove();
    };
    mounted.push(unmount);
    return unmount;
}

/** Tour pass: `steps` steps forward. */
function forward(steps: number): void {
    for (let step = 0; step < steps; step += 1) {
        act(() => {
            probe.run?.next();
        });
    }
}

describe('tour start', () => {
    it('waits for actual settings and does not show the tour with defaults', () => {
        const settings = createUiSettingsStore();
        mount(settings, <ActiveProbe />);

        // Rendering starts after the loading timeout, so `completedAt` here belongs to no one.
        expect(settings.getSnapshot().onboarding.completedAt).toBeNull();
        expect(probe.active).toBe(false);

        act(() => {
            settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        });
        expect(probe.active).toBe(true);
    });

    it('does not revive a completed tour when the server responds', () => {
        const settings = createUiSettingsStore();
        mount(settings, <ActiveProbe />);

        act(() => {
            settings.applyLoaded({
                ...DEFAULT_UI_SETTINGS,
                onboarding: { completedAt: '2026-09-01T10:00:00.000Z', step: 0 },
            });
        });
        expect(probe.active).toBe(false);
    });
});

describe('pass persistence', () => {
    it('writes the canonical step number instead of the number in a pass without an agent', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        const unmount = mount(settings, <RunProbe agentConnected={false} />);

        forward(5);

        expect(probe.run?.step.id).toBe('fulldiff');
        // Step six in a pass without an agent, but its canonical number on disk.
        expect(probe.run?.index).toBe(5);
        expect(settings.getSnapshot().onboarding.step).toBe(canonicalIndex('fulldiff'));

        // New visit, agent present: the same number must restore the same step.
        unmount();
        mount(settings, <RunProbe agentConnected />);

        expect(probe.run?.step.id).toBe('fulldiff');
        expect(probe.run?.index).toBe(6);
        expect(probe.run?.steps).toHaveLength(8);
    });

    it('resumes at the next available step if left on the chat step and the agent is absent', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({
            ...DEFAULT_UI_SETTINGS,
            onboarding: { completedAt: null, step: canonicalIndex('chat') },
        });
        mount(settings, <RunProbe agentConnected={false} />);

        expect(probe.run?.step.id).toBe('fulldiff');
    });

    it('"Skip tour" closes the tour permanently', () => {
        const settings = createUiSettingsStore();
        settings.applyLoaded({ ...DEFAULT_UI_SETTINGS });
        mount(settings, <RunProbe agentConnected={false} />);

        act(() => {
            probe.run?.skip();
        });

        expect(settings.getSnapshot().onboarding.completedAt).not.toBeNull();
    });
});
