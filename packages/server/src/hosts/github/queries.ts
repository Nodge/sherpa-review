/**
 * GitHub GraphQL operation texts. Every operation is named. Its name goes into error messages
 * and lets the recorded API identify the request in tests.
 *
 * Queries request exactly the fields the adapter reads. The operation map and costs are in
 * `docs/research/github-api.md`.
 */

/**
 * Every read includes the remaining rate-limit window budget, so the client can decide whether to wait.
 * Mutations omit the field, since `rateLimit` exists only on `Query` and GitHub rejects the whole request.
 */
const RATE_LIMIT = 'rateLimit { cost remaining resetAt }';

/** Comment, review or PR author. Only people have `name`, bots and organizations do not. */
const AUTHOR = 'author { login __typename ... on User { name } }';

/** PR header with everything used to build `PrMeta`, the iteration and web file URLs. */
const PR_META = `
    id
    number
    title
    url
    state
    isDraft
    merged
    updatedAt
    headRefOid
    baseRefOid
    headRefName
    baseRefName
    headRepositoryOwner { login }
    ${AUTHOR}
    commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
    latestOpinionatedReviews(first: 100) { nodes { state author { login __typename } } }
`;

const THREAD_COMMENT = `
    id
    databaseId
    body
    createdAt
    lastEditedAt
    ${AUTHOR}
    pullRequestReview { id state commit { oid } }
`;

const REVIEW_THREADS = `
    reviewThreads(first: 50, after: $threadCursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
            id
            isResolved
            isOutdated
            resolvedBy { login }
            path
            line
            startLine
            diffSide
            startDiffSide
            originalLine
            originalStartLine
            subjectType
            comments(first: 10) {
                pageInfo { hasNextPage endCursor }
                nodes { ${THREAD_COMMENT} }
            }
        }
    }
`;

const PR_LEVEL = `
    reviews(last: 50) {
        nodes {
            id
            state
            body
            createdAt
            lastEditedAt
            submittedAt
            commit { oid }
            ${AUTHOR}
        }
    }
    comments(last: 50) {
        nodes {
            id
            body
            createdAt
            lastEditedAt
            ${AUTHOR}
        }
    }
`;

/** A separate PR header query, since `getPr` and `listIterations` do not read threads. */
export const PR_QUERY = `query SherpaPr($owner: String!, $repo: String!, $number: Int!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${PR_META} }
    }
}`;

/** A polling tick with the header, diff threads, reviews and PR comments in one query. */
export const TICK_QUERY = `query SherpaPrTick($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            ${PR_META}
            ${REVIEW_THREADS}
            ${PR_LEVEL}
        }
    }
}`;

/** Read remaining threads. More than 50 is rare, but the full list must arrive. */
export const THREADS_PAGE_QUERY = `query SherpaReviewThreadsPage($owner: String!, $repo: String!, $number: Int!, $threadCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) { ${REVIEW_THREADS} }
    }
}`;

/** Read remaining comments in a thread with more than 10 replies. */
export const THREAD_COMMENTS_QUERY = `query SherpaThreadComments($threadId: ID!, $commentCursor: String) {
    ${RATE_LIMIT}
    node(id: $threadId) {
        ... on PullRequestReviewThread {
            id
            comments(first: 50, after: $commentCursor) {
                pageInfo { hasNextPage endCursor }
                nodes { ${THREAD_COMMENT} }
            }
        }
    }
}`;

/** Viewed marks by file, absent from the REST file list. */
export const FILES_QUERY = `query SherpaPrFiles($owner: String!, $repo: String!, $number: Int!, $fileCursor: String) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
            files(first: 100, after: $fileCursor) {
                pageInfo { hasNextPage endCursor }
                nodes { path viewerViewedState }
            }
        }
    }
}`;

/** One review. Editing a paragraph needs its body without rereading the whole tick. */
export const REVIEW_BODY_QUERY = `query SherpaReviewBody($reviewId: ID!) {
    ${RATE_LIMIT}
    node(id: $reviewId) {
        ... on PullRequestReview { id state body }
    }
}`;

