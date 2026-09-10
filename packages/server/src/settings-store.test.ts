import fs from 'node:fs/promises';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { settingsPathFor } from './paths.js';
import { SettingsStore } from './settings-store.js';
import { makeTempSherpaDir, removeTempSherpaDir } from './test-support.js';

describe('global UI settings', () => {
    let sherpaDir: string;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
    });

    afterEach(async () => {
        await removeTempSherpaDir(sherpaDir);
    });

    it('returns defaults when there is no file', () => {
        expect(new SettingsStore(sherpaDir).read()).toEqual({
            diffMode: 'unified',
            shipMode: 'ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'dark',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('preserves other settings in an old file and keeps the theme after reopening', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify({ diffMode: 'split', locale: 'en' }));
        const store = new SettingsStore(sherpaDir);
        expect(store.read()).toMatchObject({ theme: 'dark', diffMode: 'split', locale: 'en' });
        store.patch({ theme: 'light' });
        expect(new SettingsStore(sherpaDir).read()).toMatchObject({ theme: 'light', diffMode: 'split', locale: 'en' });
    });

    it('falls back to defaults for malformed JSON without throwing an error', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), '{ this is not json');

        expect(new SettingsStore(sherpaDir).read().diffMode).toBe('unified');
    });

    it('falls back to defaults for a value outside the schema', async () => {
        await fs.writeFile(settingsPathFor(sherpaDir), JSON.stringify({ diffMode: 'three-way' }));

        expect(new SettingsStore(sherpaDir).read().diffMode).toBe('unified');
    });

    it('patching one field leaves the others unchanged', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ shipMode: 'sticky_ship' });

        const settings = store.patch({ diffMode: 'split' });

        expect(settings).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'dark',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
        expect(new SettingsStore(sherpaDir).read()).toEqual(settings);
    });

    it('replaces a nested patch object in full without changing adjacent fields', () => {
        const store = new SettingsStore(sherpaDir);

        const settings = store.patch({ onboarding: { completedAt: null, step: 3 } });

        expect(settings.onboarding).toEqual({ completedAt: null, step: 3 });
        expect(settings.locale).toBe('auto');
    });

    it('a language patch does not reset onboarding', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ onboarding: { completedAt: null, step: 3 } });

        const settings = store.patch({ locale: 'en' });

        expect(settings).toMatchObject({ locale: 'en', onboarding: { completedAt: null, step: 3 } });
    });

    it('changes nothing for an empty patch', () => {
        const store = new SettingsStore(sherpaDir);
        store.patch({ diffMode: 'split' });

        expect(store.patch({}).diffMode).toBe('split');
    });

    it('two stores using one file do not overwrite fields from the other store', () => {
        const first = new SettingsStore(sherpaDir);
        const second = new SettingsStore(sherpaDir);

        first.patch({ diffMode: 'split' });
        const merged = second.patch({ shipMode: 'sticky_ship' });

        expect(merged).toMatchObject({ diffMode: 'split', shipMode: 'sticky_ship' });
        expect(first.read()).toEqual(merged);
    });

    it('drops unknown file fields on write', async () => {
        const file = settingsPathFor(sherpaDir);
        await fs.writeFile(file, JSON.stringify({ diffMode: 'split', pizza: 'pineapple' }));

        new SettingsStore(sherpaDir).patch({ shipMode: 'sticky_ship' });

        expect(JSON.parse(await fs.readFile(file, 'utf8'))).toEqual({
            diffMode: 'split',
            shipMode: 'sticky_ship',
            composerLayout: 'visual',
            locale: 'auto',
            theme: 'dark',
            onboarding: { completedAt: null, step: 0 },
            updates: { dismissedVersion: null },
        });
    });

    it('makes the settings file accessible only to its owner', async () => {
        new SettingsStore(sherpaDir).patch({ diffMode: 'split' });

        const stats = await fs.stat(settingsPathFor(sherpaDir));

        expect(stats.mode & 0o777).toBe(0o600);
    });

    it('leaves no temporary files after writing', async () => {
        new SettingsStore(sherpaDir).patch({ diffMode: 'split' });

        expect((await fs.readdir(sherpaDir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    });
});
