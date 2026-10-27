// @vitest-environment jsdom
import { fixtureIteration } from '@sherpa/fixtures';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDiffViewStore } from '../diff-view/store.js';
import { buildFileFilters, selectFilter } from '../filters/lens-filters.js';
import { createT } from '../i18n/index.js';
import { ShortcutsProvider } from '../shortcuts/context.tsx';
import { attachShortcuts, createShortcutRegistry } from '../shortcuts/registry.js';
import { SettingsProvider } from '../settings/context.tsx';
import type { UiSettingsStore } from '../settings/settings-store.js';
import type { UiStyle } from '../styles/extra-styles.js';
import { createUiSettingsStore } from '../settings/settings-store.js';
import { createThreadStore } from '../threads/store.js';
import { FilterSelect } from './filter-select.tsx';
import { ReviewActionBar } from './review-action-bar.tsx';
import { SettingsMenu } from './settings-menu.tsx';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Extra build styles: the test provides its own, so the mechanism is independent of `styles/extra/` contents. */
const extraStyles = vi.hoisted(() => [] as UiStyle[]);
vi.mock('../styles/extra-styles.js', () => ({ EXTRA_STYLES: extraStyles }));

const SAMPLE: UiStyle = { id: 'sample', label: { en: 'Sample style', ru: 'Sample style (ru)' } };
const SECOND: UiStyle = { id: 'second', label: { en: 'Second style', ru: 'Second style (ru)' } };

const t = createT('en');
const EDGE = fixtureIteration('edge');
const FILES = EDGE.diff.files.filter((file) => !file.generated);
const FILTERS = buildFileFilters({ files: FILES, ownership: EDGE.ownership, extra: [], t });

/** Action bar next to the menu: its Ship menu is a second popover that must not stay open alongside this menu. */
const MEDIUM = fixtureIteration('medium');
const MEDIUM_FILE_IDS = new Set(MEDIUM.diff.files.map((file) => file.fileId));
const COMPOSER_TRANSPORT = {
    save: () => Promise.reject(new Error('comments are not sent in this test')),
    update: () => Promise.reject(new Error('comments are not sent in this test')),
    delete: () => Promise.reject(new Error('comments are not sent in this test')),
};

const mounted: (() => void)[] = [];

afterEach(() => {
    for (const unmount of mounted.splice(0)) {
        unmount();
    }
    extraStyles.splice(0);
});

interface Harness {
    readonly host: HTMLElement;
    readonly settings: UiSettingsStore;
    readonly onOpenCommands: ReturnType<typeof vi.fn>;
    readonly onReplayTour: ReturnType<typeof vi.fn>;
    readonly pressEscape: () => void;
}

function mount({ agentConnected = true }: { agentConnected?: boolean } = {}): Harness {
    const host = document.createElement('div');
    document.body.append(host);
    const settings = createUiSettingsStore({ loaded: true });
    const onOpenCommands = vi.fn();
    const onReplayTour = vi.fn();
    // Menu Esc uses the registry priority order. Without a provider, nothing can close it.
    const registry = createShortcutRegistry();
    const detach = attachShortcuts(window, registry);
    const root = createRoot(host);

    act(() => {
        root.render(
            <ShortcutsProvider registry={registry}>
                <SettingsProvider store={settings}>
                    <FilterSelect filters={FILTERS} active={selectFilter(FILTERS, 'all')} onSelect={() => undefined} />
                    <ReviewActionBar
                        pr={MEDIUM.pr}
                        draftDestination="pr"
                        diff={MEDIUM.diff}
                        diffStore={createDiffViewStore({ files: MEDIUM.diff.files })}
                        threadStore={createThreadStore(MEDIUM.threads, MEDIUM_FILE_IDS)}
                        connection="online"
                        hostName="FixtureHost"
                        composerTransport={COMPOSER_TRANSPORT}
                        onPublish={() => Promise.reject(new Error('the verdict is not published in this test'))}
                        onComplete={() => undefined}
                        route={null}
                    />
                    <SettingsMenu
                        agentConnected={agentConnected}
                        onOpenCommands={onOpenCommands}
                        onReplayTour={onReplayTour}
                    />
                </SettingsProvider>
            </ShortcutsProvider>,
        );
    });
    mounted.push(() => {
        act(() => {
            root.unmount();
        });
        detach();
        host.remove();
    });

    return {
        host,
        settings,
        onOpenCommands,
        onReplayTour,
        pressEscape: () => {
            act(() => {
                window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            });
        },
    };
}

