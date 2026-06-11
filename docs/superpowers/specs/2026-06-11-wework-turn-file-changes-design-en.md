---
sidebar_position: 1
---

# Wework Per-Turn File Changes

## Background

Wework runs Codex and Claude coding tasks through
`wework -> backend -> executor/device`, but assistant messages currently show only
text and tool calls. Native Codex and Claude clients show the files and line counts
changed by one question-and-answer turn, along with a review experience.

The accounting boundary must be one user message and its corresponding assistant
response. A workspace diff against `HEAD` is unsuitable because it mixes existing
user changes with changes from other turns.

## Goals

- Produce an independent file change set for every completed coding turn.
- Show file count, total line counts, and per-file statistics below the assistant
  message.
- Allow users to review the complete turn diff while the device is online.
- Allow users to revert only that turn when the reverse patch applies cleanly.
- Give Codex and Claude the same persisted data shape and frontend behavior.
- Preserve summaries and revert state across page refreshes.

## Scope

The first version includes:

- Wework Git project workspaces.
- Codex and ClaudeCode executors.
- Created, modified, deleted, renamed, and binary files.
- Desktop and mobile summary, review, and revert interactions.
- Reading and reversing patch artifacts on online devices.

The first version excludes:

- Non-Git workspaces.
- Full diff review while the device is offline.
- Forced conflict overwrite or cascading reverts of later turns.
- Rewinding Claude or Codex conversation history.

## SDK Capabilities and Unified Strategy

The Codex SDK emits `turn/diff/updated` and `fileChange` items with a per-turn
unified diff, paths, and change kinds. Its current public API does not expose a
file rewind operation.

The Claude Agent SDK supports `enable_file_checkpointing=True` and
`rewind_files(user_message_id)`, but checkpointing only tracks changes made by
the `Write`, `Edit`, and `NotebookEdit` tools. It does not cover Bash commands,
scripts, or formatters, and it does not directly provide the complete per-turn
summary Wework needs.

Native SDK data is therefore an enhancement rather than the source of truth.
The executor will create Git snapshots before and after every turn and compare
them, giving both runtimes complete and consistent behavior.

## Turn Boundary

Each change set belongs to one assistant `Subtask`:

1. The executor receives the subtask execution request.
2. It captures a `before` snapshot before sending the user input to Codex or
   Claude.
3. It runs the complete agent turn, including tools, scripts, formatters, and
   tests.
4. It captures an `after` snapshot after the turn succeeds.
5. It computes an independent patch, per-file statistics, and totals.
6. It returns the summary to Backend and writes the full patch to a device
   artifact.

Paused, cancelled, and failed turns do not produce a revertible change card
because their workspace state may represent incomplete work.

## Git Snapshot Design

The snapshot must preserve pre-existing tracked, staged, unstaged, and untracked
state; avoid modifying the real Git index; avoid visible commits, branches, or
stashes; exclude ignored files; support repositories without `HEAD`; and produce
a reversible binary patch.

The executor uses a temporary Git index:

1. Create a turn-specific temporary directory and index.
2. Initialize it from the `HEAD` tree, or as an empty index when no `HEAD` exists.
3. Add every non-ignored workspace file to the temporary index.
4. Run `git write-tree` to create `before_tree`.
5. Repeat after the turn to create `after_tree`.
6. Run `git diff --binary --find-renames before_tree after_tree`.
7. Use `--numstat` and `--name-status` for the summary.

`GIT_INDEX_FILE` isolates the temporary index. Existing dirty changes appear in
both trees and are therefore excluded from the turn diff.

## Artifact Storage

The complete patch is stored in a Wegent-managed task artifact directory on the
execution device, not in the database. Backend and Wework never provide arbitrary
device paths.

Recommended logical identifier:

```text
turn-file-changes/{task_id}/{subtask_id}/changes.patch.gz
```

The artifact is a gzip-compressed Git binary patch. Minimal metadata records the
format version, task, subtask, workspace, and checksum. Device cleanup must keep
the artifact for as long as a persisted summary references it.

## Data Model

No new database table is added. The assistant `Subtask.result` receives:

