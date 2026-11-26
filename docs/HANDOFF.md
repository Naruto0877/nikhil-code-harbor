# Crash handoff for Claude Code

Claude Code can already resume and rewind conversations. After a crash it does not tell you what changed in the working tree or which checks actually finished. `harbor handoff` records that through [Claude Code hooks](https://code.claude.com/docs/en/hooks). It is opt-in and works without the Harbor gateway running.

## Install

```sh
node bin/harbor.mjs handoff install
```

This prints a `hooks` block. Merge it into `.claude/settings.local.json` (one project) or `~/.claude/settings.json` (all projects). Harbor never edits Claude Code settings itself. The hooks used are `SessionStart`, `PreToolUse` (Bash), `PostToolUse` (Bash, Edit, Write, MultiEdit, NotebookEdit), `PostToolUseFailure` (Bash), `Stop` and `SessionEnd`. Every hook exits 0, so a handoff problem never blocks a session.

Optionally record what the session is for:

```sh
node bin/harbor.mjs handoff task --summary "Fix rounding in invoice totals"
```

## What is recorded

One record **per Claude Code session**, stored under `handoff/<worktree>/<session>.json` in the state directory and written atomically (temporary file + rename, owner-only) after each meaningful event. Each hook updates only its own session's record, so two sessions in the same worktree do not overwrite or end each other. Records written by the earlier single-record layout are still readable. A record holds:

- your task summary
- worktree path, Git common directory, branch, and the starting `HEAD`
- files **already modified when the session started**, with status code and SHA-256 hash
- files observed changing during the session (from Edit/Write tools and from `git status` rescans), plus files changed by commits made during the session
- test commands (`npm test`, `node --test`, `pytest`, `go test`, `cargo test`, and so on) with start and finish times and outcome. Each finish event is matched to its start by `tool_use_id`. If an ID is supplied but matches nothing, no test is updated. Without an ID, a finish event is matched only when exactly one identical command is pending. `passed` requires an explicit exit status of 0. An explicit nonzero status (for example `Exit code 1` in `PostToolUseFailure`) is `failed`. A missing exit status stays **outcome unknown**. Commands are redacted: `VAR=value` assignments, `--token`/`--key` style arguments, bearer credentials and long opaque strings become `***`.

Never recorded: file contents, prompts, transcripts, reasoning, tool output.

## Recovery

```sh
node bin/harbor.mjs handoff show                 # the most recently updated session in this worktree
node bin/harbor.mjs handoff show --session ID     # a specific session
node bin/harbor.mjs handoff show --previous       # newest unfinished session other than the latest
node bin/harbor.mjs handoff show --json
```

The view compares the record with the working tree as it is now:

- **Already modified before the session started**: still unchanged, changed again, committed, or no longer modified.
- **Changed during the session**: whether each file still matches the last recorded state or changed afterwards.
- **Modified but not seen by any hook**: dirty files the record never observed.
- **Checks**: a test that started but never recorded an exit status is shown as **outcome unknown**. Rerun it.
- **Still needs inspection**: a combined to-do list.

The view names the session it shows and lists the other recorded sessions in the worktree. `show` is read-only. It runs `git status` with `GIT_OPTIONAL_LOCKS=0` and hashes files, and it never writes to the worktree. When a session starts while other sessions in the worktree have not ended cleanly, a one-line notice lists their IDs.

## Limits

- Outcomes depend on Claude Code's hook payloads. A non-zero Bash exit arrives through `PostToolUseFailure` with `Exit code N`. Claude Code's documented `PostToolUse` Bash response has no exit-status field, so a test that succeeded is shown as **outcome unknown** (finished, no exit status), not `passed`. Checked with Claude Code 2.1.332: its Bash `PostToolUse` response has `stdout`, `stderr`, `interrupted`, `isImage` and `noOutputExpected`, but no exit status. A failing run arrived as `PostToolUseFailure` with `Exit code 1` and was recorded as `failed`.
- Sessions that share a worktree see each other's file changes in `git status`. Only changes attributed to a tool (`via Edit`, and so on) certainly belong to the session shown.
- Changes made by other programs between hook events are found on the next rescan or by `show`, but they cannot be attributed to a tool.
