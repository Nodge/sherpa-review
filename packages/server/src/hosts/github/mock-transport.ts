import { readFileSync } from 'node:fs';

/**
 * Adapter transport using the recorded GitHub API (`./mocks`). Live calls are forbidden in tests:
 * the contract suite and unit tests run only through this transport.
 *
 * Response shapes come from GitHub's GraphQL schema and REST documentation: field names, state enums,
 * connection `nodes`/`pageInfo`, and absent `patch` fields for binary files.
 *
 * A stateful mock. Mutations change threads, the pending review body, viewed marks and verdicts, and
 * queries return the changes. Otherwise the write contract suite would test static files.
 * An unknown operation or route fails the test instead of returning an empty response.
 */

export const MOCK_OWNER = 'acme';
export const MOCK_REPO = 'sherpa';
export const MOCK_NUMBER = 42;
export const MOCK_VIEWER = 'alice';

export const MOCK_PR_NODE_ID = 'PR_kwDOSherpa42';
export const MOCK_HEAD_OID = '4f1c9a1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f70';
export const MOCK_BASE_OID = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d';
export const MOCK_MERGE_BASE = '9e8d7c6b5a4938271605f4e3d2c1b0a998877665';
/** Branch head after a mock "push" (`MockGithubControl.push`). */
export const MOCK_PUSHED_HEAD_OID = 'bb00cc11dd22ee33ff445566778899aabbccddee';
/** Base commit after merging someone else's changes into it (`MockGithubControl.mergeIntoBase`). */
export const MOCK_MOVED_BASE_OID = '77665544332211009988aabbccddeeff00112233';

/**
 * CODEOWNERS for the recorded repository: the reviewer's own zone (`src`), another team's zone (`docs`)
 * and another person's zone (`assets`). Stored where GitHub looks first.
 */
export const MOCK_CODEOWNERS: Readonly<Record<string, string>> = {
    '.github/CODEOWNERS': ['# Mock owners', '/src/ @alice', '/docs/ @acme/docs-team', 'assets/ @bob', ''].join('\n'),
};

/** The token owner's teams by organization. They do not include `acme/docs-team`. */
export const MOCK_TEAMS: Readonly<Record<string, readonly string[]>> = { acme: ['core'] };

export function mockFile(name: string): string {
    return readFileSync(new URL(`./mocks/${name}`, import.meta.url), 'utf8');
}

function readMock(name: string): unknown {
    return JSON.parse(mockFile(name));
}

interface MockActor {
    login: string;
    __typename: string;
    name?: string;
}

interface MockComment {
    id: string;
    databaseId: number;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    author: MockActor;
    reviewId: string | null;
}

interface MockThread {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    resolvedBy: { login: string } | null;
    path: string;
    line: number | null;
    startLine: number | null;
    diffSide: string;
    startDiffSide: string | null;
    originalLine: number | null;
    originalStartLine: number | null;
    subjectType: string;
    comments: MockComment[];
}

interface MockReview {
    id: string;
    state: string;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    submittedAt: string | null;
    commitOid: string | null;
    author: MockActor;
}

interface MockIssueComment {
    id: string;
    body: string;
    createdAt: string;
    lastEditedAt: string | null;
    author: MockActor;
}

interface MockBlob {
    text?: string;
    isBinary: boolean;
    byteSize: number;
    base64?: string;
}

interface MockFile {
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
    previous_filename?: string;
}

interface MockPr {
    id: string;
    number: number;
    title: string;
    url: string;
    state: string;
    isDraft: boolean;
    merged: boolean;
    updatedAt: string;
    headRefName: string;
    baseRefName: string;
    headRepositoryOwner: { login: string } | null;
    author: MockActor;
    checksState: string | null;
}

/** Mock controls absent from the GitHub API. Tests call them directly. */
export interface MockGithubControl {
    /** The author's "push" moves the branch head to a new commit. */
    push?: () => void;
    /** Merge into the base branch. The base commit changes, the head stays, and owners files can be replaced. */
    mergeIntoBase?: (codeowners?: Readonly<Record<string, string>>) => void;
}

