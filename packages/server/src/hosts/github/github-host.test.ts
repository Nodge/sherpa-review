import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { RpcFailure } from '../../errors.js';

import type { FetchLike } from './client.js';
import { BODY_PLACEHOLDER } from './drafts.js';
import { GithubHost } from './github-host.js';
import { memoryIdempotencyStore } from './idempotency-store.js';
import type { MockGithubOptions } from './mock-transport.js';
import { VERDICT_REVIEW_MUTATION } from './queries.js';
import {
    makeMockGithubFetch,
    MOCK_HEAD_OID,
    MOCK_MERGE_BASE,
    MOCK_NUMBER,
    MOCK_OWNER,
    MOCK_REPO,
    MOCK_VIEWER_AVATAR,
} from './mock-transport.js';
import { avatarOf, userOf } from './threads.js';

/**
 * GitHub adapter against the recorded API: header, diff and thread mapping, drafts in a pending review,
 * publication and viewed marks. No live calls, all transport is mocked.
 */

const TOKEN = 'test-token-must-never-leak-42';

function makeHost(options: MockGithubOptions = {}, fetchImpl?: FetchLike): GithubHost {
    return new GithubHost({
        owner: MOCK_OWNER,
        repo: MOCK_REPO,
        number: MOCK_NUMBER,
        fetch: fetchImpl ?? makeMockGithubFetch(options),
        token: () => Promise.resolve(TOKEN),
        pollIntervalMs: 20,
        idempotency: memoryIdempotencyStore(),
        transport: { retryAttempts: 1 },
    });
}

function fileUrlAnchor(path: string): string {
    return createHash('sha256').update(path).digest('hex');
}

/** Host backed by a mock that also records variables for the named operation. */
function recordingHost(
    operation: string,
    sink: Record<string, unknown>[],
    options: MockGithubOptions = {},
): GithubHost {
    const inner = makeMockGithubFetch(options);
    return makeHost(options, (url: string, init?: RequestInit) => {
        const raw = typeof init?.body === 'string' ? init.body : '';
        if (raw.includes(operation)) {
            sink.push((JSON.parse(raw) as { variables: Record<string, unknown> }).variables);
        }
        return inner(url, init);
    });
}

