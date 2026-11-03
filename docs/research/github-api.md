# GitHub API: what the adapter uses

**2026-09-21 · before implementing the github.com host. 2026-09-22 · expanded after live acceptance testing on a real PR.** Operation shapes come from GitHub's GraphQL schema and REST documentation. What the live API confirms and what remains unverified is listed at the end. This covers only what code cannot show: why GraphQL was chosen, where REST is needed, what one polling tick costs and what GitHub cannot do.

## Why GraphQL instead of REST

GitHub's REST API spreads PR data across a dozen endpoints (`pulls`, `pulls/comments`, `issues/comments`, `reviews`, `reviews/comments`, `check-runs`), each with its own pagination. REST does not expose thread state (`isResolved`, `isOutdated`, multiline anchors, `viewerViewedState`) at all. GraphQL returns all of it in one query, so a polling tick takes one call instead of a dozen.

## Operation map

| `ReviewHost` operation | Mechanism |
|---|---|
| `getPr` | `SherpaPr`: `repository.pullRequest`, state, draft status, head and base, author, latest commit's `statusCheckRollup`, `latestOpinionatedReviews` |
| `listIterations` | the same header + REST `compare` for merge-base |
| `getDiff` | REST `…/pulls/{n}/files` (patch text) + `SherpaPrFiles` (`viewerViewedState`) + `SherpaBlobSizes` (dimensions on each image side) + `SherpaBlobBinary` (binary status of files without a patch) |
| `getThreads` / `watchThreads` | `SherpaPrTick`: header, `reviewThreads`, `reviews`, `comments`. Remaining pages are read with `SherpaReviewThreadsPage` and `SherpaThreadComments` |
| `getFileContent` | `SherpaFileContent`: `repository.object(expression: "<commit>:<path>")` with 2 aliases |
| `getBlob` | REST `…/contents/{path}?ref=<commit>` with `Accept: application/vnd.github.raw+json` |
| `setFileViewed` | `markFileAsViewed` / `unmarkFileAsViewed` |
| `saveDraft` (line) | `addPullRequestReviewThread` in a pending review |
| `saveDraft` (reply) | `addPullRequestReviewThreadReply` |
| `saveDraft` (PR level) | `updatePullRequestReview`, a paragraph in the pending review body |
| `updateDraft` / `deleteDraft` | `updatePullRequestReviewComment` / `deletePullRequestReviewComment`, `updateIssueComment` / `deleteIssueComment`, rewriting the review body |
| `setThreadResolved` | `resolveReviewThread` / `unresolveReviewThread` |
| `publishBatch` | `submitPullRequestReview` with the final body (when a pending review exists) or `addPullRequestReview` with `event` (a verdict without comments). `comment` uses the `COMMENT` event and makes no API call without drafts |

## The 3 REST endpoints and why they use REST

1. **Patch text.** `GET /repos/{o}/{r}/pulls/{n}/files?per_page=100`. GraphQL's `PullRequestChangedFile` has a path, statistics and `viewerViewedState`, but no patch. Only REST returns the unified diff.
2. **Merge-base.** `GET /repos/{o}/{r}/compare/{base}...{head}`, field `merge_base_commit.sha`. GraphQL's `PullRequest` has `baseRefOid` and `headRefOid`, but no common ancestor.
3. **File bytes.** `GET /repos/{o}/{r}/contents/{path}?ref=<sha>` with a raw `Accept`. GraphQL's `Blob.text` returns only text. It is `null` for binary files, and the blob has no base64 field.

## A file without a patch: binary, huge or just renamed

A file list entry can lack `patch` in 3 different cases, and the list alone cannot distinguish them. Measurements on a live PR (2026-09-22) show why. Binary `assets/logo.png` has `status: modified`, `additions: 0`, `deletions: 0` and no patch. Text file `big.txt` with 60000 added lines also has no patch, but its statistics are nonzero. **A pure rename has `status: renamed`, `additions: 0`, `deletions: 0` and no patch**, which is exactly the same pattern as a binary file.

So "no patch and zero statistics" does not establish binary status, and with that rule an ordinary `.ts` file that only moved would show the reviewer "binary file not shown". The adapter asks the blob itself through `repository.object(expression: "<commit>:<path>") { ... on Blob { isBinary } }`, in one query with aliases for the whole diff, and only when files without patches exist. For a deleted file it uses merge-base and the old path. For the others it uses the branch head and the new path. If the blob is missing or the query fails, the adapter uses `binary: false`, because a text file without a patch is more honest than a false binary label.

