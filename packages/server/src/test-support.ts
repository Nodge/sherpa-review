import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isProcessAlive } from './manifest.js';

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
