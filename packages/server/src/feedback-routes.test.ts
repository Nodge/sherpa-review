import { makeFixtureHost } from '@sherpa/fixtures';
import {
    PROTOCOL_VERSION,
    rpcErrorSchema,
    UI_ENDPOINTS,
    uiFeedbackResponseSchema,
    uiStateSchema,
} from '@sherpa/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fixtureHostPlugin } from './hosts/fixture/plugin.js';
import { RpcFailure } from './errors.js';
import type { FeedbackChannel, FeedbackIssueInput, FeedbackIssueOutcome, IssuesFeedbackChannel } from './feedback-channel.js';
import { linkFeedbackChannel } from './feedback-channel.js';
import type { SherpaServer } from './server.js';
import { startServer } from './server.js';
import { makeTempSherpaDir, postJson, removeTempSherpaDir, get, hostPluginOf } from './test-support.js';
import { SERVER_VERSION } from './version.js';

const PR_KEY = 'fixture-medium';
const ISSUES_URL = 'https://github.com/example/sherpa/issues';

describe('feedback channel', () => {
    let sherpaDir: string;
    let servers: SherpaServer[];

    beforeEach(async () => {
        sherpaDir = await makeTempSherpaDir();
        servers = [];
    });

    afterEach(async () => {
        for (const server of servers) {
            await server.close();
        }
        await removeTempSherpaDir(sherpaDir);
    });

    async function start(
        feedbackChannel: FeedbackChannel | null,
        currentUser: () => string | null | Promise<string | null> = () => 'alice',
    ): Promise<SherpaServer> {
        const host = makeFixtureHost('medium');
        const server = await startServer({
            prKey: PR_KEY,
            sherpaDir,
            idleSeconds: 0,
            hosts: [hostPluginOf({ name: 'fixture', ui: fixtureHostPlugin.ui, host, currentUser })],
            updateChannel: null,
            feedbackChannel,
        });
        servers.push(server);
        return server;
    }

    async function readState(server: SherpaServer) {
        return uiStateSchema.parse(await (await get(server.port, UI_ENDPOINTS.state, server.token)).json());
    }

    function issuesChannel(
        create: (input: FeedbackIssueInput) => Promise<FeedbackIssueOutcome>,
        overrides: Partial<IssuesFeedbackChannel> = {},
    ): IssuesFeedbackChannel {
        return {
            kind: 'issues',
            availability: () => ({ available: true, reason: null }),
            create,
            discussionUrl: 'https://chat.example/sherpa',
            ...overrides,
        };
    }

    it('creates an issue with the first line as its title and full automatic context', async () => {
        const create = vi.fn((_input: FeedbackIssueInput) =>
            Promise.resolve<FeedbackIssueOutcome>({ kind: 'created', key: 'FB-123', url: 'https://issues.example/FB-123' }),
        );
        const server = await start(issuesChannel(create));
        server.workerRegistry.register('w-feedback', 'claude-code', 'claude-opus-5');

        const state = await readState(server);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            {
                text: 'Publication status is not visible\nProblem details.',
                includeContext: true,
                context: { view: 'overview', routePhase: 'ready', uiVersion: '0.6.0' },
            },
            server.token,
        );

        expect(state.feedback).toEqual({
            kind: 'issues',
            available: true,
            reason: null,
            discussionUrl: 'https://chat.example/sherpa',
        });
        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'created',
            issueKey: 'FB-123',
            issueUrl: 'https://issues.example/FB-123',
            message: null,
        });
        expect(create).toHaveBeenCalledTimes(1);
        const input = create.mock.calls[0]?.[0];
        expect(input?.summary).toBe('Publication status is not visible');
        expect(input?.description).toContain('Publication status is not visible\nProblem details.');
        expect(input?.description).toContain(`Version: UI 0.6.0, server ${SERVER_VERSION}, protocol ${PROTOCOL_VERSION}`);
        expect(input?.description).toContain('PR: fixture-medium');
        expect(input?.description).toContain('View: overview');
        expect(input?.description).toContain('Route phase: ready');
        expect(input?.description).toContain('claude-code · claude-opus-5 · connected');
        expect(input?.description).toContain('User: alice');
    });

    it('sends text as is without context and does not request the login', async () => {
        const currentUser = vi.fn(() => 'alice');
        const create = vi.fn((_input: FeedbackIssueInput) =>
            Promise.resolve<FeedbackIssueOutcome>({ kind: 'created', key: null, url: null }),
        );
        const server = await start(issuesChannel(create), currentUser);

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Text without context', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'created',
            issueKey: null,
            issueUrl: null,
            message: null,
        });
        expect(create.mock.calls[0]?.[0].description).toBe('Text without context');
        expect(currentUser).not.toHaveBeenCalled();
    });

    it('includes the unavailable channel reason in the snapshot and endpoint response without calling create', async () => {
        const create = vi.fn(() => Promise.reject(new Error('not called')));
        const server = await start(
            issuesChannel(create, {
                availability: () => ({ available: false, reason: 'No access. Write in the chat.' }),
                discussionUrl: null,
            }),
        );

        const state = await readState(server);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Keep this text', includeContext: true, context: { view: 'diff', routePhase: 'none', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(state.feedback).toEqual({
            kind: 'issues',
            available: false,
            reason: 'No access. Write in the chat.',
            discussionUrl: null,
        });
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'unavailable',
            issueKey: null,
            issueUrl: null,
            message: 'No access. Write in the chat.',
        });
        expect(create).not.toHaveBeenCalled();
    });

    it('returns reduced functionality with the channel message when sending discovers unavailability', async () => {
        const server = await start(
            issuesChannel(() => Promise.resolve({ kind: 'unavailable', reason: 'Credentials could not be obtained.' })),
        );

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Keep this text', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json())).toEqual({
            outcome: 'unavailable',
            issueKey: null,
            issueUrl: null,
            message: 'Credentials could not be obtained.',
        });
    });

    it('returns an RPC error with the channel message when sending fails', async () => {
        const server = await start(
            issuesChannel(() =>
                Promise.reject(new RpcFailure('host_unavailable', 'The channel did not respond. Your text is saved.')),
            ),
        );

        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Retry later', includeContext: false, context: null },
            server.token,
        );

        expect(response.status).toBe(502);
        const error = rpcErrorSchema.parse(await response.json());
        expect(error.error.code).toBe('host_unavailable');
        expect(error.error.message).toBe('The channel did not respond. Your text is saved.');
    });

    it('returns the link channel URL in the snapshot and reduced functionality from the send endpoint', async () => {
        const server = await start(linkFeedbackChannel(ISSUES_URL));

        const state = await readState(server);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Outside the UI', includeContext: false, context: null },
            server.token,
        );

        expect(state.feedback).toEqual({ kind: 'link', url: ISSUES_URL });
        expect(response.status).toBe(200);
        const body = uiFeedbackResponseSchema.parse(await response.json());
        expect(body.outcome).toBe('unavailable');
        expect(body.message).toContain(ISSUES_URL);
    });

    it('returns null in the snapshot and reduced functionality from the endpoint without a channel', async () => {
        const server = await start(null);

        const state = await readState(server);
        const response = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'Nowhere', includeContext: false, context: null },
            server.token,
        );

        expect(state.feedback).toBeNull();
        expect(response.status).toBe(200);
        expect(uiFeedbackResponseSchema.parse(await response.json()).outcome).toBe('unavailable');
    });

    it('prevents server startup when the channel URL violates the contract', async () => {
        await expect(start(linkFeedbackChannel('javascript:alert(1)'))).rejects.toThrow(/contract/u);
    });

    it('validates required fields and the text limit before calling the channel', async () => {
        const create = vi.fn(() =>
            Promise.resolve<FeedbackIssueOutcome>({ kind: 'created', key: 'FB-3', url: 'https://issues.example/FB-3' }),
        );
        const server = await start(issuesChannel(create));

        const empty = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: '', includeContext: true, context: { view: 'route', routePhase: 'ready', uiVersion: '0.6.0' } },
            server.token,
        );
        const tooLong = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'x'.repeat(20_001), includeContext: false, context: null },
            server.token,
        );
        const badContext = await postJson(
            server.port,
            UI_ENDPOINTS.feedback,
            { text: 'ok', includeContext: true, context: { view: '', routePhase: 'unknown', uiVersion: '0.6.0' } },
            server.token,
        );

        expect(empty.status).toBe(400);
        expect(tooLong.status).toBe(400);
        expect(badContext.status).toBe(400);
        expect((await empty.json() as { error: { details?: string[] } }).error.details?.[0]).toContain('text:');
        expect(create).not.toHaveBeenCalled();
    });
});