/** The token owner, also the reviewer's identity in the PR header (`PrMeta.viewer`). */
export const VIEWER_QUERY = `query SherpaViewer {
    ${RATE_LIMIT}
    viewer { login name }
}`;

/** Both file sides in one query, old at merge-base and new at the branch head. */
export const FILE_CONTENT_QUERY = `query SherpaFileContent($owner: String!, $repo: String!, $oldExpression: String!, $newExpression: String!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        old: object(expression: $oldExpression) { ... on Blob { text isBinary byteSize } }
        new: object(expression: $newExpression) { ... on Blob { text isBinary byteSize } }
    }
}`;

/**
 * Image-side sizes in one aliased query. The `ImageSide` contract needs `size`,
 * and individual queries would cost one point per side.
 */
export function blobSizesQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!`).join(', ');
    const fields = aliases
        .map((alias) => `${alias}: object(expression: $${alias}) { ... on Blob { byteSize } }`)
        .join('\n        ');
    return `query SherpaBlobSizes($owner: String!, $repo: String!, ${variables}) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        ${fields}
    }
}`;
}

/**
 * Binary status for files where REST returned no patch, in one aliased query. The file list
 * has no such flag, and statistics cannot determine it, since a pure rename has zero statistics.
 */
export function blobBinaryQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!`).join(', ');
    const fields = aliases
        .map((alias) => `${alias}: object(expression: $${alias}) { ... on Blob { isBinary } }`)
        .join('\n        ');
    return `query SherpaBlobBinary($owner: String!, $repo: String!, ${variables}) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        ${fields}
    }
}`;
}

