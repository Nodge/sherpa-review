import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import type { ServerManifest } from '@sherpa/protocol';
import { serverManifestSchema } from '@sherpa/protocol';

/** Manifest file permissions: it contains the bearer token (rpc-design §8, spec §6). */
const MANIFEST_MODE = 0o600;

/** Liveness probe for the adjacent server. It is a local request, so a longer wait buys nothing. */
const HEALTH_PROBE_TIMEOUT_MS = 1000;

/**
 * Claims a PR: the complete manifest appears at the path only if nobody has claimed it yet.
 * `link` to a ready temporary file is the only atomic POSIX "create if absent" operation.
 * Returns `false` if the manifest already exists, so another server has claimed the path.
 */
export async function claimManifest(manifestPath: string, manifest: ServerManifest): Promise<boolean> {
    const tmpPath = await stageManifest(manifestPath, manifest);
    try {
        await fs.link(tmpPath, manifestPath);
        return true;
    } catch (error) {
        if (isErrnoCode(error, 'EEXIST')) {
            return false;
        }
        throw error;
    } finally {
        await fs.rm(tmpPath, { force: true });
    }
}

/**
 * Removes another server's manifest deemed stale (`stale` is the value used for the decision,
 * or `null` if the path does not contain a manifest). An atomic rename moves the file aside,
 * then checks that it moved the intended file. Otherwise, a live server has claimed the path and the file
 * is restored.
 */
export async function releaseStaleManifest(manifestPath: string, stale: ServerManifest | null): Promise<void> {
    const asidePath = path.join(
        path.dirname(manifestPath),
        `.${path.basename(manifestPath)}.${randomUUID()}.stale`,
    );

    try {
        await fs.rename(manifestPath, asidePath);
    } catch {
        // Someone already removed the manifest. The work is done.
        return;
    }

    const moved = await readManifest(asidePath);
    if (!sameManifest(moved, stale)) {
        try {
            await fs.link(asidePath, manifestPath);
        } catch {
            // An even newer manifest occupies the path. There is nothing to restore.
        }
    }
    await fs.rm(asidePath, { force: true });
}

/** Ready-to-publish manifest in a temporary file beside the target, with the same permissions and filesystem. */
async function stageManifest(manifestPath: string, manifest: ServerManifest): Promise<string> {
    const parsed = serverManifestSchema.parse(manifest);
    const tmpPath = path.join(path.dirname(manifestPath), `.${path.basename(manifestPath)}.${randomUUID()}.tmp`);

    await fs.writeFile(tmpPath, `${JSON.stringify(parsed, null, 2)}\n`, { mode: MANIFEST_MODE });
    try {
        // writeFile applies mode with umask, so set permissions to 0600 explicitly.
        await fs.chmod(tmpPath, MANIFEST_MODE);
    } catch (error) {
        await fs.rm(tmpPath, { force: true });
        throw error;
    }
    return tmpPath;
}

function sameManifest(left: ServerManifest | null, right: ServerManifest | null): boolean {
    if (left === null || right === null) {
        return left === right;
    }
    return (
        left.pid === right.pid &&
        left.port === right.port &&
        left.token === right.token &&
        left.createdAt === right.createdAt
    );
}

function isErrnoCode(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}

/** Reads a manifest. Missing, malformed or schema-invalid manifests all return `null` (fail-closed). */
export async function readManifest(manifestPath: string): Promise<ServerManifest | null> {
    let raw: string;
    try {
        raw = await fs.readFile(manifestPath, 'utf8');
    } catch {
        return null;
    }

    let json: unknown;
    try {
        json = JSON.parse(raw);
    } catch {
        return null;
    }

    const parsed = serverManifestSchema.safeParse(json);
    return parsed.success ? parsed.data : null;
}

/** Removes the manifest only if it still describes this process. Other servers' manifests stay. */
export async function removeOwnManifest(manifestPath: string, manifest: ServerManifest): Promise<void> {
    const current = await readManifest(manifestPath);
    if (current?.pid !== manifest.pid || current.port !== manifest.port) {
        return;
    }
    await fs.rm(manifestPath, { force: true });
}

/** Checks whether a PID is alive. Signal 0 sends nothing and only checks for existence. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        // EPERM: the process exists but belongs to someone else. For this check, it counts as alive.
        return isErrnoCode(error, 'EPERM');
    }
}

/**
 * The server in the manifest is running: its PID is alive AND `/healthz` responds
 * with the same prKey using the manifest token (otherwise anyone could occupy the port).
 */
export async function isManifestServerAlive(manifest: ServerManifest): Promise<boolean> {
    if (!isProcessAlive(manifest.pid)) {
        return false;
    }
    return probeHealth(manifest);
}

async function probeHealth(manifest: ServerManifest): Promise<boolean> {
    try {
        const response = await fetch(`http://127.0.0.1:${String(manifest.port)}/healthz`, {
            headers: { authorization: `Bearer ${manifest.token}` },
            signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
        });
        if (!response.ok) {
            return false;
        }

        const body: unknown = await response.json();
        return isRecord(body) && body.ok === true && body.prKey === manifest.prKey;
    } catch {
        return false;
    }
}

/**
 * Removes stale manifests: those that fail the schema and those left by dead processes.
 * Called at server startup and skill launch (rpc-design §8). Returns the deleted files.
 */
export async function cleanStaleManifests(serversDir: string): Promise<string[]> {
    let entries: string[];
    try {
        entries = await fs.readdir(serversDir);
    } catch {
        return [];
    }

    const removed: string[] = [];
    for (const entry of entries) {
        if (!entry.endsWith('.json')) {
            continue;
        }

        const manifestPath = path.join(serversDir, entry);
        const manifest = await readManifest(manifestPath);
        if (manifest !== null && isProcessAlive(manifest.pid)) {
            continue;
        }

        await fs.rm(manifestPath, { force: true });
        removed.push(manifestPath);
    }
    return removed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