/** Full mouse press: mousedown first (closes other menus), then click. */
function press(element: HTMLElement): void {
    act(() => {
        element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        element.click();
    });
}

function trigger(host: HTMLElement): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>('.settings-menu__trigger');
    if (found === null) {
        throw new Error('settings menu has no trigger');
    }
    return found;
}

function panel(host: HTMLElement): HTMLElement | null {
    return host.querySelector<HTMLElement>('.settings-menu__panel');
}

/** A neighbouring popover trigger is needed to test mutual closing. */
function button(host: HTMLElement, selector: string, what: string): HTMLButtonElement {
    const found = host.querySelector<HTMLButtonElement>(selector);
    if (found === null) {
        throw new Error(`missing from harness: ${what}`);
    }
    return found;
}

/** Find a segment button by label. Segments of neighbouring settings have different labels. */
function segment(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.settings-menu__segment')].find(
        (button) => button.textContent.trim() === label,
    );
    if (found === undefined) {
        throw new Error(`settings menu has no segment "${label}"`);
    }
    return found;
}

function action(host: HTMLElement, label: string): HTMLButtonElement {
    const found = [...host.querySelectorAll<HTMLButtonElement>('.settings-menu__action')].find((button) =>
        button.textContent.includes(label),
    );
    if (found === undefined) {
        throw new Error(`settings menu has no item "${label}"`);
    }
    return found;
}

describe('settings menu', () => {
    it('trigger opens and closes the panel', () => {
        const { host } = mount();

        expect(panel(host)).toBeNull();
        expect(trigger(host).getAttribute('aria-expanded')).toBe('false');

        press(trigger(host));
        expect(panel(host)).not.toBeNull();
        expect(trigger(host).getAttribute('aria-expanded')).toBe('true');

        press(trigger(host));
        expect(panel(host)).toBeNull();
    });

    it('Esc closes the menu and returns focus to the trigger', () => {
        const { host, pressEscape } = mount();
        press(trigger(host));

        pressEscape();

        expect(panel(host)).toBeNull();
        expect(document.activeElement).toBe(trigger(host));
    });

    it('clicking outside closes the menu', () => {
        const { host } = mount();
        press(trigger(host));

        act(() => {
            document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        });

        expect(panel(host)).toBeNull();
    });
});

describe('settings menu beside other popovers', () => {
    it('opening the menu closes the filter select and vice versa', () => {
        const { host } = mount();
        const filterButton = button(host, '.filter-select__button', 'filter select');

        press(filterButton);
        expect(host.querySelector('.filter-select__menu')).not.toBeNull();

        press(trigger(host));
        expect(host.querySelector('.filter-select__menu')).toBeNull();
        expect(panel(host)).not.toBeNull();

        press(filterButton);
        expect(panel(host)).toBeNull();
        expect(host.querySelector('.filter-select__menu')).not.toBeNull();
    });

    it('opening the menu closes the Ship menu and vice versa', () => {
        const { host } = mount();
        const shipCaret = button(host, '.review-action-bar__ship-caret', 'Ship menu caret');

        press(shipCaret);
        expect(host.querySelector('.review-action-menu')).not.toBeNull();

        press(trigger(host));
        expect(host.querySelector('.review-action-menu')).toBeNull();
        expect(panel(host)).not.toBeNull();

        press(shipCaret);
        expect(panel(host)).toBeNull();
        expect(host.querySelector('.review-action-menu')).not.toBeNull();
    });
});

