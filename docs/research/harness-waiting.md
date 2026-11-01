# Waiting for tasks in harnesses: the cost of an idle worker

> Research from 2026-09-25. Source code and documentation were examined for 5 harnesses (Claude Code, Codex, OpenCode, Cursor, pi), with a live measurement for Codex. The goal is for the `worker next` loop to use zero model turns while the reviewer is silent, using skill text rather than harness-specific adapters.

## Brief conclusion

Harnesses fall into 2 types. The first can run a command in the background and wake the model when it finishes (Claude Code, Cursor). The second has no background mode but can hold a blocking call indefinitely with an explicit timeout (OpenCode, pi). Codex formally belongs to the second type, but its system prompt requires blocking for no more than 60 s, and without instructions the model polls the process about every 25 s. A live measurement showed that harness-neutral wording, "set all tool timeouts to a day, don't poll", overrides this rule: 0 model requests over 10 minutes versus 23 without it. This only holds for gpt-5.6-sol, though. With the same wording, gpt-6-astra polls every 60 s (15 requests over 10 minutes). It reaches zero only with text that explicitly names the cell pragma and overrides the documented tool limits (repeat measurement below).

All 5 harnesses can therefore reach zero idle turns with one `SKILL.md` containing 2 branches based on harness capabilities. A task costs one turn when it arrives, almost always with a cold cache (a 5-minute TTL everywhere except Claude Code subscriptions, where it is an hour). A separate Codex handler isn't needed.

| Harness | Mechanism | Turns per idle hour | Obstacle |
|---|---|---|---|
| Claude Code 2.1.x | Bash `run_in_background`, a new turn on process exit | 0 | A foreground call moves to the background automatically after 120 s, costing an extra turn |
| Cursor 3.20 / CLI | Shell `block_until_ms: 0`, the agent wakes on process exit | 0 | The contract is undocumented, known from a leaked prompt and forum replies by the maintainers |
| OpenCode 1.18 | Foreground bash with an explicit `timeout`, no limit | 0 | Without an explicit timeout it kills the process after 120 s, about 30 wakeups per hour |
| pi 0.87 | Foreground bash without `timeout`, none by default | 0 | pi warms the cache with single-token requests, about 13 per hour, controlled by a user setting |
| Codex 0.156 | An `exec` cell with a day-long yield and an internal `write_stdin` loop | 0 with instructions, about 140 without | The system prompt says "don't block for longer than 60 s" |

## Claude Code

- Bash with `run_in_background: true` returns a task ID. On process exit, the harness queues a notification and starts a new turn itself if the session is idle. The main session's process survives the end of the turn. A foreground subagent's process dies with it. The duration limit was removed in 2.1.260, and the output limit is 5 GB.
- Foreground Bash defaults to 120 s, and the model can request up to 600 s (`BASH_DEFAULT_TIMEOUT_MS`, `BASH_MAX_TIMEOUT_MS`). A timeout moves the command to the background instead of killing it, which costs one extra turn. Start it in the background from the outset.
- A background process causes no periodic wakeups. Cache TTL is an hour with a subscription, 5 minutes with an API key (`CLAUDE_CODE_PROMPT_CACHE_TTL=1h` since 2.1.242).
- External push into a session: cross-session messages through a Unix socket (2.1.224+, undocumented format), Monitor with a deadline of up to 30 minutes, and the `asyncRewake` hook. None is needed here. Background execution with a wakeup covers the task.
- Skills: `~/.claude/skills/<name>/SKILL.md`, with symlink support. `/sherpa-review 12345` substitutes `$ARGUMENTS`.
- Traps: a background task that "looks like it is waiting for input" notifies the model after about 45 s, so `worker next` must stay silent while waiting. A skill's `allowed-tools` grant resets after the next user message, so the loop needs a permanent `Bash(node */sherpa-review.mjs *)` rule. Under memory pressure, background tasks are killed after 30 minutes of inactivity (before 2.1.274, even under mild pressure).

## Codex