```json
{
  "file_changes": {
    "version": 1,
    "status": "active",
    "artifact_id": "turn-file-changes/6268/12345",
    "device_id": "device-id",
    "workspace_path": "/workspace/project",
    "file_count": 6,
    "additions": 107,
    "deletions": 121,
    "files": [
      {
        "old_path": "src/old.ts",
        "path": "src/new.ts",
        "change_type": "renamed",
        "additions": 3,
        "deletions": 1,
        "binary": false
      }
    ],
    "reverted_at": null
  }
}
```

`artifact_id` is a controlled logical ID. `workspace_path` is stored for
validation and is never accepted from the client.

Statuses are `active`, `reverted`, `conflicted`, and `artifact_missing`. A later
revert attempt may move `conflicted` to `reverted` after the user resolves the
workspace conflict.

## Executor-to-Backend Protocol

The unified Responses emitter completion result gains an optional `file_changes`
field. The executor writes the artifact before calling `done()` and transmits only
the summary and `artifact_id`.

Backend preserves `file_changes` in the existing completed-result merge, writes
it to `Subtask.result`, and includes it in `chat:done.result.file_changes`.
History loading restores the same data from `Subtask.result`.

No field is emitted for empty changes, non-Git workspaces, or unsupported shells.

## Backend APIs and Device RPC

Review endpoint:

```text
GET /api/tasks/{task_id}/subtasks/{subtask_id}/file-changes/diff
```

Backend verifies task ownership, subtask membership, recorded device and
workspace identity, device availability, artifact metadata, and checksum. A
controlled device command reads and decompresses the patch.

Revert endpoint:

```text
POST /api/tasks/{task_id}/subtasks/{subtask_id}/file-changes/revert
```

The device performs one atomic operation:

1. Read and validate the artifact.
2. Run `git apply --reverse --check`.
3. Return a conflict without changing files when the check fails.
4. Run `git apply --reverse` when the check succeeds.
5. Return the updated workspace state.

Backend marks the result `reverted` only after a successful apply. Conflicts set
the status to `conflicted` and retain the artifact. Reverting an already reverted
record is idempotent.

All device operations use registered command keys and server-resolved artifact
IDs. Clients cannot send arbitrary shell commands or paths.

## Wework UI

An assistant message change card shows:

- “Edited N files”.
- Total additions and deletions.
- Relative path and line counts for each file.
- Three files by default, with expand and collapse controls.
- A binary label instead of fabricated line counts.
- A Review action that opens a per-file diff panel.
- A Revert action with confirmation.

When the device is offline, the summary remains visible while Review and Revert
are disabled. Reverted, conflicted, and missing-artifact states have explicit UI.
The first version does not support accepting or rejecting individual hunks.

Desktop and mobile share the data component and use separate containers only when
their interaction or layout differs substantially. Every interactive control has
a stable `data-testid`.

## Concurrency and Consistency

- Only one modifying turn may run in the same workspace at a time.
- If current scheduling permits concurrent workspace execution, snapshot capture
  must acquire a workspace execution lock.
- Review reads the persisted artifact rather than the current workspace diff.
- Revert check and apply run atomically on the device.
- Reverting an older turn fails without side effects when later work changed the
  same content.

## Security

- Artifact IDs are constrained to the Wegent-managed directory and reject path
  traversal.
- Decompression has a size limit.
- Diff responses have a text size limit.
- Full patch content is not logged.
- Backend validates user, task, subtask, device, and workspace ownership.

## Testing

Executor tests cover pre-existing dirty state, consecutive turns, all file change
types, repositories without `HEAD`, Bash and formatter changes, real-index
isolation, and artifact validation.

Backend tests cover result persistence, `chat:done`, history restoration,
authorization, offline devices, missing artifacts, conflicts, idempotency, and
safe merging with existing `value` and `blocks`.

Wework tests cover totals, expansion, review, revert confirmation, error states,
offline behavior, history restoration, and desktop/mobile interactions.

Integration tests cover mixed Claude Edit/Bash changes, Codex native diff
agreement, successful reverts, and conflict-safe rejection of older-turn reverts.

## Documentation

After implementation, user documentation is written in `docs/zh/` first and then
mirrored in `docs/en/`. It must state that offline devices cannot review or
revert changes and that Claude SDK checkpointing is not Wegent's sole revert
mechanism.
