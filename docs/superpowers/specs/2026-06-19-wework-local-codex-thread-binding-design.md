---
sidebar_position: 1
---

# Wework Local Codex Thread Binding

## Background

Wework can already run Codex through Wegent-managed tasks: Wework creates a
Wegent `Task`, Backend schedules a local executor, the executor starts Codex,
and Wegent stores the task list, status, and message stream.

Daily local Codex App or CLI usage creates a different object: a local Codex
thread stored under the user's `CODEX_HOME` (normally `~/.codex`). Wework does
not currently know about those threads, so a user cannot see or continue them
from Wework or a mobile client.

This design assumes the local executor runs as the same operating-system user
and uses the same `CODEX_HOME` as the user's normal Codex App or CLI.

## Goals

- Let Wework discover local Codex threads from an online local device.
- Let the user bind a local Codex thread to a Wework-owned Wegent task.
- Show bound local Codex threads in the existing Wework conversation list.
- Continue the same Codex thread id from Wework, including from mobile.
- Store Wework-origin follow-up messages and runtime status in Wegent so the
  task behaves like a normal Wework task after binding.
- Keep local-device execution restricted to named Backend command keys.

## Non-Goals

- No full historical transcript import in the first version.
- No direct browser access to `~/.codex` or arbitrary filesystem paths.
- No support for executors that use a different user or a different
  `CODEX_HOME`.
- No attempt to merge Codex's local thread database with Wegent's task database.
- No cloud-device support for local Codex thread binding.
- No management of Codex App UI state. Wework controls threads through Codex
  app-server or SDK primitives.

## Core Model

The first version treats a Wegent task as an alias for a local Codex thread. The
real Codex conversation state stays in Codex. Wegent stores only enough metadata
to list, open, and continue that thread safely.

Each bound task stores:

```ts
interface LocalCodexThreadBinding {
  source: 'local_codex_thread'
  deviceId: string
  codexThreadId: string
  cwd?: string
  title?: string
  importedAt: string
  lastSyncedAt?: string
}
```

The binding identifiers live in Task CRD metadata labels:

- `source=local_codex_thread`
- `localCodexThreadId=<thread id>`
- `localCodexDeviceId=<device id>`

`device_id` remains the execution device. `spec.execution.workspace.source` is
`local_codex_thread`, and `spec.execution.workspace.path` stores the working
directory when Codex reports one.

The tuple `(user_id, client_origin='wework', device_id, codex_thread_id)` must
resolve to at most one active Wegent task. Re-binding an already imported thread
returns the existing task instead of creating duplicates.

## Discovery Flow

Wework adds a local Codex discovery entry point for online local devices. The UI
calls Backend, and Backend dispatches a narrow local-device command such as
`codex_threads_list`.

The command returns thread summaries, not raw transcripts:

```ts
interface LocalCodexThreadSummary {
  threadId: string
  title: string
  cwd?: string
  updatedAt?: string
  archived?: boolean
  running?: boolean
}
```

The primary implementation should use Codex app-server or SDK thread APIs. If a
specific Codex version does not expose enough listing metadata, Backend may use
a read-only local index command as a temporary implementation detail, but that
path must remain behind the same command key and response schema.

## Binding Flow

When the user chooses a discovered thread, Wework calls a Backend import/bind
endpoint. Backend:

1. Verifies that the target device belongs to the current user and is online.
2. Refreshes the thread summary from the device to verify that the thread still
   exists before binding.
3. Creates or reuses a Wework `Task` with `source=local_codex_thread`.
4. Stores `device_id`, `codex_thread_id`, `cwd`, and title metadata.
5. Adds an initial system-style subtask or task result summary saying the task is
   bound to an existing local Codex thread.

The initial summary is intentionally not a reconstructed transcript. It gives
the Wework UI a stable first message while leaving Codex's full context in
Codex.

## Continue Flow

When the user sends a follow-up in a bound task, the normal Wework chat send path
detects `source=local_codex_thread` and routes execution to a local Codex thread
resume path instead of starting a fresh Codex task.

Backend sends a device command such as `codex_thread_turn` with:

- `codex_thread_id`
- user message text
- attachment references already supported by Wework, when present
- `cwd`, if stored on the binding
- model/options when compatible with the current Wework selection

The local executor resumes the Codex thread id through Codex app-server or SDK,
starts a new turn, and streams normalized progress back through the existing
Wegent task/subtask update path. Wework-origin turns are stored as normal
Wegent subtasks, so mobile clients can see messages sent after binding.

## UI Design

The Wework sidebar continues to show Wegent tasks. Bound Codex threads appear as
normal conversations with a small Codex/local indicator and the local device
name in metadata. They can be opened, renamed, archived, and searched by their
Wegent task title.

The discovery UI should be a compact action near the conversation list or device
menu:

- Select an online local device.
- Show recent local Codex threads with title, directory, and update time.
- Bind a selected thread.
- Open the resulting Wework task.

On mobile, already-bound tasks require no special list UI. Discovery can be
desktop-first if mobile device selection would add too much first-version
complexity.

## Error Handling

- Device offline: disable discovery and continue actions with a clear device
  status message.
- Thread not found on resume: keep the Wegent task, mark the attempted subtask
  failed, and tell the user the thread is missing from that device's Codex home.
- Codex app-server unavailable: return an actionable error that the local
  executor or Codex installation needs attention.
- Different `CODEX_HOME`: surface as "thread not found"; do not scan arbitrary
  paths from the UI.
- Concurrent turns: reject a second Wework turn while the bound task is already
  running on the same Codex thread.
- Archived local Codex thread: allow listing with an archived marker, but require
  explicit unarchive/resume support before sending follow-ups.

## Security

The browser never sends raw shell commands. All local operations go through
Backend-owned command keys. Device commands should validate thread ids, cap
output size, avoid returning full transcripts by default, and avoid exposing
secrets from Codex state files.

Only the owner of the device and task can bind or continue a thread. Backend
must include `user_id` in all Task lookups and must not bind a thread from one
user's device into another user's task.

## Testing

- Backend command registry resolves `codex_threads_list` and `codex_thread_turn`
  as narrow built-in commands.
- Binding the same `(device_id, codex_thread_id)` twice returns the existing
  active Wework task.
- Bound tasks appear in `/tasks/lite/personal?client_origin=wework`.
- Opening a bound task shows the binding summary and uses the normal Wework task
  detail path.
- Sending a message to a bound task calls the Codex thread resume path, not the
  fresh task execution path.
- A missing local thread produces a failed subtask without deleting the Wework
  task.
- Offline devices block discovery and continue actions.
- Existing Wework tasks without a Codex binding keep the current execution path.

## First-Version Limits

- Only local devices are supported.
- Only threads visible to the local executor's current `CODEX_HOME` are
  supported.
- Full historical transcript rendering is deferred.
- Search covers bound task titles and Wework-origin follow-up messages, not the
  entire pre-binding Codex transcript.
- Archive/delete in Wework affects the Wegent task alias first. Local Codex
  archive/delete can be added later as an explicit action.
