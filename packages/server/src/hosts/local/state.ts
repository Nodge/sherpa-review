import fs from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import { localHostStatePathFor } from '../../paths.js';

/**
 * The directory a local key (`local-git-*`) reviews. This file supports restarts:
 * `sherpa up --local` supplies the directory only on first start, and the daemon restarts
 * without it after stopping itself.
 */

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

export interface LocalHostState {
    /** Absolute project directory path. */
    readonly repo: string;
    /** Branch where the review was created. null means the first snapshot has not recorded it yet. */
    readonly branch: string | null;
    /** Explicit comparison base. null means compute merge-base with the default base branch. */
    readonly base: string | null;
}

const stateSchema = z.object({
    repo: z.string().min(1),
    branch: z.string().min(1).nullable(),
    base: z.string().min(1).nullable(),
});

/** Saved key state. null means the file is missing or failed schema validation (fail-closed). */
export function readLocalHostState(sherpaDir: string, prKey: string): LocalHostState | null {
    let raw: string;
    try {
        raw = fs.readFileSync(localHostStatePathFor(sherpaDir, prKey), 'utf8');
    } catch {
        return null;
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return null;
    }
    const state = stateSchema.safeParse(parsed);
    return state.success ? state.data : null;
}

export function writeLocalHostState(sherpaDir: string, prKey: string, state: LocalHostState): void {
    const filePath = localHostStatePathFor(sherpaDir, prKey);
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: DIR_MODE });
    fs.writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
    // writeFileSync applies mode subject to umask and only on creation, so set permissions explicitly.
    fs.chmodSync(filePath, FILE_MODE);
}
