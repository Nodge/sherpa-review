# UI glossary

The glossary fixes one English term for each concept of Sherpa, so a translation of the UI into a new language starts from one name per thing. The strings themselves live in `packages/ui/src/i18n/en.ts`. This page says what each term means and which neighbouring term it must not be confused with.

| Term | Meaning |
|---|---|
| Sherpa | Product name, `app.name`. |
| AI-assisted code review | The reviewer uses their own agent. |
| code review | Use review when the context is clear. |
| reviewer | The person reading and deciding. |
| PR author | Keep separate from the reviewer. |
| pull request | PR after the first mention. |
| route | Ordered stops over the real diff, `view.route`. |
| stop | Route unit, never a workflow step. |
| route skeleton | The accepted plan before the stops are filled. |
| route plan | Fixes stop titles, numbers and order. |
| route section | Use section for the task or schema unit, stop for the visible unit. |
| narrative | The explanatory text beside a stop's diff. |
| reading order | The route controls this order. |
| heart of the change | Match the onboarding wording. |
| consequence | What the change affects. |
| wiring | Supporting code around the main change. |
| explanation | Keep separate from a summary. |
| summary | `overview.summary` uses Summary. |
| Other | Synthetic final stop for ranges left without a stop. |
| not explained | `coverage.tier.other`, never unimportant. |
| not placed | The model has not assigned the ranges to a stop. |
| place the ranges | Assign ranges to route stops. |
| importance tier | Values stay `high`, `medium`, `low`. |
| high tier | Keep a literal `high` unchanged. |
| medium tier | Keep a literal `medium` unchanged. |
| low tier | `route.collapsed.reason.low`. |
| Triage | Importance order, `route.preset.triage`. |
| Full tour | Reading order, `route.preset.tour`. |
| preset | Route ordering choice. |
| diff coverage | Coverage of changed ranges by stops. |
| uncovered range | A range left without a route stop. |
| hatch | Marks ranges without a route stop. |
| fold | The visible collapsed block with its count. |
| collapse | Use collapsed for state. |
| expand | Use expanded for state. |
| collapsed by hand | `diff.file.collapsed.manual`. |
| context expansion | Reveals hidden unchanged lines. |
| hidden lines | Lines available through expansion. |
| unchanged lines | Distinguish from lines explained in another stop. |
| changed lines | Used for coverage and reading counts. |
| snapshot | Immutable route version tied to a commit and iteration. |
| iteration | A host diff version or recorded working-tree state. |
| active iteration | The iteration that accepts changes. |
| previous iteration | Read-only historical state. |
| current iteration | The iteration currently described by the source. |
| slice | Diff between two iterations, `iteration.status.slice`. |
| interdiff | Technical name for the difference between iterations. |
| what is new | Changes since the previous pass. |
| pass | A reviewer's reading pass. |
| second pass | `iteration.secondPass`. |
| progress carryover | Carry viewed marks between iterations. |
| carry over the marks | Preserve marks for unchanged ranges. |
| stale route | Built for an older commit. |
| outdated thread | `overview.discussion.state.outdated`. |
| read-only | `iteration.readOnly.aria`. |
| provenance | Model, commit, language and generation details. |
| content hash | Identifies snapshot contents. |
| anchor | A reference to a file and line range. |
| anchor lost | The referenced code no longer exists in the iteration. |
| pinned to a commit | The thread keeps its old commit. |
| line range | A stop can cover part of a file. |
| diff side | Preserve the `old` and `new` tokens. |
| old side | Deleted or pre-change content. |
| new side | Added or post-change content. |
| base commit | The comparison base. |
| branch head | Use head for the selected revision. |
| push | A remote update, distinct from a local iteration. |
| force-push | May remove commits from PR history. |
| commit | Preserve hashes. |
| branch | Preserve neutral branch names. |
| working tree | Local checkout contents. |
| checkout | A local repository checkout. |
| untracked file | A file absent from version control. |
| index | Git staging index when the source means staging. |
| staged changes | Changes in the index. |
| unstaged changes | Working-tree changes outside the index. |
| rebase | Preserve commands and options. |
| merge | Use merge conflict for a conflict caused by merging. |
| merge conflict | `file.conflict` uses conflict. |
| tree history | Recorded local iterations. |
| diff | The actual code changes. |
| Full diff | Tab label, `view.diff`. Lowercase in running prose. |
| raw diff | Diff read without route explanations. |
| patch | Serialized diff text. |
| hunk | A patch block. |
| line | Source or diff line. Use row for a UI layout row. |
| line number | Preserve the original number. |
| addition | Added line or file, according to context. |
| deletion | Removed line or file. |
| rename | File operation. |
| move | File operation, distinct from rename if the source distinguishes them. |
| binary file | `diff.notice.binary`. |
| text changes | `diff.notice.noText`. |
| generated file | `diff.file.collapsed.generated`, never machine file. Counts as read by default where specified. |
| whitespace changes | Use whitespace only for the UI state. |
| syntax highlighting | Keep language identifiers unchanged. |
| word-level highlighting | Changed spans inside a line. |
| unified | Diff mode, `toolbar.mode.unified`. |
| side by side | Diff mode, `toolbar.mode.split`. |
| two layouts | Shared review state with different reading orders. |
| reader | The working diff interface without the agent. |
| diff viewer | The component that renders code changes. |
| outline | Hunk navigation for a file. |
| file tree | `tree.rows.aria`. |
| file card | The visible diff block for a file. |
| file chip | Compact file link in a stop. |
| diff margin | Location of route markers and notes. |
| viewed | Explicit mark, `viewed.on`. |
| Mark viewed | `viewed.off`. |
| Clear the mark | `file.menu.unmarkViewed`. |
| unviewed | `shortcut.diff.nextUnread`. |
| seen | Automatic visibility count, distinct from explicit viewed marks. |
| read | Use read where the source counts reading. |
| reading progress | Per-user reading state. |
| route progress | Keep navigation position separate from viewed marks. |
| counter | A numeric indicator. |
| lens | A filter or view over review data. |
| ownership lens | Shows the reviewer's files. |
| ownership zone | `overview.ownership.title`. |
| ownership rules | Rules supplied by the host. |
| My files | `lens.mine`. |
| All files | `lens.all`. |
| files outside your ownership zone | Use other in the compact ownership chip. |
| audit lens | Host-provided audit filter. |
| audit scope | The files requiring audit sign-off. |
| auditor sign-off | `audit.note`. |
| author lens | `overview.discussion.lens.clear`. |
| filter | Keep distinct from the selected route preset. |
| verdict | The reviewer's decision. |
| ship | Approval action. Ship as the button label. Approve the reviewed snapshot. |
| sticky ship | Host approval that carries over to later pushes. |
| approval | State produced by ship. |
| Request changes | Review action, `shortcut.review.requestChanges`. |
| request changes | Do not call this rejection. |
| Changes requested | `complete.verdict.requestChanges`. |
| publishing without a verdict | Comment mode. |
| finish the review | Publishes accumulated drafts with the chosen action. |
| publish comments | Requires the reviewer's action. |
| comment batch | Drafts published together. |
| publish as one batch | Preserve partial-failure behaviour in the sentence. |
| draft | Stored before publication. |
| unpublished comment | A draft awaiting publication. |
| unsaved text | Text that has not reached draft storage. |
| buffered draft | Waiting for a connection or retry. |
| comment | Human or bot comment from the host. |
| line comment | A comment anchored to code. |
| file comment | A comment on the whole file. |
| PR comment | A comment on the whole pull request. |
| thread | A host discussion attached to code or the PR. |
| thread reply | `thread.reply.label`. |
| resolve the thread | Host resolution state. |
| reopen the thread | `thread.reopen`. |
| resolved thread | Use the host's state, even if no fix was made. |
| open thread | An unresolved discussion. |
| composer | Technical component name. Use comment editor in reviewer instructions. |
| comment editor | The input area a reviewer sees. |
| Agent note | `note.label`, lowercase in prose. |
| agent note | A model answer pinned to code. |
| model answer | Provenance wording from `note.provenance`. |
| Turn into a comment draft | `note.toDraft`. |
| AI review comment | An existing bot comment, not a new finding by Sherpa. |
| review bot | Preserve the bot source label after name replacement. |
| source label | Shows a bot comment's origin. |
| finding | An issue detected during review. |
| blocking comment | A remark that must be addressed before approval. |
| Discussion | Overview card, `overview.discussion`. |
| participant | A person or bot in the discussion. |
| Behavioural test digest | Exact `digest.aria` wording and spelling. |
| digest | `digest.title` uses Behavioural digest. |
| assertion | A behaviour claim tied to a test. A test assertion in code. |
| test case | Keep test code and its anchored assertion distinct. |
| weakened assertion | A review signal in the digest. |
| uncovered | Behaviour without an assertion, `digest.kind.uncovered`. |
| contract | A schema, interface or promised behaviour, according to context. |
| contract test | Checks the host or protocol contract. |
| test suite | Preserve test command names. |
| edge case | `chat.example.edgeCases`. |
| regression | Previously working behaviour that broke. |
| fixture | Deterministic review data. |
| mock | A substituted dependency or response. |
| substitution | Use mock when the source means a test double. |
| state gallery | Fixture-backed examples of UI states. |
| design token | Values shared by styles and design docs. |
| prototype | Design reference, not source code. |
| reference | The expected design or behaviour. |
| dark theme | `settings.theme.dark`. |
| light theme | `settings.theme.light`. |
| Command palette | `palette.title`. |
| colour palette | Keep distinct from the command palette. |
| Keyboard shortcuts | `help.cheatsheet.title`. |
| shortcuts sheet | `help.cheatsheet.close`. |
| onboarding | The first-visit tour. |
| onboarding tour | Eight steps where the source specifies eight. |
| tour step | Never a route stop. |
| Overview | Tab label, `view.overview`. |
| tab | Browser or view tab, according to context. |
| header | File, PR or panel header. |
| banner | Persistent notice in the review interface. |
| toast | Brief update notice. |
| panel | A visible UI region. |
| selection | Selected lines or text. |
| context menu | Actions for a file or selection. |
| link | Keep neutral targets and fragments unchanged. |
| clipboard | `selection.clipboardUnavailable`. |
| Swipe | Image comparison mode, `image.mode.swipe`. |
| Onion Skin | Image comparison mode, `image.mode.onion`. |
| Diff | Image comparison mode, `image.mode.diff`. |
| Before / After | Image side labels. |
| Fit | Image scale option. |
| review host | Adapter boundary, not the worker's machine. |
| host adapter | Implements `ReviewHost`. |
| host capabilities | Preserve `HostCapabilities` and its fields. |
| composition root | Where host plugins are registered. |
| plugin | An adapter or channel registered through composition. |
| local review | Review of working-tree changes against a base. |
| local server | Runs on the reviewer's machine. |
| server | Preserve the process boundary. |
| agent | The reviewer's AI agent. |
| worker | Agent session that pulls tasks from the server. |
| diff worker | Browser worker that parses the diff. |
| harness | The application running the agent session. |
| session | Agent or UI session, according to context. |
| task loop | Worker polling and task execution. |
| task queue | The server's pending AI work. |
| task | Worker work item. Use issue for a feedback ticket. A concrete item from the worker queue. |
| task lease | Exclusive right to execute a claimed task. |
| liveness | Whether the worker is still responding. |
| heartbeat | Worker liveness signal. |
| Agent disconnected | `agent.disconnected`. |
| reconnection | Rejoin an existing review session. |
| endpoint | HTTP API endpoint. |
| request | HTTP, task or user request, according to context. |
| server response | Must pass schema validation. |
| data schema | Use schema for validation, workflow for a process. |
| validator | Enforces the schema and coverage rules. |
| validation | Reject malformed results where the source requires it. |
| fail closed | Invalid task results never reach the UI. |
| generation | Agent production of the route or answer. |
| filling | Filling a planned stop, `route.stop.fill`. |
| rebuild | Build a new route while the old one stays available. |
| regeneration | `route.regenerate.action` uses Regenerate. |
| cancellation | Preserve the task lease behaviour after cancellation. |
| retry | An explicit retry or retry loop, according to context. |
| task failure | State the actual failure in errors and tests. |
| context budget | Limit on agent input. |
| partial diff | Some files did not fit the generation input. |
| polling | Periodic reads from the host. |
| event | Preserve event names. |
| revision | A version counter or source revision. |
| state | UI, server or persisted state. |
| store | The state container, not a retail shop. |
| storage | Persisted data. Use database when the source specifies one. |
| record | Use write for the operation. |
| key | Preserve neutral key formats. |
| field | A schema or object field. |
| request body | Preserve placeholders and escapes. |
| manifest | A structured file describing a running server or release. |
| access token | Keep bearer and OAuth distinctions. |
| feedback channel | Creates a product issue. |
| feedback | Distinguish product feedback from review comments. |
| issue | `feedback.ticket` uses Issue created. |
| update channel | Supplies release metadata. |
| release | A published distribution version. |
| distribution | Skill files and bundled executables. |
| bundle | Built CLI or server executable. |
| build | Command or artifact, according to context. |
| runtime dependency | The CLI and server bundle these dependencies. |
| monorepo | The pnpm workspace or sample repository. |
| repository root | A directory path. |
| path | File or URL path, according to context. |
| directory | Use directory in prose. |
| entry point | Module or first step in the reading order. |
| source of truth | Code or host state, as specified by the source. |
| invariant | A condition the implementation must preserve. |
| threshold | Preserve its numeric value and unit. |
| limit | A maximum count, size or time. |
| feature flag | Preserve flag identifiers. |
| rollout | A staged deployment. |
| rollback | Use fallback when the source means a change of method. |
| fallback | The alternative used when the main path is unavailable. |
| reduced functionality | State which functions remain available. |
| backward compatibility | Preserve protocol version constraints. |
| virtualization | Render only the visible part of a large diff. |
| text truncation | Keep distinct from a partial generation input. |
| line wrapping | Long code lines wrap in the viewer. |
| indentation | Preserve leading whitespace during translation. |
