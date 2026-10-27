import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { makeFixtureHost } from '@sherpa/fixtures';
import type { AgentNote } from '@sherpa/protocol';

import type { SherpaDatabase } from './db.js';
import { fixtureHostPlugin } from './hosts/fixture/plugin.js';
import type { HostPlugin, SelectedHost } from './hosts/plugin.js';
import { isProcessAlive } from './manifest.js';

/**
 * A host without the fixture host's dev capabilities: the `medium` fixture diff, without dev "push" or disabled
 * update checks. This is how the server sees any production host.
 */
export const plainHostPlugin: HostPlugin = {
    name: 'plain',
    keyPrefix: 'plain-',
    ui: fixtureHostPlugin.ui,
    make: () => ({ host: makeFixtureHost('medium') }),
};

/** Plugin that returns a ready-made host for any key: an empty prefix matches every key. */
export function hostPluginOf(selected: SelectedHost): HostPlugin {
    return { name: selected.name, ui: selected.ui, keyPrefix: '', make: () => selected };
}

/** Temporary state root for one test. */
export async function makeTempSherpaDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), 'sherpa-test-'));
}

export async function removeTempSherpaDir(dir: string): Promise<void> {
    await fs.rm(dir, { recursive: true, force: true });
}

/** A guaranteed dead PID: start a short-lived node process and wait for it to exit. */
export async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    const pid = child.pid;
    if (pid === undefined) {
        throw new Error('failed to start a process to obtain a dead PID');
    }

    await new Promise<void>((resolve) => {
        child.once('exit', () => {
            resolve();
        });
    });

    for (let attempt = 0; attempt < 100 && isProcessAlive(pid); attempt += 1) {
        await delay(20);
    }
    if (isProcessAlive(pid)) {
        throw new Error(`process ${String(pid)} did not exit, cannot prepare the stale manifest test`);
    }
    return pid;
}

/** GET to the local server. Sends a token only when one is set. */
export async function get(port: number, pathname: string, token?: string): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
}

/** POST with a raw body to test how the server handles invalid JSON. */
export async function postRaw(
    port: number,
    pathname: string,
    body: string,
    token?: string,
    signal?: AbortSignal,
): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body,
        ...(signal === undefined ? {} : { signal }),
    });
}

export async function postJson(
    port: number,
    pathname: string,
    body: unknown,
    token?: string,
    signal?: AbortSignal,
): Promise<Response> {
    return postRaw(port, pathname, JSON.stringify(body), token, signal);
}

/** PATCH with a JSON body, used only by the global UI settings endpoint. */
export async function patchJson(
    port: number,
    pathname: string,
    body: unknown,
    token?: string,
): Promise<Response> {
    return fetch(`http://127.0.0.1:${String(port)}${pathname}`, {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
        },
        body: JSON.stringify(body),
    });
}

/**
 * Stores fixture notes in the database with their exchanges, as an accepted agent answer
 * would. Anchor carryover tests need notes, regardless of how they were created.
 */
export function seedAgentNotes(db: SherpaDatabase, notes: readonly AgentNote[]): void {
    for (const note of notes) {
        db.prepare(
            `INSERT INTO chat_exchanges (
                id, question, anchor, status, answer, progress_text, error, task_id, head_commit,
                created_at, updated_at
             ) VALUES (?, ?, ?, 'done', ?, NULL, NULL, NULL, ?, ?, ?)`,
        ).run(
            note.exchangeId,
            `question ${String(note.exchangeId)}`,
            JSON.stringify(note.origin.anchor),
            note.text,
            note.origin.commit,
            note.createdAt,
            note.createdAt,
        );
        db.prepare(
            `INSERT INTO agent_notes (
                id, exchange_id, anchor, text, commit_hash, lost_anchor, origin_anchor, origin_commit, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
            note.id,
            note.exchangeId,
            JSON.stringify(note.anchor),
            note.text,
            note.origin.commit,
            note.lostAnchor ? 1 : 0,
            JSON.stringify(note.origin.anchor),
            note.origin.commit,
            note.createdAt,
        );
    }
}
