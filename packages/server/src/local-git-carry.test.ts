import { UI_ENDPOINTS, uiReviewProgressResponseSchema } from '@sherpa/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { gitAvailable } from './hosts/local/git-fixture.js';
import { localGitHostPlugin } from './hosts/local/git-plugin.js';
import { disposeGitProjectTemplate, GIT_PR_KEY, GitProject, PROJECT_PREFIX } from './hosts/local/git-project.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { get, hostPluginOf, makeTempSherpaDir, postJson, removeTempSherpaDir } from './test-support.js';

/**
 * Progress carryover on a running server with a local `git` host: editing one working-tree file
 * must not clear viewed marks on the others. The host's missing slices used to clear them.
 */

const PREFIX = PROJECT_PREFIX;

afterAll(() => {
    disposeGitProjectTemplate();
});

// The host uses real `git`: each endpoint spawns several processes, so the test timeout exceeds the default.
describe.skipIf(!gitAvailable)('progress between local host iterations', { timeout: 30_000 }, () => {
    let sherpaDir: string;
    let project: GitProject;
    let server: SherpaServer | null;
    let events: AbortController | null;
    let logged: string[];
    let restoreStderr: (() => void) | null;

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        project = new GitProject('sherpa-local-carry-');
        server = null;
        events = null;
        logged = [];
        restoreStderr = null;
    });

    afterEach(async () => {
        restoreStderr?.();
        events?.abort();
        await server?.close();
        project.cleanup();
        await removeTempSherpaDir(sherpaDir);
    });

    /** Server logs go to stderr. Read them as a person would in `server.log`. */
    function captureStderr(): void {
        const original = process.stderr.write.bind(process.stderr);
        process.stderr.write = (chunk: string | Uint8Array, ...rest: unknown[]): boolean => {
            logged.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString());
            return (original as (...args: unknown[]) => boolean)(chunk, ...rest);
        };
        restoreStderr = () => {
            process.stderr.write = original;
        };
    }

    it('keeps another file marked viewed when one file changes', async () => {
        captureStderr();
        project.seedTwoFiles();
        const host = project.makeHost();
        server = await startServer({
            updateChannel: null,
            feedbackChannel: null,
            prKey: GIT_PR_KEY,
            sherpaDir,
            longPollSeconds: 0.1,
            hosts: [
                hostPluginOf({
                    name: localGitHostPlugin.name,
                    ui: localGitHostPlugin.ui,
                    host,
                    refresh: () => host.refresh(),
                }),
            ],
        });
        // The iteration subscription is lazy. Without an open tab, nothing requests carryover.
        events = new AbortController();
        const stream = await fetch(
            `http://127.0.0.1:${String(server.port)}${UI_ENDPOINTS.events}?token=${server.token}`,
            { signal: events.signal },
        );
        expect(stream.status).toBe(200);

        const before = await host.getDiff();
        const fileA = before.files.find((file) => file.path === 'src/a.ts')?.fileId ?? '';
        const viewed = await postJson(
            server.port,
            UI_ENDPOINTS.reviewFileViewed,
            { fileId: fileA, viewed: true },
            server.token,
        );
        expect(viewed.status).toBe(200);

        project.repo.write(`${PREFIX}/src/b.ts`, 'const b = 3;\n');
        await host.refresh();
        const after = await host.getDiff();
        expect(after.diffId).not.toBe(before.diffId);

        const freshA = after.files.find((file) => file.path === 'src/a.ts')?.fileId ?? '';
        const freshB = after.files.find((file) => file.path === 'src/b.ts')?.fileId ?? '';
        await expect
            .poll(async () => (await readProgress(after.diffId)).find((file) => file.fileId === freshA)?.viewed, {
                timeout: 15_000,
            })
            .toBe(true);
        expect((await readProgress(after.diffId)).find((file) => file.fileId === freshB)?.viewed ?? null).toBeNull();
        expect(logged.join('')).toContain(
            `progress carryover ${before.diffId} → ${after.diffId}: ranges 0, files 1`,
        );
    });

    async function readProgress(diffId: string): Promise<{ fileId: string; viewed: boolean | null }[]> {
        const current = server;
        if (current === null) {
            throw new Error('server is not running');
        }
        const response = await get(
            current.port,
            `${UI_ENDPOINTS.reviewProgress}?diffId=${encodeURIComponent(diffId)}`,
            current.token,
        );
        expect(response.status).toBe(200);
        return uiReviewProgressResponseSchema.parse(await response.json()).files;
    }
});
