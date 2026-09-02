import fs from 'node:fs';

import type { UiSettings, UiSettingsPatch } from '@sherpa/protocol';
import { uiSettingsSchema } from '@sherpa/protocol';

import { settingsPathFor } from './paths.js';

/**
 * Global UI settings in `<sherpaDir>/settings.json` (M3-T16). All PR servers share the file,
 * so the disk is always the source of truth. Reads and patch merges both use fresh contents.
 * A missing file, malformed JSON or a field that fails validation yields schema defaults. Settings must not block the UI.
 */
export class SettingsStore {
    private readonly file: string;
    /** File permissions: settings live alongside tokens and use the same mode as state directories. */
    private static readonly FILE_MODE = 0o600;

    constructor(sherpaDir: string) {
        this.file = settingsPathFor(sherpaDir);
    }

    read(): UiSettings {
        return parseSettings(this.readRaw());
    }

    /** Merges the supplied fields with the latest file contents and writes the full result. */
    patch(partial: UiSettingsPatch): UiSettings {
        // A key without a value means "leave this field alone", not "restore the default".
        const changes = Object.fromEntries(Object.entries(partial).filter(([, value]) => value !== undefined));
        const next = uiSettingsSchema.parse({ ...this.read(), ...changes });
        this.write(next);
        return next;
    }

    private readRaw(): string | null {
        try {
            return fs.readFileSync(this.file, 'utf8');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
                process.stderr.write(`Could not read settings ${this.file} (${messageOf(error)}). Using defaults.\n`);
            }
            return null;
        }
    }

    /**
     * Atomic write using a temporary file in the same directory and `rename`. Otherwise, a neighboring PR's server
     * could read the file mid-write.
     */
    private write(settings: UiSettings): void {
        const temp = `${this.file}.${String(process.pid)}.${Date.now().toString(36)}.tmp`;
        try {
            fs.writeFileSync(temp, `${JSON.stringify(settings, null, 4)}\n`, {
                mode: SettingsStore.FILE_MODE,
            });
            // writeFileSync applies mode with umask, and the file may remain from a previous attempt.
            fs.chmodSync(temp, SettingsStore.FILE_MODE);
            fs.renameSync(temp, this.file);
        } catch (error) {
            fs.rmSync(temp, { force: true });
            throw error;
        }
    }
}

function parseSettings(raw: string | null): UiSettings {
    if (raw === null) {
        return uiSettingsSchema.parse({});
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (error) {
        process.stderr.write(`Could not parse settings as JSON (${messageOf(error)}). Using defaults.\n`);
        return uiSettingsSchema.parse({});
    }

    // zod drops unknown fields. The schema is the source of truth, so extra fields don't survive a write.
    const result = uiSettingsSchema.safeParse(parsed);
    if (result.success) {
        return result.data;
    }
    process.stderr.write('Settings failed schema validation. Using defaults.\n');
    return uiSettingsSchema.parse({});
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