describe('settings from the menu', () => {
    it('extra style switches independently of the three theme options', () => {
        extraStyles.push(SAMPLE);
        const { host, settings } = mount();
        press(trigger(host));
        const themes = host.querySelector('[role="group"][aria-label="Theme"]');
        expect(themes?.querySelectorAll('button')).toHaveLength(3);
        const sample = button(host, '[role="switch"][aria-label="Sample style"]', 'Sample style');
        expect(sample.getAttribute('aria-checked')).toBe('false');

        press(sample);
        expect(settings.getSnapshot()).toMatchObject({ theme: 'auto', style: 'sample' });
        expect(sample.getAttribute('aria-checked')).toBe('true');
        for (const theme of ['light', 'dark'] as const) {
            press(segment(host, t(`settings.theme.${theme}`)));
            expect(settings.getSnapshot()).toMatchObject({ theme, style: 'sample' });
        }
        press(sample);
        expect(settings.getSnapshot()).toMatchObject({ theme: 'dark', style: null });
        expect(sample.getAttribute('aria-checked')).toBe('false');
        expect(panel(host)).not.toBeNull();
    });

    it('each style has its own switch and only one can be on', () => {
        extraStyles.push(SAMPLE, SECOND);
        const { host, settings } = mount();
        press(trigger(host));
        const switches = [...host.querySelectorAll<HTMLButtonElement>('.settings-menu__panel [role="switch"]')];
        expect(switches.map((element) => element.getAttribute('aria-label'))).toEqual(['Sample style', 'Second style']);
        const [sample, second] = switches;
        if (sample === undefined || second === undefined) {
            throw new Error('menu does not have two style switches');
        }

        press(sample);
        press(second);

        expect(settings.getSnapshot().style).toBe('second');
        expect(sample.getAttribute('aria-checked')).toBe('false');
        expect(second.getAttribute('aria-checked')).toBe('true');
    });

    it('has no style switch without extra styles', () => {
        const { host } = mount();
        press(trigger(host));

        expect(panel(host)).not.toBeNull();
        expect(host.querySelector('.settings-menu__panel [role="switch"]')).toBeNull();
    });

    it('segments write the selection to the settings store', () => {
        const { host, settings } = mount();
        press(trigger(host));

        press(segment(host, t('settings.theme.light')));
        expect(settings.getSnapshot().theme).toBe('light');

        press(segment(host, 'EN'));
        expect(settings.getSnapshot().locale).toBe('en');

        press(segment(host, 'L'));
        expect(settings.getSnapshot().textSize).toBe('l');

        // Selection applies in place. The menu stays open and three settings change in sequence.
        expect(panel(host)).not.toBeNull();
        expect(segment(host, 'L').getAttribute('aria-pressed')).toBe('true');
        expect(segment(host, 'M').getAttribute('aria-pressed')).toBe('false');
    });

    it('replaying onboarding resets the tour flag and restarts the pass', () => {
        const { host, settings, onReplayTour } = mount();
        settings.update({ onboarding: { completedAt: '2026-09-01T10:00:00.000Z', step: 5 } });
        press(trigger(host));

        press(action(host, t('settings.replay')));

        expect(settings.getSnapshot().onboarding).toEqual({ completedAt: null, step: 0 });
        expect(onReplayTour).toHaveBeenCalledTimes(1);
        expect(panel(host)).toBeNull();
    });

    it('commands row closes the menu and opens the palette', () => {
        const { host, onOpenCommands } = mount();
        press(trigger(host));

        press(action(host, t('settings.commands')));

        expect(onOpenCommands).toHaveBeenCalledTimes(1);
        expect(panel(host)).toBeNull();
    });

    it('onboarding step count reflects the current pass: eight with an agent, seven without', () => {
        const withAgent = mount();
        press(trigger(withAgent.host));
        expect(action(withAgent.host, t('settings.replay')).textContent).toContain(t('settings.steps', 8));

        const offline = mount({ agentConnected: false });
        press(trigger(offline.host));
        expect(action(offline.host, t('settings.replay')).textContent).toContain(t('settings.steps', 7));
    });
});