export interface MockGithubOptions {
    /** Operation or REST route → HTTP status instead of data. */
    readonly failing?: Readonly<Record<string, number>>;
    /** Operation → GitHub error text in `errors[]` (status 200, like the real API). */
    readonly graphqlErrors?: Readonly<Record<string, string>>;
    /** Call count by operation or route key, used to check caching. */
    readonly calls?: Map<string, number>;
    /** The token owner's login. null makes `viewer` return an error. */
    readonly viewer?: string | null;
    readonly control?: MockGithubControl;
    /** Page sizes. Small values trigger pagination in tests. */
    readonly threadPageSize?: number;
    readonly commentPageSize?: number;
    readonly filePageSize?: number;
    /** Remaining rate-limit window budget in each response. */
    readonly rateLimit?: { readonly remaining: number; readonly resetAt: string };
    /** Override PR header fields: draft, merge, check status. */
    readonly prOverrides?: Partial<MockPr>;
    /** An existing pending review owned by the token owner with this body, as if started on GitHub's website. */
    readonly pendingReviewBody?: string;
    /** CODEOWNERS files in the base branch by path. An empty map means no such files exist. */
    readonly codeowners?: Readonly<Record<string, string>>;
    /** The token owner's teams by organization. The token cannot see organizations outside the map. */
    readonly teams?: Readonly<Record<string, readonly string[]>>;
}

interface GraphqlRequest {
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
}

/** A GitHub failure as `errors[]` with status 200, matching the real API's response to an invalid request. */
class MockApiError extends Error {}

const NOT_FOUND = Symbol('not-found');

class MockGithubState {
    head = MOCK_HEAD_OID;
    base = MOCK_BASE_OID;
    /** Owners files at the current base commit. A merge into the base overwrites them. */
    codeowners: Readonly<Record<string, string>> = MOCK_CODEOWNERS;
    updatedAt: string;
    threads: MockThread[] = readMock('threads.json') as MockThread[];
    reviews: MockReview[] = readMock('reviews.json') as MockReview[];
    issueComments: MockIssueComment[] = readMock('comments.json') as MockIssueComment[];
    readonly viewed = new Set<string>();
    readonly pr: MockPr;
    readonly files = readMock('files.json') as MockFile[];
    readonly blobs = readMock('blobs.json') as Record<string, { old?: MockBlob; new?: MockBlob }>;

    /** The new node counter starts high so the mock does not reuse recorded IDs. */
    private nextId = 900;

    constructor(
        readonly viewerLogin: string | null,
        overrides: Partial<MockPr>,
        pendingBody: string | undefined,
    ) {
        this.pr = { ...readMock('pr.json') as MockPr, ...overrides };
        this.updatedAt = this.pr.updatedAt;
        if (pendingBody !== undefined) {
            this.reviews.push({
                id: 'PRR_pending_web',
                state: 'PENDING',
                body: pendingBody,
                createdAt: this.updatedAt,
                lastEditedAt: null,
                submittedAt: null,
                commitOid: this.head,
                author: this.viewer(),
            });
        }
    }

    push(): void {
        this.head = MOCK_PUSHED_HEAD_OID;
        this.touch();
    }

    /** Merge someone else's changes into the base. The base commit advances while the PR head stays. */
    mergeIntoBase(codeowners: Readonly<Record<string, string>> | undefined): void {
        this.base = MOCK_MOVED_BASE_OID;
        if (codeowners !== undefined) {
            this.codeowners = codeowners;
        }
        this.touch();
    }

    touch(): void {
        this.updatedAt = new Date(Date.parse(this.updatedAt) + 60_000).toISOString();
    }

    id(prefix: string): string {
        this.nextId += 1;
        return `${prefix}_${String(this.nextId)}`;
    }

    viewer(): MockActor {
        return { login: this.viewerLogin ?? MOCK_VIEWER, __typename: 'User', name: 'Alice' };
    }

    blob(expression: string): MockBlob | null {
        const separator = expression.indexOf(':');
        const sha = expression.slice(0, separator);
        const path = expression.slice(separator + 1);
        const sides = this.blobs[path];
        if (sides === undefined) {
            return null;
        }
        return (sha === MOCK_MERGE_BASE ? sides.old : sides.new) ?? null;
    }

    reviewById(id: unknown): MockReview {
        const review = this.reviews.find((candidate) => candidate.id === id);
        if (review === undefined) {
            throw new Error(`GitHub mock: review ${String(id)} does not exist`);
        }
        return review;
    }

    threadOfComment(commentId: unknown): MockThread {
        const thread = this.threads.find((candidate) =>
            candidate.comments.some((comment) => comment.id === commentId),
        );
        if (thread === undefined) {
            throw new Error(`GitHub mock: comment ${String(commentId)} does not exist`);
        }
        return thread;
    }
}

