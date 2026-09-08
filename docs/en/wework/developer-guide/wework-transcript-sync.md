---
sidebar_position: 36
---

# Wework Transcript and Preference Cloud Sync

Wework uses the built-in Core DSH plugin `@wegent/dsh-transcript-sync` to
synchronize completed conversation turns and portable preferences. The sync
layer only transports and stores data reliably; it does not interpret
conversation semantics. Later analysis features can consume the same Backend
data.

## Data boundaries

The sync contract covers three kinds of data:

- Completed user messages, model replies, reasoning summaries, usage, and
  completion state, synchronized as turn increments.
- Active transcript metadata such as title, current sequence, archive
  location, and the single-writer lease.
- Portable preferences such as theme, language, context threshold, supervisor
  settings, and quick phrases.

Cloud connections, access tokens, local Harness definitions, local attachment
paths, absolute workspace paths, and system credentials are never uploaded as
portable preferences. Transcript synchronization also does not copy a Git
workspace or a model provider's native session files. To continue execution on
another device, the execution layer still needs an available workspace.
Executor injects downloaded finalized turns into the native Codex thread bound
to the task, so subsequent model requests use that native conversation history
instead of a second side-channel transcript body.

## Hot tables and cold files

The Backend uses three tables:

| Table                        | Purpose                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `wework_transcripts`         | Per-user metadata, current sequence, and writer lease for each stable transcript        |
| `wework_transcript_turns`    | Finalized turns for active transcripts that have not been archived                      |
| `wework_transcript_archives` | Sequence ranges, object keys, SHA-256 digests, and sizes for immutable archive segments |

Clients do not write one row per token or streaming chunk. They append one
increment only after a turn finishes. `baseSequence`, contiguous `sequence`
values, and stable `turnId` values make retries idempotent.

A local turn number only describes execution order on one device, while the
cloud `sequence` is local to one transcript branch. When a turn finishes, the
client persists a `baseSequence` from its locally known cloud head. If that
head changed before upload, the client pulls the conflicting position. A
matching `turnId` confirms that an earlier append succeeded. A different turn
means two devices executed from the same stale context and cannot be safely
linearized, so the client automatically creates a transcript branch. A branch
stores only `parentTranscriptId`, `forkedAtSequence`, and its new turns; it
does not copy the parent transcript body.

During archival, the Backend encodes hot turns as JSON Lines, compresses them
as `jsonl.zst`, and uploads the result to private object storage. It deletes hot
rows only after the object upload succeeds. Object keys use a digest of the
transcript ID instead of exposing the original identifier, and restore reads
verify the SHA-256 digest. New turns after archival form a hot tail after the
cold history.

## Single writer and offline recovery

A client must acquire a short lease with a fencing token before writing. The
Backend rejects writes while another client holds a valid lease, and expired or
superseded fencing tokens cannot append turns. The plugin releases the lease
immediately after one finalized turn is committed; it never uploads the whole
transcript file for every turn.

The plugin atomically persists pending turn locators in a SQLite outbox under
`DSH_HOME` before contacting the Backend. The outbox stores the `sessionId`,
local and cloud sequence metadata, stable `turnId`, target transcript, and
Executor turn identifier and branch route, but never duplicates message bodies.
Upload pages through `runtime.tasks.transcript` and reads the matching turn
directly from the Executor's authoritative conversation store. The sync plugin
does not persist another DSH Session body. During download, a task with an
existing native thread resumes that thread before injecting increments. On a
cold device where the task has no thread yet, Executor creates and binds a
native Codex thread before injecting turns in cloud sequence order. The local
`importedThrough` cursor advances only after injection succeeds, preventing
restarts or lost responses from duplicating or reordering model history.
Starting Wework without a cloud connection does not lose data. Polling uploads
the outbox and downloads hot turns after a connection is established.
Consecutive failures use exponential backoff capped at 60 seconds, and each
Backend request is bounded to 30 seconds, so local task execution remains
available. When restoring an archived transcript for the first time, the
plugin loads archive segments before appending the resumed hot tail.

If two devices produce different turns from the same cloud head, the
conflicting turn is routed to an independent transcript branch. The mainline
device does not inject that branch into its native thread. After a device binds
to the branch, its model requests contain only history before the fork point
and turns committed to that branch.

Every Wework installation is an equal sync client. A cloud Executor is an
execution location, not another sync device competing for the lease.

## API

The authenticated API prefix is `/api/wework-transcripts`:

| Method and path                           | Purpose                                                  |
| ----------------------------------------- | -------------------------------------------------------- |
| `GET /`                                   | List the current user's transcripts and archive metadata |
| `POST /{id}/lease`                        | Create a transcript or acquire its writer lease          |
| `PUT /{id}/lease/{token}`                 | Renew a lease                                            |
| `POST /{id}/lease/release`                | Release a lease                                          |
| `POST /{id}/turns`                        | Append contiguous finalized turns                        |
| `GET /{id}/turns`                         | Pull the hot tail by sequence                            |
| `POST /{id}/archive`                      | Convert current hot turns into an immutable cold archive |
| `GET /{id}/archives/{archiveId}/turns`    | Verify and page through archived turns                   |
| `GET /{id}/archives/{archiveId}/download` | Create a short-lived signed download URL                 |

Portable preferences reuse `/api/v1/dsh-plugin-storage` with the
`portable_preferences` storage unit under
`@wegent/dsh-transcript-sync`.

## Deployment configuration

Archives reuse the Backend `ATTACHMENT_S3_*` MinIO/S3 connection settings and
add:

| Environment variable                            | Default              | Purpose                           |
| ----------------------------------------------- | -------------------- | --------------------------------- |
| `WEWORK_TRANSCRIPT_S3_BUCKET`                   | `wework-transcripts` | Private transcript archive bucket |
| `WEWORK_TRANSCRIPT_DOWNLOAD_URL_EXPIRE_SECONDS` | `900`                | Signed download URL lifetime      |

Run the Alembic migration before deployment. If object storage is unavailable,
the archive API fails while retaining all hot rows. Normal active-turn
synchronization does not depend on a successful archive.