## The pending review body and its placeholder

A PR-level draft lives as a paragraph in the pending review body. GitHub has a tangle of rules around that body (all measured 2026-09-22):

- `addPullRequestReview` without `body` creates a pending review with `body: ""`.
- `updatePullRequestReview` on that review returns `VALIDATION: Could not edit a review with a missing body.`. **A body can never be added after creation**.
- `addPullRequestReview` with a nonempty `body` works, and subsequent calls to `updatePullRequestReview` work any number of times.
- Writing an empty string to the body succeeds, but leaves the review "without a body" again, and the next edit fails with the same error.
- `submitPullRequestReview` accepts `body` and uses it as the text on publication, even if the body was empty before.

The adapter therefore always creates a pending review with a nonempty body, a single placeholder line `<!-- sherpa:body -->` (GitHub doesn't render HTML comments), whether the draft is a line comment or a PR comment. A body containing only the placeholder produces no paragraphs and doesn't appear as a comment. The placeholder isn't written alongside paragraphs, so the same line in the reviewer's text remains their text. Deleting the last paragraph writes the placeholder instead of an empty string.

On publication, the final body goes in the submission's own `body` parameter. If there are paragraphs, it contains their text with markers. If there are none, it is an empty string, so the placeholder doesn't reach the published review. There is no separate `updatePullRequestReview` before submission, because neither option works. Leaving the placeholder would expose it in the published review, while replacing it with an empty string would break the review for a retry if submission failed.

An existing pending review with an empty body (started on GitHub's website or by an earlier Sherpa version) cannot be repaired. An attempt to add a paragraph asks the reviewer to submit or delete that review on GitHub. Line comments can still be added to it as usual.

## Cost per polling tick

GitHub GraphQL charges points for connection nodes rather than fields, with 5000 points per hour per user. A tick is one `SherpaPrTick` with `reviewThreads(first: 50)`, `reviews(last: 50)`, `comments(last: 50)`, and costs a few points (GitHub's formula sums the requested `first`/`last` values, divides by 100, and adds parent nodes). A 15 s polling interval gives about 240 ticks per hour. This fits within the limit with room to spare, but it is also why the interval is 15 s rather than a few seconds, and why polling pages are small.

Every **read** includes `rateLimit { cost remaining resetAt }`. Below 200 remaining points, the client waits until `resetAt` before its next request. A 403/429 with `x-ratelimit-remaining: 0` makes it wait until `x-ratelimit-reset` without spending retries on exponential backoff. A wait longer than 5 minutes returns `host_unavailable`, because telling the reviewer that the limit is exhausted is better than leaving them waiting without an explanation.

Mutations don't have this field and cannot have it. `rateLimit` exists only on the `Query` type, and GitHub rejects a request containing it in full: `Field 'rateLimit' doesn't exist on type 'Mutation'`, `data: null`, with no mutations executed (measured 2026-09-22). After a write, the next read provides the remaining quota, and polling already runs every 15 s.

## CODEOWNERS

GitHub looks for the ownership file in 3 locations and uses the first one it finds: `.github/CODEOWNERS`, `CODEOWNERS`, `docs/CODEOWNERS`. Sherpa reads it **from the PR's base branch** (`baseRefOid`) with one `repository.object(expression: "<commit>:<path>")` query using 3 aliases. GitHub determines ownership the same way, and reading the head instead would let a CODEOWNERS change inside a PR apply to that same PR.

The syntax is a subset of gitignore. Sherpa's parser leaves out syntax that GitHub itself rejects or that Sherpa won't try to guess: `!` negation, `[a-z]` classes, and an escaped hash. `{a,b}` is a literal, since CODEOWNERS has no alternatives. A line with such syntax is ignored in full. GitHub also marks it as an error and doesn't apply it.

For the remaining syntax, a pattern without `/` (or with only a trailing one) matches at any depth. A leading or internal `/` anchors it to the root. A trailing `/` matches only a directory and everything below it. `*` doesn't cross `/`, `?` matches one character other than `/`, and two stars match any number of directories, including zero. The **last** matching rule determines a file's owners, rather than all matching rules. A pattern without owners clears ownership assigned above it. `\r\n` line endings are accepted, and a leading BOM is stripped. Otherwise `\r` would stick to the owner's login and the byte order mark to the first pattern.

Owner teams (`@org/team`) aren't expanded in the file itself. A separate `organization(login: $org) { teams(first: 100, userLogins: [$viewer]) { nodes { slug } } }` query checks whether the reviewer belongs to a team, with one alias per organization. The query requires the **`read:org`** scope.

A missing scope produces no visible failure. A token without organization access receives `{"organization":{"teams":{"nodes":[]}}}`, an empty list with no error in `errors[]` and no `organization: null` (measured 2026-09-22). **This is an indistinguishable false negative:** a reviewer who belongs to an owner team silently sees "none of your files" with this token. Their `viewer.organizations` is empty too, so this response cannot distinguish "you aren't on the team" from "I can't see your teams". The planned reduced functionality (a `note` about `read:org`, with no caching of the result) still applies when GitHub does return an error or `organization: null`, but this rarely happens in practice.

## What GitHub cannot do

- **GitHub has no iterations.** It has no diff set that can be listed and compared, and reviews compare the branch head against the merge-base. The adapter therefore declares `capabilities.iterations: false`, returns one item in `listIterations` and rejects a slice request.
- **The file list stops at 3000.** `…/pulls/{n}/files` returns no more than 3000 files and silently truncates the list. The adapter fails with an explanation instead of showing an incomplete diff.
- **GitHub has no PR-level drafts.** All unpublished content belongs to a pending review: line comments and one review body. PR-level drafts are therefore body paragraphs with `<!-- sherpa:draft <n> -->` markers, and the body is never left empty (see above).
- **The review body cannot be deleted.** `updatePullRequestReview` rewrites it, but reviews have no deletion mutation. `deleteComment` rejects such a comment with a clear message.
- **GitHub has no idempotency keys.** Neither GraphQL nor REST accepts `Idempotency-Key`. The adapter checks host state itself before retrying creation after a network error.
- **GitHub has no sticky ship and no comment issue status.** A new review revokes approval, and GitHub expresses "requires a reply" only through thread resolution.
- **Only diff threads can be resolved.** Neither a review body nor an issue comment can be marked resolved.
- **PR authors can only use `COMMENT`.** GitHub rejects approval and change requests from the PR's author, and the live API returned `Review Can not approve your own pull request`. On the reviewer's own PR, `publishVerdicts` therefore contains only `comment`.

## Documented facts and assumptions

The schema documentation gives the names and types of all fields and mutations above, the `PullRequestReviewState`, `StatusState`, `DiffSide`, `PullRequestReviewThreadSubjectType`, `FileViewedState` enums, connection structure (`nodes`/`pageInfo`), REST file item fields (`filename`, `status`, `additions`, `deletions`, `patch`, `previous_filename`), and `merge_base_commit.sha`.

A run on a live PR (2026-09-22) verified PR metadata, including a fork branch (`owner:branch`), verdicts and aggregate check status. It also verified the diff, merge-base and patch text, a file with no patch but nonzero statistics, images and blob bytes, and context expansion. Diff threads covered multiline anchors, `resolved`, `isOutdated` with coordinates from `originalLine`/`originalStartLine`, bots, and issue comments. Other checks covered CODEOWNERS zones with teams, creating, editing and deleting line drafts, replying to and resolving threads, mirroring "viewed", publication failure (all drafts in `failed`, `verdictApplied: false`), and the web file-link anchor `#diff-<sha256 of path>`. The same run measured the points described above: `rateLimit` only on `Query`, pending review body mechanics, binary detection through `Blob.isBinary`, and an empty team list instead of an error when `read:org` is missing.

These points are assumed and still unverified on a live PR:

- `addPullRequestReviewThread` with `subjectType: FILE` and no lines creates a whole-file comment.
- The exact point cost of a tick has not been measured, although the formula is known.
- File-list truncation at 3000 is untested, because no PR of that size was available.
- `deletePullRequestReviewComment` on the first comment of a line discussion is assumed to remove the whole discussion, including other people's replies. The adapter therefore blocks this deletion while replies exist.
- GitHub reads CODEOWNERS from the base branch rather than the head. The documentation doesn't state this directly, so it needs testing on a live PR that changes CODEOWNERS.
- Two documentation examples need reconciling. `docs/*` matches only direct children, while `/apps/github` matches the directory and its contents. Sherpa infers that a pattern matches a directory and its contents only when its last segment is an exact name. GitHub doesn't state this rule anywhere.