export function makeMockGithubFetch(
    options: MockGithubOptions = {},
): (input: string, init?: RequestInit) => Promise<Response> {
    const viewerLogin = options.viewer === undefined ? MOCK_VIEWER : options.viewer;
    const state = new MockGithubState(viewerLogin, options.prOverrides ?? {}, options.pendingReviewBody);
    state.codeowners = options.codeowners ?? MOCK_CODEOWNERS;
    if (options.control !== undefined) {
        options.control.push = (): void => {
            state.push();
        };
        options.control.mergeIntoBase = (codeowners): void => {
            state.mergeIntoBase(codeowners);
        };
    }

    const count = (key: string): void => {
        options.calls?.set(key, (options.calls.get(key) ?? 0) + 1);
    };

    return (input, init) => {
        const url = new URL(input);
        const method = init?.method ?? 'GET';

        if (url.pathname === '/graphql') {
            const request = parseGraphqlRequest(init);
            count(request.operation);

            const failure = options.failing?.[request.operation];
            if (failure !== undefined) {
                return Promise.resolve(jsonResponse('{"message":"mock failure"}', failure));
            }
            const apiError = options.graphqlErrors?.[request.operation];
            if (apiError !== undefined) {
                return Promise.resolve(apiErrorResponse(apiError));
            }
            // `rateLimit` exists only on `Query`. A mutation containing it is rejected in full.
            if (isMutation(request.query) && request.query.includes('rateLimit')) {
                return Promise.resolve(apiErrorResponse(RATE_LIMIT_ON_MUTATION));
            }

            let data: Record<string, unknown>;
            try {
                data = graphqlData(state, request, options, viewerLogin);
            } catch (error) {
                if (error instanceof MockApiError) {
                    return Promise.resolve(apiErrorResponse(error.message));
                }
                throw error;
            }
            // The remaining rate-limit window budget is available only for reads. `Mutation` has no such field.
            const envelope = isMutation(request.query) ? data : { rateLimit: rateLimitOf(options), ...data };
            return Promise.resolve(jsonResponse(JSON.stringify({ data: envelope }), 200));
        }

        const route = restRouteOf(url, method);
        count(route);
        const failure = options.failing?.[route];
        if (failure !== undefined) {
            return Promise.resolve(jsonResponse('{"message":"mock failure"}', failure));
        }

        const rest = restBody(state, url, route);
        if (rest === NOT_FOUND) {
            return Promise.resolve(jsonResponse('{"message":"Not Found"}', 404));
        }
        if (rest instanceof Uint8Array) {
            return Promise.resolve(
                new Response(rest, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
            );
        }
        return Promise.resolve(jsonResponse(rest, 200));
    };
}

/** The real GitHub error for a mutation containing `rateLimit`. The test checks this exact text. */
export const RATE_LIMIT_ON_MUTATION = "Field 'rateLimit' doesn't exist on type 'Mutation'";

/** The real GitHub error for editing a review created without a body. */
const EMPTY_BODY_EDIT_ERROR = 'VALIDATION: Could not edit a review with a missing body.';

function isMutation(query: string): boolean {
    return query.trimStart().startsWith('mutation');
}

function apiErrorResponse(message: string): Response {
    return jsonResponse(JSON.stringify({ data: null, errors: [{ message }] }), 200);
}

function rateLimitOf(options: MockGithubOptions): unknown {
    return {
        cost: 1,
        remaining: options.rateLimit?.remaining ?? 4999,
        resetAt: options.rateLimit?.resetAt ?? '2026-09-20T11:00:00Z',
    };
}

function parseGraphqlRequest(init: RequestInit | undefined): GraphqlRequest {
    const raw = typeof init?.body === 'string' ? init.body : '';
    if (raw === '') {
        throw new Error('GitHub mock: POST /graphql without a body');
    }
    const parsed = JSON.parse(raw) as { query?: unknown; variables?: unknown };
    if (typeof parsed.query !== 'string') {
        throw new Error('GitHub mock: no `query` in the request body');
    }
    const operation = /\b(?:query|mutation)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(parsed.query)?.[1];
    if (operation === undefined) {
        throw new Error('GitHub mock: unnamed operation. The adapter must name queries');
    }
    const variables =
        typeof parsed.variables === 'object' && parsed.variables !== null
            ? (parsed.variables as Record<string, unknown>)
            : {};
    return { operation, query: parsed.query, variables };
}

function graphqlData(
    state: MockGithubState,
    request: GraphqlRequest,
    options: MockGithubOptions,
    viewerLogin: string | null,
): Record<string, unknown> {
    const { operation, variables } = request;

    switch (operation) {
        case 'SherpaViewer': {
            if (viewerLogin === null) {
                throw new Error('GitHub mock: the test forbids whoami, but the adapter requested it');
            }
            return { viewer: { login: viewerLogin, name: state.viewer().name ?? null } };
        }
        case 'SherpaPr':
            return { repository: { pullRequest: metaNode(state) } };
        case 'SherpaPrTick':
            return {
                repository: {
                    pullRequest: {
                        ...metaNode(state),
                        reviewThreads: threadsPage(state, options, variables.threadCursor),
                        reviews: { nodes: state.reviews.map(reviewNode) },
                        comments: { nodes: state.issueComments.map(issueCommentNode) },
                    },
                },
            };
        case 'SherpaReviewThreadsPage':
            return {
                repository: {
                    pullRequest: { reviewThreads: threadsPage(state, options, variables.threadCursor) },
                },
            };
        case 'SherpaThreadComments': {
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`GitHub mock: thread ${String(variables.threadId)} does not exist`);
            }
            return { node: { comments: commentsPage(state, thread, options, variables.commentCursor) } };
        }
        case 'SherpaPrFiles':
            return { repository: { pullRequest: { files: filesPage(state, options, variables.fileCursor) } } };
        case 'SherpaFileContent':
            return {
                repository: {
                    old: blobNode(state, variables.oldExpression, 'all'),
                    new: blobNode(state, variables.newExpression, 'all'),
                },
            };
        case 'SherpaCodeowners': {
            const files = state.codeowners;
            const blob = (expression: unknown): unknown => {
                const [sha, path] = splitExpression(expression);
                // The PR base determines owners. The mock does not show the same file on the branch head.
                const text = sha === state.base ? files[path] : undefined;
                return text === undefined ? null : { text };
            };
            return {
                repository: {
                    githubDir: blob(variables.githubDir),
                    root: blob(variables.root),
                    docsDir: blob(variables.docsDir),
                },
            };
        }
        case 'SherpaOrgTeams': {
            const known = options.teams ?? MOCK_TEAMS;
            const orgs: Record<string, unknown> = {};
            for (const [alias, org] of Object.entries(variables)) {
                if (alias === 'viewer' || alias.endsWith('After')) {
                    continue;
                }
                const slugs = known[String(org)];
                orgs[alias] =
                    slugs === undefined
                        ? null
                        : { teams: { pageInfo: lastPage(), nodes: slugs.map((slug) => ({ slug })) } };
            }
            return orgs;
        }
        case 'SherpaBlobSizes':
        case 'SherpaBlobBinary': {
            const field = operation === 'SherpaBlobSizes' ? 'size' : 'binary';
            const repository: Record<string, unknown> = {};
            for (const [alias, expression] of Object.entries(variables)) {
                if (alias === 'owner' || alias === 'repo') {
                    continue;
                }
                repository[alias] = blobNode(state, expression, field);
            }
            return { repository };
        }
        case 'SherpaReviewBody': {
            const review = state.reviewById(variables.reviewId);
            return { node: { id: review.id, state: review.state, body: review.body } };
        }
        case 'SherpaMarkFileAsViewed':
            state.viewed.add(String(variables.path));
            state.touch();
            return { markFileAsViewed: { clientMutationId: null } };
        case 'SherpaUnmarkFileAsViewed':
            state.viewed.delete(String(variables.path));
            state.touch();
            return { unmarkFileAsViewed: { clientMutationId: null } };
        case 'SherpaResolveReviewThread':
        case 'SherpaUnresolveReviewThread': {
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`GitHub mock: thread ${String(variables.threadId)} does not exist`);
            }
            const resolved = operation === 'SherpaResolveReviewThread';
            thread.isResolved = resolved;
            thread.resolvedBy = resolved ? { login: state.viewer().login } : null;
            state.touch();
            const payload = { thread: { id: thread.id, isResolved: thread.isResolved } };
            return resolved ? { resolveReviewThread: payload } : { unresolveReviewThread: payload };
        }
        case 'SherpaCreateReview': {
            const review: MockReview = {
                id: state.id('PRR_draft'),
                state: 'PENDING',
                // Like real GitHub, a review created without a body gets an empty one.
                body: typeof variables.body === 'string' ? variables.body : '',
                createdAt: state.updatedAt,
                lastEditedAt: null,
                submittedAt: null,
                commitOid: String(variables.commitOID),
                author: state.viewer(),
            };
            state.reviews.push(review);
            state.touch();
            return { addPullRequestReview: { pullRequestReview: reviewNode(review) } };
        }
        case 'SherpaVerdictReview': {
            const review: MockReview = {
                id: state.id('PRR_verdict'),
                state: eventState(state, variables.event),
                body: '',
                createdAt: state.updatedAt,
                lastEditedAt: null,
                submittedAt: state.updatedAt,
                commitOid: String(variables.commitOID),
                author: state.viewer(),
            };
            state.reviews.push(review);
            state.touch();
            return { addPullRequestReview: { pullRequestReview: { id: review.id, state: review.state } } };
        }
        case 'SherpaSubmitReview': {
            const review = state.reviewById(variables.reviewId);
            if (review.state !== 'PENDING') {
                throw new Error('GitHub mock: submitting an already published review');
            }
            review.state = eventState(state, variables.event);
            // The submission body sets the review text, even for a review that previously had no body.
            if (typeof variables.body === 'string') {
                review.body = variables.body;
            }
            review.submittedAt = state.updatedAt;
            state.touch();
            return { submitPullRequestReview: { pullRequestReview: { id: review.id, state: review.state } } };
        }
        case 'SherpaAddReviewThread': {
            const review = state.reviewById(variables.reviewId);
            const comment = newComment(state, String(variables.body), review.id);
            const thread: MockThread = {
                id: state.id('PRRT'),
                isResolved: false,
                isOutdated: false,
                resolvedBy: null,
                path: String(variables.path),
                line: numberOrNull(variables.line),
                startLine: numberOrNull(variables.startLine),
                diffSide: stringOr(variables.side, 'RIGHT'),
                startDiffSide: variables.startSide === null ? null : stringOr(variables.startSide, 'RIGHT'),
                originalLine: numberOrNull(variables.line),
                originalStartLine: numberOrNull(variables.startLine),
                subjectType: stringOr(variables.subjectType, 'LINE'),
                comments: [comment],
            };
            state.threads.push(thread);
            state.touch();
            return {
                addPullRequestReviewThread: {
                    thread: {
                        id: thread.id,
                        comments: { pageInfo: lastPage(), nodes: [commentNode(state, comment)] },
                    },
                },
            };
        }
        case 'SherpaAddReviewThreadReply': {
            const review = state.reviewById(variables.reviewId);
            const thread = state.threads.find((candidate) => candidate.id === variables.threadId);
            if (thread === undefined) {
                throw new Error(`GitHub mock: thread ${String(variables.threadId)} does not exist`);
            }
            const comment = newComment(state, String(variables.body), review.id);
            thread.comments.push(comment);
            state.touch();
            return { addPullRequestReviewThreadReply: { comment: commentNode(state, comment) } };
        }
        case 'SherpaUpdateReviewBody': {
            const review = state.reviewById(variables.reviewId);
            // Real GitHub never allows editing a review without a body, on the first or any later attempt.
            if (review.body === '') {
                throw new MockApiError(EMPTY_BODY_EDIT_ERROR);
            }
            review.body = String(variables.body);
            review.lastEditedAt = state.updatedAt;
            state.touch();
            return { updatePullRequestReview: { pullRequestReview: reviewNode(review) } };
        }
        case 'SherpaUpdateReviewComment': {
            const thread = state.threadOfComment(variables.commentId);
            const comment = thread.comments.find((candidate) => candidate.id === variables.commentId);
            if (comment === undefined) {
                throw new Error('GitHub mock: comment disappeared between lookup and edit');
            }
            comment.body = String(variables.body);
            comment.lastEditedAt = state.updatedAt;
            state.touch();
            return {
                updatePullRequestReviewComment: {
                    pullRequestReviewComment: { id: comment.id, body: comment.body },
                },
            };
        }
        case 'SherpaDeleteReviewComment': {
            const thread = state.threadOfComment(variables.commentId);
            // Like real GitHub, deleting a root removes the whole discussion. Deleting a reply removes only itself.
            if (thread.comments[0]?.id === variables.commentId) {
                state.threads = state.threads.filter((candidate) => candidate.id !== thread.id);
            } else {
                thread.comments = thread.comments.filter((candidate) => candidate.id !== variables.commentId);
            }
            state.touch();
            return { deletePullRequestReviewComment: { clientMutationId: null } };
        }
        case 'SherpaUpdateIssueComment': {
            const comment = state.issueComments.find((candidate) => candidate.id === variables.commentId);
            if (comment === undefined) {
                throw new Error(`GitHub mock: comment ${String(variables.commentId)} does not exist`);
            }
            comment.body = String(variables.body);
            comment.lastEditedAt = state.updatedAt;
            state.touch();
            return { updateIssueComment: { issueComment: { id: comment.id, body: comment.body } } };
        }
        case 'SherpaDeleteIssueComment': {
            state.issueComments = state.issueComments.filter(
                (candidate) => candidate.id !== variables.commentId,
            );
            state.touch();
            return { deleteIssueComment: { clientMutationId: null } };
        }
        default:
            throw new Error(`GitHub mock does not know operation ${operation}`);
    }
}