export const MARK_FILE_VIEWED_MUTATION = `mutation SherpaMarkFileAsViewed($pullRequestId: ID!, $path: String!) {
    markFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

export const UNMARK_FILE_VIEWED_MUTATION = `mutation SherpaUnmarkFileAsViewed($pullRequestId: ID!, $path: String!) {
    unmarkFileAsViewed(input: { pullRequestId: $pullRequestId, path: $path }) { clientMutationId }
}`;

export const RESOLVE_THREAD_MUTATION = `mutation SherpaResolveReviewThread($threadId: ID!) {
    resolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

export const UNRESOLVE_THREAD_MUTATION = `mutation SherpaUnresolveReviewThread($threadId: ID!) {
    unresolveReviewThread(input: { threadId: $threadId }) { thread { id isResolved } }
}`;

/**
 * Lazy creation of a pending review. Without `event`, GitHub leaves the review as a draft.
 * The body is required and nonempty. GitHub does not allow editing a review created without a body
 * (`docs/research/github-api.md`), so it receives a placeholder immediately.
 */
export const CREATE_REVIEW_MUTATION = `mutation SherpaCreateReview($pullRequestId: ID!, $commitOID: GitObjectID!, $body: String!) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, body: $body }) {
        pullRequestReview { id state body createdAt lastEditedAt submittedAt commit { oid } ${AUTHOR} }
    }
}`;

/** A verdict without comments. There is no reason to create a pending review. */
export const VERDICT_REVIEW_MUTATION = `mutation SherpaVerdictReview($pullRequestId: ID!, $commitOID: GitObjectID!, $event: PullRequestReviewEvent!) {
    addPullRequestReview(input: { pullRequestId: $pullRequestId, commitOID: $commitOID, event: $event }) {
        pullRequestReview { id state }
    }
}`;

/**
 * Publishing sends the final review body as a submission parameter. There is no separate body edit
 * beforehand, since the placeholder would otherwise reach the published review and `updatePullRequestReview`
 * would no longer allow clearing it.
 */
export const SUBMIT_REVIEW_MUTATION = `mutation SherpaSubmitReview($reviewId: ID!, $event: PullRequestReviewEvent!, $body: String!) {
    submitPullRequestReview(input: { pullRequestReviewId: $reviewId, event: $event, body: $body }) {
        pullRequestReview { id state }
    }
}`;

export const ADD_REVIEW_THREAD_MUTATION = `mutation SherpaAddReviewThread($reviewId: ID!, $path: String!, $body: String!, $line: Int, $side: DiffSide, $startLine: Int, $startSide: DiffSide, $subjectType: PullRequestReviewThreadSubjectType) {
    addPullRequestReviewThread(input: {
        pullRequestReviewId: $reviewId,
        path: $path,
        body: $body,
        line: $line,
        side: $side,
        startLine: $startLine,
        startSide: $startSide,
        subjectType: $subjectType
    }) {
        thread {
            id
            comments(first: 1) { pageInfo { hasNextPage endCursor } nodes { ${THREAD_COMMENT} } }
        }
    }
}`;

export const ADD_REVIEW_THREAD_REPLY_MUTATION = `mutation SherpaAddReviewThreadReply($reviewId: ID!, $threadId: ID!, $body: String!) {
    addPullRequestReviewThreadReply(input: {
        pullRequestReviewId: $reviewId,
        pullRequestReviewThreadId: $threadId,
        body: $body
    }) {
        comment { ${THREAD_COMMENT} }
    }
}`;

/** The review body is the only place GitHub allows a PR draft. */
export const UPDATE_REVIEW_BODY_MUTATION = `mutation SherpaUpdateReviewBody($reviewId: ID!, $body: String!) {
    updatePullRequestReview(input: { pullRequestReviewId: $reviewId, body: $body }) {
        pullRequestReview { id state body createdAt lastEditedAt submittedAt commit { oid } ${AUTHOR} }
    }
}`;

export const UPDATE_REVIEW_COMMENT_MUTATION = `mutation SherpaUpdateReviewComment($commentId: ID!, $body: String!) {
    updatePullRequestReviewComment(input: { pullRequestReviewCommentId: $commentId, body: $body }) {
        pullRequestReviewComment { id body }
    }
}`;

export const DELETE_REVIEW_COMMENT_MUTATION = `mutation SherpaDeleteReviewComment($commentId: ID!) {
    deletePullRequestReviewComment(input: { id: $commentId }) { clientMutationId }
}`;

export const UPDATE_ISSUE_COMMENT_MUTATION = `mutation SherpaUpdateIssueComment($commentId: ID!, $body: String!) {
    updateIssueComment(input: { id: $commentId, body: $body }) { issueComment { id body } }
}`;

export const DELETE_ISSUE_COMMENT_MUTATION = `mutation SherpaDeleteIssueComment($commentId: ID!) {
    deleteIssueComment(input: { id: $commentId }) { clientMutationId }
}`;

/**
 * Base-branch CODEOWNERS from the 3 locations GitHub checks, in one aliased query.
 * The PR base file determines owners, not the branch head file. Otherwise a CODEOWNERS change in the PR
 * would have to apply to the PR itself.
 */
export const CODEOWNERS_QUERY = `query SherpaCodeowners($owner: String!, $repo: String!, $githubDir: String!, $root: String!, $docsDir: String!) {
    ${RATE_LIMIT}
    repository(owner: $owner, name: $repo) {
        githubDir: object(expression: $githubDir) { ... on Blob { text } }
        root: object(expression: $root) { ... on Blob { text } }
        docsDir: object(expression: $docsDir) { ... on Blob { text } }
    }
}`;

/**
 * The reviewer's teams in CODEOWNERS owner organizations, with one alias per organization.
 * Requires the `read:org` scope. Without it, GitHub returns an error and team ownership
 * is not resolved (`docs/research/github-api.md`).
 */
export function orgTeamsQuery(aliases: readonly string[]): string {
    const variables = aliases.map((alias) => `$${alias}: String!, $${alias}After: String`).join(', ');
    const fields = aliases
        .map(
            (alias) => `${alias}: organization(login: $${alias}) {
        teams(first: 100, userLogins: [$viewer], after: $${alias}After) {
            pageInfo { hasNextPage endCursor }
            nodes { slug }
        }
    }`,
        )
        .join('\n    ');
    return `query SherpaOrgTeams($viewer: String!, ${variables}) {
    ${RATE_LIMIT}
    ${fields}
}`;
}