/** The same mock, but with only files that have a patch in the file list. */
function onlyPatchedFiles(options: MockGithubOptions = {}): FetchLike {
    const inner = makeMockGithubFetch(options);
    return async (url: string, init?: RequestInit) => {
        const response = await inner(url, init);
        if (!new URL(url).pathname.endsWith('/files')) {
            return response;
        }
        const files = (await response.json()) as { patch?: string }[];
        return new Response(JSON.stringify(files.filter((file) => file.patch !== undefined)), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };
}

describe('GitHub adapter: reads', () => {
    it('maps the PR header to the contract using host terminology', async () => {
        const pr = await makeHost().getPr();

        expect(pr).toEqual({
            id: '42',
            url: 'https://github.com/acme/sherpa/pull/42',
            title: 'grid: count columns correctly',
            author: { login: 'carol', displayName: 'Carol Danvers', bot: false, avatarUrl: null },
            fromBranch: 'feature/columns',
            toBranch: 'main',
            state: 'open',
            statusLabel: 'open',
            checks: 'passed',
            updatedAt: '2026-09-20T10:15:00.000Z',
            capabilities: {
                publishVerdicts: ['comment', 'ship', 'request_changes'],
                fileViewedSync: true,
                fileContent: true,
                commentIssues: false,
                commentResolve: false,
                editPublished: true,
                iterations: false,
                blobs: true,
            },
            verdicts: [],
            viewer: { login: 'alice', displayName: 'Alice', bot: false, avatarUrl: MOCK_VIEWER_AVATAR },
        });
    });

    it('uses the token owner as the reviewer and refuses the header without a response', async () => {
        expect((await makeHost().getPr()).viewer).toEqual({
            login: 'alice',
            displayName: 'Alice',
            bot: false,
            avatarUrl: MOCK_VIEWER_AVATAR,
        });
        // `editPublished` depends on identity. Without it, the header would misrepresent edit permissions.
        await expect(makeHost({ viewer: null }).getPr()).rejects.toThrow(/token owner/);
    });

    it('takes the author photo from GitHub `avatarUrl`, allowing only https', () => {
        expect(userOf({ login: 'bob', __typename: 'User', avatarUrl: MOCK_VIEWER_AVATAR }).avatarUrl).toBe(MOCK_VIEWER_AVATAR);
        expect(userOf({ login: 'ci[bot]', __typename: 'Bot', avatarUrl: MOCK_VIEWER_AVATAR }).avatarUrl).toBe(MOCK_VIEWER_AVATAR);
        expect(avatarOf('http://ghe.local/avatars/u/1')).toBeNull();
        expect(avatarOf(undefined)).toBeNull();
    });

    it('maps draft PRs and states to status and state', async () => {
        const draft = await makeHost({ prOverrides: { isDraft: true } }).getPr();
        expect(draft.statusLabel).toBe('draft');
        expect(draft.state).toBe('open');

        const merged = await makeHost({ prOverrides: { state: 'MERGED', merged: true } }).getPr();
        expect(merged.state).toBe('merged');
        expect(merged.statusLabel).toBe('merged');

        const closed = await makeHost({ prOverrides: { state: 'CLOSED' } }).getPr();
        expect(closed.state).toBe('closed');
    });

    it('names a fork branch by its owner', async () => {
        const pr = await makeHost({ prOverrides: { headRepositoryOwner: { login: 'bob' } } }).getPr();

        expect(pr.fromBranch).toBe('bob:feature/columns');
    });

    it('maps the combined check status to contract terminology', async () => {
        for (const [state, checks] of [
            ['SUCCESS', 'passed'],
            ['FAILURE', 'failed'],
            ['ERROR', 'failed'],
            ['PENDING', 'pending'],
            ['EXPECTED', 'pending'],
            [null, null],
        ] as const) {
            expect((await makeHost({ prOverrides: { checksState: state } }).getPr()).checks).toBe(checks);
        }
    });

    it('shows a verdict after publishing it', async () => {
        const host = makeHost();
        await host.publishBatch('request_changes');

        expect((await host.getPr()).verdicts).toEqual([
            { user: { login: 'alice', displayName: null, bot: false, avatarUrl: null }, verdict: 'request_changes' },
        ]);
    });

    it('has one iteration and rejects a slice with a clear error', async () => {
        const host = makeHost();
        const iterations = await host.listIterations();

        expect(iterations).toEqual([
            {
                diffId: MOCK_HEAD_OID,
                baseCommit: MOCK_MERGE_BASE,
                headCommit: MOCK_HEAD_OID,
                createdAt: '2026-09-20T10:15:00.000Z',
                status: 'active',
            },
        ]);
        await expect(host.getDiff({ base: MOCK_HEAD_OID, head: MOCK_HEAD_OID })).rejects.toThrow(
            /one iteration/,
        );
    });

    it('maps diff files with change type, web links and statistics', async () => {
        const diff = await makeHost().getDiff();
        const service = diff.files.find((file) => file.path === 'src/service.ts');

        expect(diff.diffId).toBe(MOCK_HEAD_OID);
        expect(diff.baseCommit).toBe(MOCK_MERGE_BASE);
        expect(service).toMatchObject({
            fileId: 'src/service.ts',
            oldPath: null,
            changeType: 'modify',
            binary: false,
            generated: false,
            additions: 1,
            deletions: 1,
            viewed: false,
            blameUrl: `https://github.com/acme/sherpa/blame/${MOCK_HEAD_OID}/src/service.ts`,
            hostFileUrl: `https://github.com/acme/sherpa/pull/42/files#diff-${fileUrlAnchor('src/service.ts')}`,
            image: null,
        });
        expect(service?.patch).toContain('+    const port = 9090;');
    });

    it('checks the blob for binary status when a file has no patch instead of using statistics', async () => {
        const calls = new Map<string, number>();
        const files = (await makeHost({ calls }).getDiff()).files;

        expect(files.find((file) => file.path === 'src/generated.bin')).toMatchObject({
            binary: true,
            patch: null,
        });
        // No patch, but the blob is text. The file is simply too large for a patch.
        expect(files.find((file) => file.path === 'src/bundle.js')).toMatchObject({
            binary: false,
            patch: null,
            additions: 4000,
        });
        // Pure rename: no patch or lines, but this is an ordinary `.ts` file, not a binary file.
        expect(files.find((file) => file.path === 'src/renamed.ts')).toMatchObject({
            binary: false,
            patch: null,
            changeType: 'move',
            oldPath: 'src/old-name.ts',
            additions: 0,
            deletions: 0,
        });
        // One request for the entire diff, rather than one per file without a patch.
        expect(calls.get('SherpaBlobBinary')).toBe(1);
        // A deleted file has nothing to show in blame.
        expect(files.find((file) => file.path === 'src/legacy.ts')?.blameUrl).toBeNull();
    });

    it('treats a file without a patch as text when blobs do not respond', async () => {
        const files = (await makeHost({ failing: { SherpaBlobBinary: 500 } }).getDiff()).files;

        expect(files.find((file) => file.path === 'src/generated.bin')?.binary).toBe(false);
    });

    it('does not request binary status when every diff file has a patch', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({}, onlyPatchedFiles({ calls }));

        await host.getDiff();
        expect(calls.get('SherpaBlobBinary')).toBeUndefined();
    });

    it('gives images blob sides with dimensions and keeps svg as text', async () => {
        const files = (await makeHost().getDiff()).files;

        expect(files.find((file) => file.path === 'assets/logo.png')?.image).toEqual({
            mime: 'image/png',
            before: { blobId: `${MOCK_MERGE_BASE}:assets/logo.png`, size: 6 },
            after: { blobId: `${MOCK_HEAD_OID}:assets/logo.png`, size: 7 },
        });
        // An added image has no old side.
        expect(files.find((file) => file.path === 'assets/huge.png')?.image).toMatchObject({
            before: null,
            after: { blobId: `${MOCK_HEAD_OID}:assets/huge.png`, size: 12_000_000 },
        });

        const svg = files.find((file) => file.path === 'assets/icon.svg');
        expect(svg?.binary).toBe(false);
        expect(svg?.patch).toContain('<svg width="2">');
        expect(svg?.image?.mime).toBe('image/svg+xml');
    });

    it('returns null for side bytes at an unknown address or over the size limit', async () => {
        const host = makeHost();
        await host.getDiff();

        expect(await host.getBlob('no-such-blob')).toBeNull();
        expect(await host.getBlob(`${MOCK_HEAD_OID}:assets/huge.png`)).toBeNull();
        expect(await host.getBlob(`${MOCK_HEAD_OID}:assets/logo.png`)).toEqual(
            new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0x02, 0x03]),
        );
    });

    it('returns text from both file sides and null for images or oversized files', async () => {
        const host = makeHost();

        expect(await host.getFileContent('src/service.ts')).toEqual({
            oldText: 'export function serve() {\n    const port = 8080;\n    listen(port);\n    log("up");\n}\n',
            newText: 'export function serve() {\n    const port = 9090;\n    listen(port);\n    log("up");\n}\n',
        });
        // An added file does not exist at the base.
        expect(await host.getFileContent('docs/readme.md')).toEqual({
            oldText: null,
            newText: '# Sherpa\n\n',
        });
        expect(await host.getFileContent('assets/logo.png')).toBeNull();
        expect(await host.getFileContent('src/bundle.js')).toBeNull();
        await expect(host.getFileContent('no/such/file.ts')).rejects.toBeInstanceOf(RpcFailure);
    });

    it('maps diff threads with anchors, outdated state, resolved and bots', async () => {
        const threads = await makeHost().getThreads();

        expect(threads[0]).toMatchObject({
            id: 'th:PRRT_thread1',
            anchor: {
                fileId: 'src/service.ts',
                path: 'src/service.ts',
                position: { side: 'new', line: 3, size: 1 },
            },
            resolved: false,
            outdated: false,
            pinnedTo: { diffId: MOCK_HEAD_OID, commit: MOCK_HEAD_OID },
        });
        expect(threads[0]?.root.id).toBe('rc:PRRC_1');
        expect(threads[0]?.root.replies.map((reply) => reply.id)).toEqual(['rc:PRRC_2']);
        expect(threads[0]?.root.issue).toBeNull();

        // Outdated thread: no current coordinates, so use the original ones.
        expect(threads[1]).toMatchObject({
            id: 'th:PRRT_thread2',
            anchor: { position: { side: 'old', line: 1, size: 1 } },
            resolved: true,
            resolvedBy: 'bob',
            outdated: true,
        });
        expect(threads[1]?.root.author).toEqual({ login: 'review-bot[bot]', displayName: null, bot: true, avatarUrl: null });
        expect(threads[1]?.root.editedAt).toBe('2026-09-20T09:11:00.000Z');

        // Multiline anchor: line is the start, size is the span.
        expect(threads[2]?.anchor?.position).toEqual({ side: 'new', line: 2, size: 3 });
        // Comment on the entire file.
        expect(threads[3]?.anchor).toEqual({
            fileId: 'docs/readme.md',
            path: 'docs/readme.md',
            position: null,
        });
    });

    it('maps PR discussions from review bodies and issue comments', async () => {
        const threads = await makeHost().getThreads();

        expect(threads[4]).toMatchObject({
            id: 'rv:PRR_published',
            anchor: null,
            resolved: false,
            outdated: false,
            pinnedTo: null,
        });
        expect(threads[4]?.root).toMatchObject({
            id: 'rv:PRR_published',
            body: 'Took a quick look, questions inline.',
            draft: false,
        });
        expect(threads[5]?.id).toBe('ic:IC_1');
        expect(threads[5]?.root.author.login).toBe('dave');
    });

    it('reads all pages of threads, replies and files', async () => {
        const host = makeHost({ threadPageSize: 1, commentPageSize: 1, filePageSize: 2 });

        const threads = await host.getThreads();
        expect(threads.map((thread) => thread.id)).toEqual([
            'th:PRRT_thread1',
            'th:PRRT_thread2',
            'th:PRRT_thread3',
            'th:PRRT_thread4',
            'rv:PRR_published',
            'ic:IC_1',
        ]);
        expect(threads[0]?.root.replies).toHaveLength(1);
        expect((await host.getDiff()).files).toHaveLength(9);
    });
});