function metaNode(state: MockGithubState): Record<string, unknown> {
    const { checksState, ...pr } = state.pr;
    return {
        ...pr,
        id: MOCK_PR_NODE_ID,
        updatedAt: state.updatedAt,
        headRefOid: state.head,
        baseRefOid: state.base,
        commits: {
            nodes: [{ commit: { statusCheckRollup: checksState === null ? null : { state: checksState } } }],
        },
        latestOpinionatedReviews: { nodes: opinionatedReviews(state) },
    };
}

/** "Latest meaningful reviews": one per author, approval and request changes only. */
function opinionatedReviews(state: MockGithubState): unknown[] {
    const byAuthor = new Map<string, MockReview>();
    for (const review of state.reviews) {
        if (review.state === 'APPROVED' || review.state === 'CHANGES_REQUESTED') {
            byAuthor.set(review.author.login, review);
        }
    }
    return [...byAuthor.values()].map((review) => ({
        state: review.state,
        author: { login: review.author.login, __typename: review.author.__typename },
    }));
}

function reviewNode(review: MockReview): Record<string, unknown> {
    return {
        id: review.id,
        state: review.state,
        body: review.body,
        createdAt: review.createdAt,
        lastEditedAt: review.lastEditedAt,
        submittedAt: review.submittedAt,
        commit: review.commitOid === null ? null : { oid: review.commitOid },
        author: review.author,
    };
}

