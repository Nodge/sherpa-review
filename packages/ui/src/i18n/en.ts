import { formatCount, plural } from './format.js';
import type { Dictionary } from './ru.js';

/**
 * English dictionary. Element labels follow the handoff (`SPEC-elements.md`) wherever it
 * names them: the spec is the English original of the product, not a translation from Russian.
 */

const num = (value: number): string => formatCount(value, 'en');
/** English plural forms: `one` and everything else. */
const form = (value: number, one: string, other: string): string => plural(value, { one, other }, 'en');

export const en: Dictionary = {
    'app.name': 'Sherpa',
    'app.stopped': 'Sherpa stopped',
    'app.connecting': 'Connecting to the server…',
    'app.reconnecting': 'Server unavailable, reconnecting…',
    'app.reconnecting.text': 'This is the last known state. It refreshes itself as soon as the connection is back.',
    'app.noToken.text': 'Open the UI with the link printed by the Sherpa skill or server — it carries the token.',
    'app.noToken.hint': 'http://127.0.0.1:<port>/#t=<token>',
    'app.closeChat': 'Close chat',

    

    'command.hint': 'Run it in any harness — that session becomes the worker.',
    'command.copy': 'Copy',
    'command.copied': 'Copied',
    'command.copied.status': 'Command copied',
    'command.manual': 'The command is selected — copy it manually',
    'command.aria': 'Sherpa launch command',

    'topbar.breadcrumb': 'Pull request',
    'topbar.search': 'Search',
    'topbar.agent.disconnected': 'Agent disconnected. The reader keeps working in full.',
    'topbar.agent.connect': 'Connect the agent',
    'topbar.agent.offline':
        'The reader works in full — diff, search, comments and ship are available. The AI areas stay read-only.',
    'topbar.update': (latest: string) => `Version ${latest} is available`,

    'update.kicker': 'Update',
    'update.title': (latest: string) => `Sherpa ${latest} is available`,
    'update.current': (current: string) => `you have ${current}`,
    'update.how': 'How to update',
    'update.later': 'Later',
    'update.dismiss': (latest: string) => `Don’t remind me about ${latest}`,
    'update.command.aria': 'Update command',
    'update.copyDir': (dir: string) => `Copy the directory again: ${dir}`,
    'update.readme': 'Installation guide',
    'update.status.none': (current: string) => `No updates — ${current} is the latest`,
    'update.status.available': (latest: string) => `${latest} is available`,
    'update.status.failed': 'Could not check for updates',

    'view.overview': 'Overview',
    'view.route': 'Route',
    'view.diff': 'Full diff',
    'view.tabs': 'Views',

    'route.invitation.title': 'No route for this PR yet',
    'route.invitation.text':
        'Run the skill in your harness to build one. The full diff is already available and does not wait for the agent.',
    'route.readFullDiff': 'Read the full diff',
    'route.toFullDiff': 'To the full diff',
    'route.iteration.title': 'No route for this iteration',
    'route.iteration.text': 'The route is built for the active iteration; this one is read-only.',
    'route.iteration.textCommit': (commit: string) =>
        `The route is built for the active iteration; iteration ${commit} is read-only.`,
    'route.slice.title': 'No route for a slice',
    'route.slice.text': 'A route is not built for a slice between iterations — it is “what’s new” without AI.',
    'route.smallPr.title': 'Small PR — no route needed',
    'route.smallPr.text':
        'The change is below the threshold where a route pays off: a couple of files read faster than the agent builds a plan. The server never queued the generation — no queue, no waiting.',
    'route.smallPr.notGenerated': 'This PR is below the route threshold — generation does not start.',

    'overview.slice.title': 'No overview for a slice',
    'overview.slice.text': (baseCommit: string, headCommit: string) =>
        `Ownership zones, discussions and reading progress are counted on the active iteration. The ${baseCommit} → ${headCommit} slice is only “what’s new” in the code.`,
    'overview.summary': 'Summary',
    'overview.summary.loading': 'The PR summary is being prepared',
    'overview.summary.failed.lead': 'Summary unavailable.',
    'overview.summary.failed.text':
        'It arrives with the route skeleton, and the generation never got there. The full diff is unaffected.',
    'overview.summary.smallPr.lead': 'Small PR — no route needed.',
    'overview.summary.smallPr.text':
        'The change is below the threshold where a route pays off: the agent never ran, so there is no summary.',
    'overview.summary.noRoute.lead': 'No route yet.',
    'overview.summary.noRoute.text': 'Run the skill so the agent builds the route and the PR summary.',
    'overview.ownership.title': 'Files by ownership zone',
    'overview.ownership.segments': 'Files by ownership zone',
    'overview.ownership.stats': (mineFiles: number, totalFiles: number, mineLines: number, totalLines: number) =>
        `CODEOWNERS · ${num(mineFiles)} of ${num(totalFiles)} files · ${num(mineLines)} of ${num(totalLines)} lines are yours`,
    'overview.ownership.statsUnavailable': 'CODEOWNERS · ownership zone unavailable',
    'overview.ownership.mine': (files: number) => `My files ${num(files)}`,
    'overview.ownership.all': (files: number) => `All ${num(files)}`,
    'overview.ownership.noZone': 'The host returned no ownership zone for this PR.',
    'overview.ownership.noHost': 'This PR has no review host, so the ownership zone is unavailable.',
    'overview.ownership.loading': 'Ownership zone is loading…',
    'overview.ownership.chip.mine': 'you',
    'overview.ownership.chip.mineOwner': (owner: string) => `you · ${owner}`,
    'overview.ownership.chip.other': 'other',
    'overview.ownership.chip.generated': 'generated',
    'overview.ownership.chip.mixed': 'mixed',
    'overview.ownership.rowStats': (files: number, lines: number) =>
        `${num(files)} ${form(files, 'file', 'files')} · ${num(lines)} ${form(lines, 'line', 'lines')}`,
    'overview.diff.loading': 'Diff is loading…',
    'overview.diff.unavailable': 'Diff unavailable — files cannot be aggregated yet.',
    'overview.discussion': 'Discussion',
    'overview.discussion.loading': 'Discussions are loading…',
    'overview.discussion.empty': 'No discussions.',
    'overview.discussion.open': 'open',
    'overview.discussion.resolved': 'resolved',
    'overview.discussion.bots': 'from bots',
    'overview.discussion.noOutside': 'No threads on the PR itself or outside the diff.',
    'overview.snapshots': 'Snapshots',

    'palette.title': 'Command palette',
    'palette.placeholder': 'Command, file, /search or :line',
    'palette.placeholder.files': 'File…',
    'palette.group.commands': 'Commands',
    'palette.group.files': 'Files',
    'palette.group.jump': 'Jump',
    'palette.group.recent': 'Recent',
    'palette.group.search': 'Search',
    'palette.group.sherpa': 'Sherpa',
    'palette.group.suggested': 'Suggested',
    'palette.recent.empty': 'No recent commands yet',
    'palette.results': 'Palette results',
    'palette.results.count': (count: number) => `${num(count)} ${form(count, 'result', 'results')}`,
    'palette.notice.nothing': 'Nothing matches',
    'palette.notice.nothingFor': (query: string) => `Nothing matches “${query}”`,
    'palette.notice.openFile': 'Open a file first',
    'palette.notice.lineNumber': 'Type a line number after the colon',
    'palette.notice.lineMissing': (line: number, path: string) => `There is no line ${num(line)} in ${path}`,
    'palette.notice.diffLoading': 'The diff is still loading',
    'palette.notice.diffFailed': (error: string) => `Could not load the diff: ${error}`,
    'palette.notice.searchText': 'Type text after /',
    'palette.goToLine': (line: number) => `Go to line ${num(line)}`,
    'palette.truncated': (limit: number) => `Showing the first ${num(limit)} matches`,

    'banner.slot': 'Review status notices',
    'banner.slot.more': (count: number) => `+${num(count)} ${form(count, 'notice', 'notices')}`,

    'ship.progress': (seen: number, total: number) => `${num(seen)} / ${num(total)} files`,
    'ship.loading.files': 'files',
    'ship.loading.filesAria': 'File counter is loading',
    'ship.loading.comments': 'comments are loading',
    'ship.loading.reason': 'The diff and the review data are still loading.',
    'ship.diffFailed': 'diff failed to load',
    'ship.diffFailed.reason': (error: string) => `Diff failed to load: ${error}`,
    'ship.prComment': 'Comment on the PR',
    'ship.chooseMode': 'Choose the ship mode',
    'ship.menu': 'Ship mode',
    'ship.noDrafts': 'no unpublished comments',
    'ship.drafts': (drafts: number) =>
        `${num(drafts)} ${form(drafts, 'draft goes', 'drafts go')} out on ship`,
    'ship.drafts.pinned': (drafts: number) =>
        `· ${num(drafts)} ${form(drafts, 'is', 'are')} pinned to earlier commits`,
    'ship.publishing': 'Publishing…',
    'ship.guard.stops': (stops: number) =>
        `${num(stops)} ${form(stops, 'stop', 'stops')} not viewed — ship anyway?`,
    'ship.guard.files': (files: number) =>
        `${num(files)} ${form(files, 'file', 'files')} not viewed — ship anyway?`,
    'ship.mode.ship': 'Ship',
    'ship.mode.sticky': 'Sticky ship',
    'ship.mode.ship.description': 'Approves this snapshot only. A new push drops the approval and asks again.',
    'ship.mode.sticky.description': 'The approval carries over to later pushes — the host’s own sticky ship.',
    'ship.mode.sticky.unavailable': 'This host does not support Sticky ship.',
    'ship.option.publishes': (drafts: number) => `Publishes ${num(drafts)} ${form(drafts, 'draft', 'drafts')}.`,
    'ship.consequence.ship': (drafts: number) =>
        `Publishes ${num(drafts)} ${form(drafts, 'draft', 'drafts')} and approves the snapshot`,
    'ship.consequence.requestChanges': (drafts: number) =>
        `Publishes ${num(drafts)} ${form(drafts, 'draft', 'drafts')} and requests changes`,
    'ship.disabled.publishing': 'publishing…',
    'ship.disabled.offline': 'no connection to the server',
    'ship.disabled.pending': 'there is unsaved text',
    'ship.disabled.retry': 'retry the previous publication first',
    'ship.error.failed': 'Could not finish the review',
    'ship.error.comments': (count: number) =>
        `${num(count)} ${form(count, 'comment', 'comments')} failed to publish`,
    'ship.error.retry': 'retry',
    'ship.error.comment': (commentId: string) => `Comment ${commentId}`,
    'ship.error.verdict': 'The host did not apply the verdict.',

    'shortcut.view.overview': 'View “Overview”',
    'shortcut.view.route': 'View “Route”',
    'shortcut.view.diff': 'View “Full diff”',
    'shortcut.palette.open': 'Open the command palette',
    'shortcut.palette.goToFile': 'Go to file',
    'shortcut.palette.searchDiff': 'Search the diff contents',
    'shortcut.diff.toggleMode': 'Toggle the diff mode',
    'shortcut.diff.markViewed': 'Mark the file viewed',
    'shortcut.diff.filterFiles': 'Filter files in the tree',
    'shortcut.thread.commentLine': 'Comment on the line under the cursor',
    'shortcut.thread.reply': 'Reply in the thread under the cursor',
    'shortcut.review.shipMenu': 'Open the ship menu',
    'shortcut.review.requestChanges': 'Request changes',
    'shortcut.route.stop': (stop: string) => `Go to stop ${stop}`,
    'shortcut.route.toggleStopViewed': 'Mark the stop viewed',
    'shortcut.route.toggleStopCollapse': 'Collapse or expand the stop',
    'shortcut.route.togglePreset': 'Toggle the preset (triage / full tour)',
    'shortcut.route.preset.tour': 'reorders the stops into reading order',
    'shortcut.route.preset.triage': 'restores the triage order',
    'shortcut.route.generate': 'Build the route',
    'shortcut.route.regenerate': 'Regenerate the route',
    'shortcut.route.generate.consequence': 'clears the stop marks once the new route arrives',
    'shortcut.update.check': 'Check for updates',
    'shortcut.update.check.consequence': 'checks for a new release',
    'shortcut.locale.ru': 'Interface language: Russian',
    'shortcut.locale.en': 'Interface language: English',
    'shortcut.locale.auto': 'Language: auto (from the agent or the browser)',
    'shortcut.locale.now.ru': 'now: Russian',
    'shortcut.locale.now.en': 'now: English',
    'shortcut.locale.now.agentRu': 'now: Russian (from the agent)',
    'shortcut.locale.now.agentEn': 'now: English (from the agent)',
    'shortcut.locale.now.browserRu': 'now: Russian (matching the browser)',
    'shortcut.locale.now.browserEn': 'now: English (matching the browser)',

    'time.justNow': 'just now',
};