describe('GitHub adapter: writes', () => {
    it('creates one pending review lazily for all drafts', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        await host.getThreads();
        expect(calls.get('SherpaCreateReview')).toBeUndefined();

        await host.saveDraft({ body: 'First', parentId: null, anchor: null });
        await host.saveDraft({
            body: 'Second',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        expect(calls.get('SherpaCreateReview')).toBe(1);
    });

    it('stores a PR comment draft as a body paragraph and a line draft as a thread comment', async () => {
        const host = makeHost();

        const body = await host.saveDraft({ body: 'General question', parentId: null, anchor: null });
        expect(body.id).toMatch(/^rvb:PRR_draft_\d+:1$/);
        expect(body).toMatchObject({ body: 'General question', draft: true, issue: null });

        const inline = await host.saveDraft({
            body: 'Line question',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'old', line: 2, size: 2 } },
        });
        expect(inline.id).toMatch(/^rc:/);
        expect(inline.draft).toBe(true);

        const threads = await host.getThreads();
        const created = threads.find((thread) => thread.root.id === inline.id);
        expect(created?.anchor?.position).toEqual({ side: 'old', line: 2, size: 2 });
        expect(threads.find((thread) => thread.id === body.id)?.root.body).toBe('General question');
    });

    it('does not create a second draft for the same idempotency key', async () => {
        const host = makeHost();
        const options = { idempotencyKey: 'buffer-key-1' };

        const first = await host.saveDraft({ body: 'Retry', parentId: null, anchor: null }, options);
        const second = await host.saveDraft({ body: 'Retry', parentId: null, anchor: null }, options);

        expect(second.id).toBe(first.id);
        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts).toHaveLength(1);
    });

    it('checks the host after a lost creation response to avoid a duplicate draft', async () => {
        const inner = makeMockGithubFetch({});
        let breakNext = true;
        const host = makeHost(
            {},
            async (url: string, init?: RequestInit) => {
                const response = await inner(url, init);
                const body = typeof init?.body === 'string' ? init.body : '';
                if (breakNext && body.includes('SherpaUpdateReviewBody')) {
                    // GitHub already completed the write, but the response never reached us.
                    breakNext = false;
                    throw new TypeError('fetch failed');
                }
                return response;
            },
        );

        const created = await host.saveDraft({ body: 'Sent, but no response', parentId: null, anchor: null });
        expect(created.body).toBe('Sent, but no response');

        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts.map((draft) => draft.id)).toEqual([created.id]);
    });

    it('does not mistake a line draft for a paragraph when checking a failed body write', async () => {
        const inner = makeMockGithubFetch({});
        let breakNext = true;
        const host = makeHost({}, async (url: string, init?: RequestInit) => {
            const response = await inner(url, init);
            const body = typeof init?.body === 'string' ? init.body : '';
            if (breakNext && body.includes('SherpaUpdateReviewBody')) {
                breakNext = false;
                throw new TypeError('fetch failed');
            }
            return response;
        });

        // The same text is already a line draft. Copying a phrase is common.
        await host.saveDraft({
            body: 'The same applies here',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        const created = await host.saveDraft({ body: 'The same applies here', parentId: null, anchor: null });
        expect(created.id).toMatch(/^rvb:/);
    });

    it('preserves both body paragraphs when two PR comment drafts arrive at once', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        const [first, second] = await Promise.all([
            host.saveDraft({ body: 'One', parentId: null, anchor: null }),
            host.saveDraft({ body: 'Two', parentId: null, anchor: null }),
        ]);

        expect(first.id).not.toBe(second.id);
        // Lazy creation uses the queue too. GitHub cannot have a second pending review.
        expect(calls.get('SherpaCreateReview')).toBe(1);

        const bodies = (await host.getThreads())
            .flatMap((thread) => [thread.root, ...thread.root.replies])
            .filter((comment) => comment.draft)
            .map((comment) => comment.body);
        expect(new Set(bodies)).toEqual(new Set(['One', 'Two']));
    });

    it('creates a pending review with a placeholder body immediately', async () => {
        const created: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaCreateReview', created);

        await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        // GitHub refuses to append to a review created without a body, so send the placeholder immediately.
        expect(created.map((variables) => variables.body)).toEqual([BODY_PLACEHOLDER]);
        // The placeholder is not exposed as a comment. The only discussion here is on the line.
        const threads = await host.getThreads();
        expect(threads.filter((thread) => thread.anchor === null && thread.root.draft)).toEqual([]);
    });

    it('keeps the review body nonempty after removing the last paragraph and allows another draft', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'One', parentId: null, anchor: null });

        await host.deleteDraft(first.id);
        expect((await host.getThreads()).filter((thread) => thread.root.draft)).toEqual([]);

        // An empty body would break the review permanently, since the next edit would fail.
        const second = await host.saveDraft({ body: 'Two', parentId: null, anchor: null });
        expect(second.body).toBe('Two');
        expect((await host.getThreads()).find((thread) => thread.id === second.id)?.root.body).toBe('Two');
    });

    it('publishes paragraphs with markers and leaves out the placeholder', async () => {
        const withBody: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaSubmitReview', withBody);
        await host.saveDraft({ body: 'Summary', parentId: null, anchor: null });
        await host.publishBatch('ship');

        expect(withBody.map((variables) => variables.body)).toEqual(['<!-- sherpa:draft 1 -->\nSummary']);

        // Only line drafts: the review body is empty, and the placeholder does not belong in a published review.
        const inlineOnly: Record<string, unknown>[] = [];
        const other = recordingHost('SherpaSubmitReview', inlineOnly);
        await other.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await other.publishBatch('ship');
        expect(inlineOnly.map((variables) => variables.body)).toEqual(['']);
    });

    it('reports another unfinished review without text as a clear error instead of losing the draft', async () => {
        const host = makeHost({ pendingReviewBody: '' });

        // GitHub refuses to append a body to this review, so the error must be reported.
        await expect(host.saveDraft({ body: 'Summary', parentId: null, anchor: null })).rejects.toThrow(
            /pending review/,
        );
        // A line comment is added to it as usual.
        const inline = await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        expect(inline.draft).toBe(true);
    });

    it('edits and deletes a pending review started on the website as a draft paragraph', async () => {
        const host = makeHost({ pendingReviewBody: 'Draft from the website.' });

        const thread = (await host.getThreads()).find((candidate) => candidate.root.draft);
        expect(thread?.id).toBe('rvb:PRR_pending_web:0');
        expect(thread?.root.body).toBe('Draft from the website.');

        // The first rewrite adds a marker without changing the paragraph id.
        await host.updateDraft('rvb:PRR_pending_web:0', 'Added more on my machine.');
        expect((await host.getThreads()).find((candidate) => candidate.root.draft)?.root.body).toBe(
            'Added more on my machine.',
        );

        await host.deleteDraft('rvb:PRR_pending_web:0');
        expect((await host.getThreads()).filter((candidate) => candidate.root.draft)).toEqual([]);
    });

    it('leaves neighbors untouched when editing or removing a body paragraph', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'One', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'Two', parentId: first.id, anchor: null });

        await host.updateDraft(second.id, 'Two and a half');
        let root = (await host.getThreads()).find((thread) => thread.id === first.id);
        expect(root?.root.body).toBe('One');
        expect(root?.root.replies.map((reply) => reply.body)).toEqual(['Two and a half']);

        await host.deleteDraft(first.id);
        root = (await host.getThreads()).find((thread) => thread.id === second.id);
        expect(root?.root.body).toBe('Two and a half');
        expect(root?.root.replies).toEqual([]);
    });

    it('sends the viewed mark through a mutation and shows it in the next diff', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });
        await host.getDiff();

        await host.setFileViewed('src/service.ts', true);
        expect(calls.get('SherpaMarkFileAsViewed')).toBe(1);
        expect((await host.getDiff()).files.find((file) => file.path === 'src/service.ts')?.viewed).toBe(true);

        await host.setFileViewed('src/service.ts', false);
        expect(calls.get('SherpaUnmarkFileAsViewed')).toBe(1);
        expect((await host.getDiff()).files.find((file) => file.path === 'src/service.ts')?.viewed).toBe(false);
    });

    it('resolves only discussions on diff lines', async () => {
        const host = makeHost();

        await host.setThreadResolved('th:PRRT_thread1', true);
        expect((await host.getThreads()).find((thread) => thread.id === 'th:PRRT_thread1')?.resolved).toBe(true);

        await expect(host.setThreadResolved('rv:PRR_published', true)).rejects.toThrow(/PR discussion/);
        await expect(host.setThreadResolved('ic:IC_1', true)).rejects.toThrow(/PR discussion/);
    });

    it('edits published review text but does not delete it', async () => {
        const host = makeHost();

        await host.updateComment('rv:PRR_published', 'Rewrote the summary.');
        // Text without markers remains a single comment, keeping the discussion id unchanged.
        expect((await host.getThreads()).find((thread) => thread.id === 'rv:PRR_published')?.root.body).toBe(
            'Rewrote the summary.',
        );
        await expect(host.deleteComment('rv:PRR_published')).rejects.toThrow(/delete review text/);
    });

    it('edits and deletes a published issue comment', async () => {
        const host = makeHost();

        await host.updateComment('ic:IC_1', 'The build failed after all.');
        expect((await host.getThreads()).find((thread) => thread.id === 'ic:IC_1')?.root.body).toBe(
            'The build failed after all.',
        );

        await host.deleteComment('ic:IC_1');
        expect((await host.getThreads()).find((thread) => thread.id === 'ic:IC_1')).toBeUndefined();
    });

    it('edits a published line comment and deletes it with its thread', async () => {
        const host = makeHost();
        const inline = await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await host.publishBatch('request_changes');

        await host.updateComment(inline.id, 'Question resolved.');
        const thread = (await host.getThreads()).find((candidate) => candidate.root.id === inline.id);
        expect(thread?.root).toMatchObject({ body: 'Question resolved.', draft: false });

        await host.deleteComment(inline.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === inline.id)).toBeUndefined();
    });

    it('does not delete a line discussion root while it has replies', async () => {
        const host = makeHost();
        const root = await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        await host.publishBatch('request_changes');
        const reply = await host.saveDraft({ body: 'One more thing', parentId: root.id, anchor: null });
        await host.publishBatch('request_changes');

        // GitHub deletes the root along with the thread, which would silently lose the reviewer reply.
        await expect(host.deleteComment(root.id)).rejects.toThrow(/Delete the replies first/);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeDefined();

        await host.deleteComment(reply.id);
        await host.deleteComment(root.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeUndefined();
    });

    it('does not delete a draft line discussion root with replies either', async () => {
        const host = makeHost();
        const root = await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });
        const reply = await host.saveDraft({ body: 'One more thing', parentId: root.id, anchor: null });

        await expect(host.deleteDraft(root.id)).rejects.toThrow(/Delete the replies first/);

        await host.deleteDraft(reply.id);
        await host.deleteDraft(root.id);
        expect((await host.getThreads()).find((candidate) => candidate.root.id === root.id)).toBeUndefined();
    });

    it('edits and deletes a published review paragraph by rewriting the body', async () => {
        const host = makeHost();
        const first = await host.saveDraft({ body: 'One', parentId: null, anchor: null });
        const second = await host.saveDraft({ body: 'Two', parentId: first.id, anchor: null });
        await host.publishBatch('request_changes');

        // Markers remain in the body after publication, so the paragraph id survives it.
        await host.updateComment(second.id, 'Two and a half');
        let root = (await host.getThreads()).find((thread) => thread.id === first.id);
        expect(root?.root.body).toBe('One');
        expect(root?.root.replies.map((reply) => reply.body)).toEqual(['Two and a half']);

        await host.deleteComment(first.id);
        root = (await host.getThreads()).find((thread) => thread.id === second.id);
        expect(root?.root.body).toBe('Two and a half');

        // Removing the last paragraph leaves the review body empty, so the discussion is gone.
        await host.deleteComment(second.id);
        expect((await host.getThreads()).find((thread) => thread.root.body === 'Two and a half')).toBeUndefined();
    });

    it('uses separate endpoints for drafts and published comments', async () => {
        const host = makeHost();
        const draft = await host.saveDraft({ body: 'Draft', parentId: null, anchor: null });

        await expect(host.updateDraft('ic:IC_1', 'Wrong endpoint')).rejects.toThrow(/already published/);
        await expect(host.deleteDraft('ic:IC_1')).rejects.toThrow(/already published/);
        await expect(host.updateComment(draft.id, 'Wrong endpoint')).rejects.toThrow(/still a draft/);
        await expect(host.deleteComment(draft.id)).rejects.toThrow(/still a draft/);

        await expect(host.updateDraft('rc:PRRC_404', 'Does not exist')).rejects.toThrow(/not in this PR's discussions/);
        await expect(host.updateComment('no-prefix', 'Does not exist')).rejects.toThrow(/unrecognized comment id/);
    });

    it('publishes all drafts with the verdict in one submission', async () => {
        const host = makeHost();
        const body = await host.saveDraft({ body: 'Summary', parentId: null, anchor: null });
        const inline = await host.saveDraft({
            body: 'Question about the line',
            parentId: null,
            anchor: { fileId: 'src/service.ts', path: 'src/service.ts', position: { side: 'new', line: 3, size: 1 } },
        });

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(true);
        expect(result.failed).toEqual([]);
        expect(new Set(result.publishedCommentIds)).toEqual(new Set([body.id, inline.id]));

        const threads = await host.getThreads();
        const drafts = threads.flatMap((thread) =>
            [thread.root, ...thread.root.replies].filter((comment) => comment.draft),
        );
        expect(drafts).toEqual([]);
    });

    it('leaves the verdict unapplied and drafts unpublished after a failed submission', async () => {
        const host = makeHost({ graphqlErrors: { SherpaSubmitReview: 'Can not approve your own pull request' } });
        const draft = await host.saveDraft({ body: 'Summary', parentId: null, anchor: null });

        const result = await host.publishBatch('ship');

        expect(result.verdictApplied).toBe(false);
        expect(result.publishedCommentIds).toEqual([]);
        expect(result.failed.map((entry) => entry.commentId)).toEqual([draft.id]);
        expect(result.failed[0]?.message).toContain('Can not approve your own pull request');
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);
    });

    it('does not create a pending review for a verdict without drafts', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls });

        const result = await host.publishBatch('ship');

        expect(result).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(calls.get('SherpaCreateReview')).toBeUndefined();
        expect(calls.get('SherpaVerdictReview')).toBe(1);
    });

    it('rejects the verdict because GitHub has no sticky ship', async () => {
        await expect(makeHost().publishBatch('sticky_ship')).rejects.toThrow(/sticky ship/);
    });

    it('submits comment as a review without a verdict and uses the same body as a verdict', async () => {
        const submits: Record<string, unknown>[] = [];
        const host = recordingHost('SherpaSubmitReview', submits);
        const draft = await host.saveDraft({ body: 'Summary', parentId: null, anchor: null });

        expect(await host.publishBatch('comment')).toEqual({
            publishedCommentIds: [draft.id],
            failed: [],
            verdictApplied: true,
        });
        expect(submits.map(({ event, body }) => ({ event, body }))).toEqual([
            { event: 'COMMENT', body: '<!-- sherpa:draft 1 -->\nSummary' },
        ]);
        // A review without a verdict does not count as the reviewer verdict.
        expect((await host.getPr()).verdicts).toEqual([]);
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(false);
    });

    it('writes nothing for comment without drafts and leaves a placeholder pending review untouched', async () => {
        const calls = new Map<string, number>();
        const host = makeHost({ calls, pendingReviewBody: BODY_PLACEHOLDER });

        expect(await host.publishBatch('comment')).toEqual({ publishedCommentIds: [], failed: [], verdictApplied: true });
        expect(calls.get('SherpaSubmitReview')).toBeUndefined();
        expect(calls.get('SherpaVerdictReview')).toBeUndefined();
        expect(calls.get('SherpaCreateReview')).toBeUndefined();

        // No mutations without a pending review either.
        const bare = new Map<string, number>();
        expect(await makeHost({ calls: bare }).publishBatch('comment')).toEqual({
            publishedCommentIds: [],
            failed: [],
            verdictApplied: true,
        });
        expect(bare.get('SherpaVerdictReview')).toBeUndefined();
    });

    it('allows only comments on own PRs because GitHub forbids any author verdict', async () => {
        // Compare logins case-insensitively, as GitHub does.
        const host = makeHost({ prOverrides: { author: { login: 'Alice', __typename: 'User' } } });
        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment']);

        const draft = await host.saveDraft({ body: 'Summary', parentId: null, anchor: null });
        for (const verdict of ['ship', 'request_changes'] as const) {
            const error = await host.publishBatch(verdict).catch((caught: unknown) => caught);
            expect(error).toBeInstanceOf(RpcFailure);
            expect((error as RpcFailure).code).toBe('bad_request');
        }
        expect((await host.getThreads()).find((thread) => thread.id === draft.id)?.root.draft).toBe(true);

        expect((await host.publishBatch('comment')).publishedCommentIds).toEqual([draft.id]);
    });

    it('prevents the author from approving their PR in the mock, just like GitHub', async () => {
        const fetch = makeMockGithubFetch({ prOverrides: { author: { login: 'alice', __typename: 'User' } } });
        const response = await fetch('https://api.github.com/graphql', {
            method: 'POST',
            body: JSON.stringify({
                query: VERDICT_REVIEW_MUTATION,
                variables: { pullRequestId: 'PR_kwDOSherpa42', commitOID: MOCK_HEAD_OID, event: 'APPROVE' },
            }),
        });

        expect(JSON.stringify(await response.json())).toContain('Can not approve your own pull request');
    });

    it('treats a PR with no author (deleted account) as owned by another user', async () => {
        const host = makeHost({ prOverrides: { author: null as unknown as { login: string; __typename: string } } });

        expect((await host.getPr()).capabilities.publishVerdicts).toEqual(['comment', 'ship', 'request_changes']);
    });

    it('rejects a draft reply to a published PR discussion', async () => {
        await expect(
            makeHost().saveDraft({ body: 'Reply', parentId: 'ic:IC_1', anchor: null }),
        ).rejects.toThrow(/PR discussion/);
    });

    // The ownership lens is in `github-ownership.test.ts`. GitHub builds it from CODEOWNERS.
    it('has no additional host lenses', async () => {
        expect(await makeHost().extraLenses()).toEqual([]);
    });
});