function issueCommentNode(comment: MockIssueComment): Record<string, unknown> {
    return {
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        author: comment.author,
    };
}

function commentNode(state: MockGithubState, comment: MockComment): Record<string, unknown> {
    const review = state.reviews.find((candidate) => candidate.id === comment.reviewId) ?? null;
    return {
        id: comment.id,
        databaseId: comment.databaseId,
        body: comment.body,
        createdAt: comment.createdAt,
        lastEditedAt: comment.lastEditedAt,
        author: comment.author,
        pullRequestReview:
            review === null
                ? null
                : {
                      id: review.id,
                      state: review.state,
                      commit: review.commitOid === null ? null : { oid: review.commitOid },
                  },
    };
}

function newComment(state: MockGithubState, body: string, reviewId: string): MockComment {
    return {
        id: state.id('PRRC'),
        databaseId: 2000 + state.threads.length,
        body,
        createdAt: state.updatedAt,
        lastEditedAt: null,
        author: state.viewer(),
        reviewId,
    };
}

function threadsPage(
    state: MockGithubState,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.threadPageSize ?? 50;
    const start = cursorIndex(cursor);
    const page = state.threads.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, state.threads.length),
        nodes: page.map((thread) => threadNode(state, thread, options)),
    };
}

function threadNode(
    state: MockGithubState,
    thread: MockThread,
    options: MockGithubOptions,
): Record<string, unknown> {
    return { ...thread, comments: commentsPage(state, thread, options, null) };
}

