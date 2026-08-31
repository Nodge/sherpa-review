import { describe, expect, it, vi } from 'vitest';

import { browserCommand, openBrowser } from './browser.js';

const UI_URL = 'http://127.0.0.1:4317/#t=Ab_cd-12';

describe('system opener', () => {
    it('selects open, xdg-open and start by platform', () => {
        expect(browserCommand('darwin', UI_URL)).toEqual({ command: 'open', args: [UI_URL] });
        expect(browserCommand('linux', UI_URL)).toEqual({ command: 'xdg-open', args: [UI_URL] });
        expect(browserCommand('win32', UI_URL)).toEqual({
            command: 'cmd.exe',
            args: ['/d', '/s', '/c', 'start', '', UI_URL],
        });
        expect(browserCommand('freebsd', UI_URL)).toBeNull();
    });

    it('spawns the injected opener detached without opening a browser in the test', () => {
        const unref = vi.fn();
        const once = vi.fn();
        const spawnBrowser = vi.fn(() => ({ once, unref }));

        openBrowser({ uiUrl: UI_URL, platform: 'darwin', spawnBrowser });

        expect(spawnBrowser).toHaveBeenCalledWith('open', [UI_URL], { detached: true, stdio: 'ignore' });
        expect(once).toHaveBeenCalledWith('error', expect.any(Function));
        expect(unref).toHaveBeenCalledOnce();
    });

    it('falls back silently on spawn errors and unknown platforms', () => {
        expect(() => {
            openBrowser({
                uiUrl: UI_URL,
                platform: 'linux',
                spawnBrowser: () => {
                    throw new Error('xdg-open not found');
                },
            });
        }).not.toThrow();
        expect(() => {
            openBrowser({ uiUrl: UI_URL, platform: 'aix' });
        }).not.toThrow();
    });
});
