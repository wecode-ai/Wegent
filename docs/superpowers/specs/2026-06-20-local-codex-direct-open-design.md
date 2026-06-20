---
sidebar_position: 1
---

# Local Codex Direct Open

## Context

Wework currently discovers local Codex threads through the local device command
`codex_threads_list`, then lets the user "import" a selected thread. The
implementation actually creates or reuses a Wegent Task alias for the Codex
thread; it does not copy the full Codex transcript.

That wording and flow are confusing. Users expect local Codex threads to behave
like available conversations, not importable files. The list also currently
shows subagent and running threads that should not be user-selectable.

## Goals

- Hide local Codex subagent threads from user-facing discovery.
- Hide currently running local Codex threads from user-facing discovery.
- Replace the "import" interaction with a direct-open interaction in the left
  conversation area.
- Treat opening as taking over and continuing the same local Codex thread, not
  as forking or copying it.
- Keep the Wegent Task alias as the persistence and mobile-resume carrier.
- Preserve project grouping by resolving a local Codex thread's `cwd` to a
  Wework project before opening it.

## Non-Goals

- Do not import full historical Codex transcripts.
- Do not fork local Codex threads in this flow.
- Do not remove the Task alias model.
- Do not support concurrent Wework turns against a running Codex thread.
- Do not add local Codex archive/delete management.

## Thread Semantics

Opening a local Codex thread in Wework means taking over and continuing the
original Codex thread id. Wework appends follow-up user messages and model
responses to the same local Codex state, so Codex App can see the Wework turns
after it reloads its local thread store.

Codex App is not expected to live-refresh when another process writes to the
same thread. Users may need to switch conversations, refresh, or restart Codex
App before Wework-origin turns appear there.

Because the underlying Codex thread is shared, the binding must remain
one-to-one: one `(device_id, codex_thread_id)` maps to one active Wework Task
alias. Reopening an already connected thread reuses that Task instead of
creating another task that writes to the same Codex context.

## Discovery Filtering

The local device command should enrich discovered records from session metadata
when needed. A thread is visible only when:

- `running` is not true.
- `archived` is not true.
- `thread_source` is missing or equals `user`.

Threads whose session metadata contains `thread_source: "subagent"` are
excluded. If a record cannot be enriched because the session file is missing,
the command should keep the record only when it does not explicitly look like a
subagent thread.

Backend should also apply the same final filter after command output
normalization. This keeps the API stable if a configured command override
returns unfiltered records.

## Direct-Open UX

The left conversation area should include a compact local Codex entry point for
online local devices. It can be a section or a popover, but the primary action
is "open/connect" or "take over", not "import".

The list shows recent visible local Codex threads with title, `cwd`, and update
time. Selecting an item calls the existing bind endpoint, which creates or
reuses the one-to-one Task alias, moves it into the resolved project, refreshes
task state, and navigates directly to the resulting conversation.

Already bound local Codex threads should not be duplicated in the pending local
Codex list. They remain visible as normal Wework tasks inside their project or
conversation list.

## Data Flow

1. Wework requests local Codex threads for the selected online local device.
2. Backend dispatches `codex_threads_list`.
3. The command reads `session_index.jsonl`, enriches from matching rollout
   metadata, and filters subagent, archived, and running threads.
4. Backend normalizes and filters the returned summaries again.
5. Wework renders visible unbound threads in the left local Codex entry point.
6. Selecting a thread calls `/local-codex/threads/bind`.
7. Backend creates or reuses the one-to-one Task alias and returns the Task.
8. Wework refreshes project/task state and opens the conversation.
9. Later messages from that Task resume and append to the same Codex thread id.

## Error Handling

- No online local device: show the existing local-device unavailable state.
- Thread disappears before open: show a not-found message and refresh the list.
- Thread becomes running before open: reject binding and ask the user to retry
  after the local Codex turn finishes.
- Same thread is already connected: reuse and open the existing Task.
- Default team unavailable: keep the current backend error, surfaced in the UI.

## Testing

- Command registry tests cover filtering `thread_source: "subagent"`.
- Command registry tests cover filtering `running: true`.
- API endpoint tests cover backend-side filtering of command override output.
- Backend tests cover reusing the existing Task for the same
  `(device_id, codex_thread_id)`.
- Wework tests cover direct-open copy and absence of disabled running rows.
- Wework tests cover selecting a local Codex row and navigating to the returned
  Task.
