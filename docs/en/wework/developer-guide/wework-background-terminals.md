---
sidebar_position: 19
---

# Wework background terminals

Codex commands can continue running after their AI turn finishes. The conversation environment summary lists these commands and their count under Background processes. Selecting a command opens a read-only terminal tab on the right with live output and a No output yet placeholder when empty. An exited process disappears from the running list; an open log tab remains available to read and close.

Process rows and log tabs reuse the tool cards' command display rules, removing shell wrappers such as `/opt/homebrew/bin/zsh -lc` to show the actual command. Hovering reveals the full original command. This changes presentation only; execution arguments and process identities remain intact.

Each row's stop action stops all background terminals in the current task's Codex thread. It does not stop only that row's process or interrupt the AI turn. Cleanup failures keep the running list visible and show an error.

## State and events

- Native `commandExecution` items own process identity, status and output. The `command_execution` render payload retains the process ID, native status, source, exit code and command actions.
- The summary includes top-level commands still `inProgress` in finished turns. Commands in active turns and nested agent commands are excluded.
- Turn completion does not prove process exit. Native command completion ends the command; later output updates the original tool record without reopening the AI turn.
- `terminalInteraction` merges metadata into the original command without creating another process row. Partial updates must preserve process identity and running status.
- Reload reads the latest native thread items. A cached turn-completion snapshot must not overwrite subsequent command output or exit state.
- A running thread snapshot may contain only the output available when the command first yielded control. Reload merges its continuously updated event buffer; native command-completion snapshots take precedence over running caches for exit state and full output. Completion notifications that omit output retain the existing buffer. Frontend snapshot merging also preserves already received output when a transcript read races with live events.
- Native turn-completion notifications may contain only the final answer; the executor retains command items received earlier in the stream. Background output and exit events use the command's native `turnId`, even when the thread route has subsequently been registered for context compaction, rather than updating the synthetic compaction turn.
- Output during execution settlement still belongs to its completed command turn. Automatic operations such as model catalog reconciliation cannot restart Codex app-server as idle while background commands remain running, so reloading the conversation does not interrupt them.

The viewer reuses existing xterm themes, fonts and link handling. It displays tool output without creating a shell or accepting process input.

## Cleanup routing

The frontend sends `runtime.tasks.background_terminals.clean` to the executor addressed by the current task. That executor invokes Codex `thread/backgroundTerminals/clean`. Unsupported runtimes must not expose an actionable stop control. Device and execution failures must reach the UI rather than reporting a successful cleanup.

## Verification

Focused tests cover turn completion, output deltas, partial metadata, process exit, stale snapshot merging, cleanup failure and device routing. The `background-terminals` desktop checkpoint is registered in the existing CI runner. It uses real Electron, executor, Codex and persistent shell processes; only model responses are provided by a test service.

Verify the process list, read-only logs, reload recovery, stopping all processes and retained logs after exit. Screenshots and session logs are verification evidence kept in test results or outside the repository, never committed as source.
