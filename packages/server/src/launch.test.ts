import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import { hasExited, terminateChild } from './launch.js';

/** Tests need not wait 2 s for SIGKILL because the logic does not depend on the pause length. */
const GRACE_MS = 300;

describe('terminateChild', () => {
    const spawned: ChildProcess[] = [];

    afterEach(() => {
        for (const child of spawned) {
            if (!hasExited(child)) {
                child.kill('SIGKILL');
            }
        }
        spawned.length = 0;
    });

    /** Like the daemon in start.ts: detached + unref. Exit events must still arrive after that. */
    function spawnDetached(source: string): ChildProcess {
        const child = spawn(process.execPath, ['-e', source], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
        child.unref();
        spawned.push(child);
        return child;
    }

    /**
     * Wait for the script marker. A signal sent before it appears reaches bare node
     * with default handlers, so the SIGKILL test would check the wrong behaviour.
     */
    async function spawnReady(source: string): Promise<ChildProcess> {
        const child = spawnDetached(`${source}\nprocess.stdout.write('ready');`);
        await new Promise((resolve) => child.stdout?.once('data', resolve));
        return child;
    }

    it('terminates a live process with SIGTERM', async () => {
        const child = await spawnReady('setInterval(() => {}, 1000);');

        expect(await terminateChild(child, GRACE_MS)).toBe(true);
        expect(child.signalCode).toBe('SIGTERM');
    });

    it('kills a process that ignores SIGTERM with SIGKILL', async () => {
        const child = await spawnReady("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");

        expect(await terminateChild(child, GRACE_MS)).toBe(true);
        expect(child.signalCode).toBe('SIGKILL');
    });

    it('does nothing to a process that has already exited', async () => {
        const child = spawnDetached('');
        await new Promise((resolve) => child.once('exit', resolve));

        expect(await terminateChild(child, GRACE_MS)).toBe(true);
        expect(child.signalCode).toBeNull();
        expect(child.exitCode).toBe(0);
    });
});