- Process exit doesn't wake the model. `spawn_exit_watcher` sends an event only to the UI. Only subagent mail starts a turn while idle. Async hooks are picked up at turn boundaries, `notify` only sends outward, and `clock.sleep` is interrupted by user input, not by a process.
- The model runs in code mode (the model catalog sets `tool_mode: code_mode_only` for gpt-5.6 and gpt-6), so it sees only `exec` (a JS cell) and `wait`. JS calls `exec_command` and `write_stdin`. Limits: 30 s for `exec_command`, `background_terminal_max_timeout` = 300 s for an empty `write_stdin`, and no limit for the cell or `wait`.
- The system prompt for every model except gpt-5.5 says "Avoid performing blocking sleep or wait calls longer than 60 seconds" and "don't go longer than 60 s without commentary". This causes polling about every 25 s.
- A unified exec process survives the end of a turn. Closing the session or eviction from the 64 slots kills it. An empty poll doesn't return before its deadline when output appears, so heartbeat lines in `worker next` are useless.
- Skills: `~/.agents/skills`, `.agents/skills` from cwd to the repository root, and `$CODEX_HOME/skills`, with symlink support. Invocation: `$sherpa-review 12345`.
- Two alternatives guarantee zero turns and both require user configuration. A Stop hook with `{"decision":"block","reason":"<task>"}` holds the turn without a model call, with no hook timeout limit or retry limit, but needs one-time approval in `/hooks`. A shared app-server daemon (`codex app-server daemon start`, `thread/queue/add`) supports external push, but `daemon_auto_start` in 0.156.1 is experimental and disabled.

### Live measurement

`codex exec --json --approve-for-me`, gpt-5.6-sol, high reasoning effort, `sleep 600`, one run per variant. The counter is `token_usage_record` entries in the session rollout, each representing one model request.

| Variant | Requests over 10 minutes of waiting | Behaviour |
|---|---|---|
| A. No instructions | 23 | A 30 s cell, then alternating 50 s `write_stdin` and 50 s `wait` calls |
| B. Skill text: "set all timeouts to a day, don't poll" | 0 | One cell with `yield_time_ms: 86400000`, containing a loop of day-long `write_stdin` calls |
| C. B + `background_terminal_max_timeout=86400000` | 0 | Same as B, no configuration needed |
| D. An explicit JS snippet in the prompt | 0 | The cell executed the snippet as written |

In B, the internal `write_stdin` hit the 300-second limit twice, but a return inside the cell costs no turn because the cell's limit is a day. Raising the configuration limit and providing explicit JS aren't needed.

The cell the model wrote itself in variant B:

```js
// @exec: {"yield_time_ms": 86400000, "max_output_tokens": 1000}
const r = await tools.exec_command({cmd:"sleep 600",workdir:"/tmp/codex-exp",yield_time_ms:86400000,max_output_tokens:1000});
if (r.session_id !== undefined) {
  let current = r;
  while (current.session_id !== undefined) {
    current = await tools.write_stdin({session_id:current.session_id,chars:"",yield_time_ms:86400000,max_output_tokens:1000});
  }
  text(current.output);
} else {
  text(r.output);
}
```

The wording from variant B was copied almost verbatim into `packages/skill/SKILL.md` (now the `sherpa-review guide` text, `packages/cli/src/guide.ts`).

### Repeat measurement on gpt-6-astra (2026-09-29)

The trigger was an audit of 2 reviewer sessions on Codex Desktop 0.158 with gpt-6-astra. Polling a pending `worker next` every 60 s used 89–92% of session tokens, even though the model had read skill 0.9.1. Tool descriptions in 0.153.4, 0.156.1, and 0.158 are identical word for word. Only the model differs. The setup was the same as above: `codex exec --json`, high reasoning effort, `sleep 600`, one run per variant.

| Variant | Requests over 10 minutes | Behaviour |
|---|---|---|
| E. The "no background support" branch from SKILL.md 0.9.1 verbatim | 17 (15 while idle) | Day-long `exec_command` and `write_stdin` timeouts, but no cell pragma. The cell returned after 30 s, followed by 60 s `wait` calls. After 5 minutes, `write_stdin` hit the 300 s limit and the loop restarted |
| F. The same branch with the cell pragma, a loop inside the script, and a note about documented ranges | 3 (0 while idle) | A cell like variant B above, one call before process exit |

Sol works out the pragma on its own. Astra takes "effective range 250-30000" from the tool description and the system prompt's 60 s rule literally. Wording F was copied into `SKILL.md`. Zero idle turns depend on it.

Measurement limits: one run per variant, 10 minutes, headless mode. In the TUI, user messages queue until the pending call returns. Esc interrupts it.

## OpenCode