function commentsPage(
    state: MockGithubState,
    thread: MockThread,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.commentPageSize ?? 10;
    const start = cursorIndex(cursor);
    const page = thread.comments.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, thread.comments.length),
        nodes: page.map((comment) => commentNode(state, comment)),
    };
}

function filesPage(
    state: MockGithubState,
    options: MockGithubOptions,
    cursor: unknown,
): Record<string, unknown> {
    const size = options.filePageSize ?? 100;
    const start = cursorIndex(cursor);
    const page = state.files.slice(start, start + size);
    return {
        pageInfo: pageInfoOf(start + page.length, state.files.length),
        nodes: page.map((file) => ({
            path: file.filename,
            viewerViewedState: state.viewed.has(file.filename) ? 'VIEWED' : 'UNVIEWED',
        })),
    };
}

/** A blob with exactly the fields the operation requested: content, size or binary status. */
function blobNode(state: MockGithubState, expression: unknown, fields: 'all' | 'size' | 'binary'): unknown {
    if (typeof expression !== 'string') {
        throw new Error('GitHub mock: blob address must be a string');
    }
    const blob = state.blob(expression);
    if (blob === null) {
        return null;
    }
    if (fields === 'size') {
        return { byteSize: blob.byteSize };
    }
    if (fields === 'binary') {
        return { isBinary: blob.isBinary };
    }
    return { text: blob.text ?? null, isBinary: blob.isBinary, byteSize: blob.byteSize };
}