- Bash has no background mode (`run_in_background` in PR #33310 hasn't been merged). Background subagents through `task` with `background: true` exist behind an experimental flag, but a subagent runs its own model loop and costs more than a blocking call.
- Foreground bash defaults to 120 s (`OPENCODE_EXPERIMENTAL_BASH_DEFAULT_TIMEOUT_MS`). `timeout` has no limit, and a value above 2³¹−1 ms is equivalent to no timeout. A timeout kills the process and returns the tail of its output to the model with advice to retry with a longer timeout. There is no "kill when silent" heuristic.
- The call waits for stdio to close, not for process exit (#47350, #49169). A daemon that inherits the tool's stdout will hang the call forever. Sherpa's `up` spawns the server with `detached`, stdio directed to a log file, and `unref`, so this doesn't affect it.
- External push: the TUI doesn't open a port by default. The server runs in a worker thread with in-process RPC. `--port` enables `POST /session/:id/prompt_async`. A plugin with an `event` hook could push tasks, but that requires code.
- Skills: `.opencode/skills`, `~/.config/opencode/skills`, `.claude/skills`, `~/.claude/skills`, `.agents/skills`, `~/.agents/skills`, with symlink support. A skill also registers as a slash command with `$ARGUMENTS`. Trap: in slash-command form, `` !`cmd` `` in SKILL.md executes.
- Cache: Anthropic uses 5 minutes through `cacheControl: ephemeral`. An hour-long TTL requires model configuration. Compaction doesn't run while idle.

## Cursor

- IDE: the Shell tool has `block_until_ms` (30 000 by default), after which the command moves to the background. `0` sends it there immediately. The agent wakes once when a background command finishes, and completions are batched. `AwaitShell(shell_id, block_until_ms)` waits without turns. One call was observed lasting 119 minutes.
- All of this is known from a leaked system prompt and forum replies by the maintainers (thread 172103, 2026-09-18), with nothing in the documentation. The contract changed several times in 2026, and some models don't see the parameter. Known bugs include extra wakeups when foreground commands move to the background, and zombie shells.
- CLI: the 2026-08-11 changelog restores follow-up on background task completion in interactive and headless modes. Whether the CLI has `block_until_ms` is unverified.
- External push: a deep link only fills in the prompt. `agent acp` provides JSON-RPC `session/prompt`, but this needs a driver, which means code. A Stop hook can return `followup_message`, with `loop_limit` defaulting to 5.
- Skills: `.cursor/skills`, `~/.cursor/skills`, `.agents/skills`, `~/.agents/skills`, plus `.claude/skills` and `.codex/skills`, with symlink support. `/sherpa-review` in chat attaches the skill to the message.
- The sandbox restricts network access by default. Loopback availability is unverified. The workaround is to allowlist the `node` command.

## pi

- The repository moved to `earendil-works/pi`, package `@earendil-works/pi-coding-agent`, version 0.87.1 from 2026-09-22.
- There is no background mode, and process exit doesn't wake the model. Foreground bash has no timeout by default. The model can optionally set `timeout` in seconds, with a 2³¹−1 ms limit. A timeout kills the process tree. One blocking call can wait for hours without turns.
- External push is available only through an extension (`pi.sendUserMessage`). RPC mode controls only its own pi process. A skill cannot install an extension.
- Skills: `~/.pi/agent/skills`, `.pi/skills`, `~/.agents/skills`, `.agents/skills`, with symlink support. `/skill:sherpa-review 12345` adds arguments to the instruction.
- Cache warming is enabled by default (`cacheWarming: "streaming"`). During a pending call, pi repeats the last request with `maxTokens: 1` at 90 % of the cache lifetime, about 13 times per hour with a 5-minute cache, once with `PI_CACHE_RETENTION=long`, and stops after an hour. These are provider requests without reasoning, and only a user setting can disable them.
- User messages during a pending call queue until it returns. Esc kills `worker next`.

## Sources

Claude Code: code.claude.com/docs (tools-reference, headless, hooks, prompt-caching, skills, cross-session-messaging), CHANGELOG in anthropics/claude-code. Codex: openai/codex `codex-rs` on main as of 2026-09-25 (`core/src/unified_exec`, `core/src/tools/code_mode`, `hooks/src/engine`, `core/src/tasks`), developers.openai.com/codex/config-reference, strings from binary 0.156.1, measurement in `/tmp/codex-exp`. OpenCode: anomalyco/opencode 1.18.32 (`src/tool/shell.ts`, `src/skill`, `src/server`), issues #33310, #47350, #49169. Cursor: cursor.com/docs (hooks, skills, cli/changelog, cli/acp, run-modes), forum threads 172103, 169972, 169556, 170977, leaked prompt in asgeirtj/system_prompts_leaks. pi: earendil-works/pi `packages/coding-agent` (`core/tools/bash.ts`, `core/cache-warmer.ts`, `core/skills.ts`, docs).