/** Split a `<commit>:<path>` blob address into parts. */
function splitExpression(expression: unknown): [string, string] {
    if (typeof expression !== 'string') {
        throw new Error('GitHub mock: blob address must be a string');
    }
    const separator = expression.indexOf(':');
    return [expression.slice(0, separator), expression.slice(separator + 1)];
}

function restRouteOf(url: URL, method: string): string {
    const path = url.pathname;
    if (path.endsWith('/files')) {
        return 'rest:files';
    }
    if (path.includes('/compare/')) {
        return 'rest:compare';
    }
    if (path.includes('/contents/')) {
        return 'rest:contents';
    }
    throw new Error(`GitHub mock does not know route ${method} ${path}`);
}

function restBody(state: MockGithubState, url: URL, route: string): string | Uint8Array | typeof NOT_FOUND {
    switch (route) {
        case 'rest:files':
            return JSON.stringify(state.files);
        case 'rest:compare':
            return JSON.stringify({ merge_base_commit: { sha: MOCK_MERGE_BASE } });
        case 'rest:contents': {
            const path = decodeURIComponent(url.pathname.split('/contents/')[1] ?? '');
            const ref = url.searchParams.get('ref') ?? '';
            const blob = state.blob(`${ref}:${path}`);
            if (blob === null) {
                return NOT_FOUND;
            }
            return blob.base64 === undefined
                ? new TextEncoder().encode(blob.text ?? '')
                : Uint8Array.from(Buffer.from(blob.base64, 'base64'));
        }
        default:
            throw new Error(`GitHub mock does not know route ${route}`);
    }
}

function jsonResponse(body: string, status: number): Response {
    return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

function pageInfoOf(end: number, total: number): { hasNextPage: boolean; endCursor: string | null } {
    return end < total ? { hasNextPage: true, endCursor: `c${String(end)}` } : lastPage();
}

function lastPage(): { hasNextPage: boolean; endCursor: string | null } {
    return { hasNextPage: false, endCursor: null };
}

function cursorIndex(cursor: unknown): number {
    if (typeof cursor !== 'string' || !cursor.startsWith('c')) {
        return 0;
    }
    const index = Number(cursor.slice(1));
    return Number.isInteger(index) && index >= 0 ? index : 0;
}

/**
 * Review state after an event. Real GitHub prevents authors from approving or requesting changes
 * on their own PR. The failure arrives in `errors[]`, as in the real API.
 */
function eventState(state: MockGithubState, event: unknown): string {
    const own = state.pr.author.login.toLowerCase() === state.viewer().login.toLowerCase();
    if (event === 'COMMENT') {
        return 'COMMENTED';
    }
    if (event === 'APPROVE') {
        if (own) {
            throw new MockApiError('Review Can not approve your own pull request');
        }
        return 'APPROVED';
    }
    if (event === 'REQUEST_CHANGES') {
        if (own) {
            throw new MockApiError('Review Can not request changes on your own pull request');
        }
        return 'CHANGES_REQUESTED';
    }
    throw new Error(`GitHub mock: unknown review event ${String(event)}`);
}

function numberOrNull(value: unknown): number | null {
    return typeof value === 'number' ? value : null;
}

function stringOr(value: unknown, fallback: string): string {
    return typeof value === 'string' ? value : fallback;
}
