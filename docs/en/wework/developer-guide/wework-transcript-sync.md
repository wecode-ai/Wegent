---
sidebar_position: 36
---

# Wework Transcript and Preference Cloud Sync

The Wework Core DSH plugin `@wegent/dsh-transcript-sync` synchronizes native
Codex rollouts, task workspaces, and portable preferences. It no longer
reduces a session to user/assistant text or reconstructs history through
`thread/inject_items`.

## Storage boundary

The Backend uses two tables:

| Table                        | Purpose                                                                  |
| ---------------------------- | ------------------------------------------------------------------------ |
| `wework_transcripts`         | Transcript identity, branch relation, sequence, state, and writer lease  |
| `wework_transcript_archives` | Immutable native segment sequence, object key, SHA-256, size, and format |

The Executor encrypts bodies with AES-256-GCM before uploading them directly to
the private `wework-transcripts` object bucket. MySQL stores no messages,
reasoning, tool calls, usage, rollout JSONL, or workspace files, so transcript
size is not constrained by MySQL JSON or VARCHAR field capacity.

The Backend derives a stable per-transcript key from the server `SECRET_KEY`,
user ID, and transcript ID and returns it only through the authenticated
`GET /{id}/encryption-key`
endpoint. The key is never persisted in sync state, the outbox, or object
storage. Each segment nonce is derived from the key, AAD, and plaintext digest.
AAD binds the transcript ID, sequence, and format. Identical retries therefore
produce identical ciphertext for SHA-256 reconciliation without reusing a
nonce for different plaintext.

Each cloud sequence maps to exactly one object:

- Sequence 1, every tenth sequence, and sequence 1 of a conflict branch are
  full encrypted `codex-rollout-snapshot.v1.tgz.aes256gcm` snapshots.
- Other sequences are encrypted `codex-rollout-delta.v1.tgz.aes256gcm`
  increments.
- Every segment also carries a workspace overlay so recent files are not lost.
- Workspace packaging excludes `.git`, `node_modules`, build outputs, and
  common cache directories so repository objects and unrelated derived files
  are not uploaded repeatedly.
- The outbox stores only task, session, turn, sequence, and branch locators.
- After a new full snapshot is committed, the Backend retains the previous full
  snapshot and every later segment, then deletes older object bodies and
  metadata. With a snapshot interval of 10, an active transcript normally keeps
  11 objects and peaks at about 20 instead of growing without bound.

Two computers may keep Wework open at the same time. Clients poll cloud progress
every five seconds and acquire a short writer lease only while uploading, then
release it immediately. An idle office computer does not hold the lease, and a
running local task is never overwritten by restore. If both computers complete
the same sequence concurrently, the first commit remains on the main line and
the second becomes a deterministic branch, preserving both results.

The migration drops the lossy `wework_transcript_turns` table. Data written by
the old beta protocol is not used for restore.

## State transitions

```mermaid
stateDiagram-v2
    [*] --> LocalReady
    LocalReady --> LeaseHeld: acquire lease while online
    LocalReady --> OfflinePending: Backend unavailable
    OfflinePending --> LeaseHeld: connection restored
    LeaseHeld --> SegmentBuilt: build and encrypt snapshot or rollout delta
    SegmentBuilt --> ObjectUploaded: PUT presigned object URL
    ObjectUploaded --> MetadataCommitted: commit hash, size, and sequence
    MetadataCommitted --> LocalReady: record rollout offset, clear outbox, release lease

    LeaseHeld --> Reconcile: cloud head differs from baseSequence
    Reconcile --> LocalReady: same-sequence object hash matches
    Reconcile --> BranchSnapshot: object missing or hash differs
    BranchSnapshot --> LeaseHeld: create deterministic fork transcript

    [*] --> RestoreRequired: transcript missing or behind locally
    RestoreRequired --> Downloading: select latest snapshot and contiguous deltas
    Downloading --> Staging: download and verify SHA-256
    Staging --> Bound: restore workspace, rollout, thread metadata, and dynamic tools
    Staging --> RestoreRequired: validation failed; remove staging
    Bound --> LocalReady
```

Conflicting rollout files are never merged. The cloud mainline remains
unchanged. The conflicting local chain moves to a branch derived from
`clientId + transcriptId + turnId` and uploads a full snapshot as branch
sequence 1.

## Two-device verification

The GitHub CI `transcript-sync` desktop checkpoint starts real Electron,
Executor, and Codex processes and sequentially simulates device A and device B
inside one test. The devices use separate `HOME`, `WEGENT_EXECUTOR_HOME`,
`WEGENT_CODEX_HOME`, `CODEX_SQLITE_HOME`, Electron user data, application
configuration directories, and device identities. Switching to device B does
not delete or reuse device A's state.

The checkpoint must verify that device A uploads an encrypted snapshot and
delta, device B restores the workspace and complete history from an empty
state, and device B continues the conversation and uploads the next sequence.
A restart test that shares local state is not an equivalent verification.
Testing on two physical computers remains a release acceptance check for real
network, sleep, and operating-system differences, but is not a prerequisite for
GitHub CI.

## Restore order

1. Select the latest full snapshot at or before the current head.
2. Download that snapshot and every contiguous later delta, verifying
   ciphertext SHA-256, format, and sequence.
3. Authenticate and decrypt each object with the current user's key, verify its
   identity, restore the workspace in staging, and concatenate and parse rollout
   JSONL.
4. Rewrite the workspace path and allocate a new thread ID on collision.
5. Restore Codex `threads` and `thread_dynamic_tools` state transactionally.
6. Bind the local task only after all checks pass; otherwise remove staging,
   rollout, and workspace output.

## API

The authenticated prefix is `/api/wework-transcripts`:

| Method and path                           | Purpose                                           |
| ----------------------------------------- | ------------------------------------------------- |
| `GET /`                                   | List transcripts and native segment metadata      |
| `GET /{id}`                               | Read one transcript                               |
| `GET /{id}/encryption-key`                | Obtain the current user's transcript cipher key   |
| `POST /{id}/lease`                        | Create a transcript or acquire its writer lease   |
| `PUT /{id}/lease/{token}`                 | Renew a lease                                     |
| `POST /{id}/lease/release`                | Release a lease                                   |
| `POST /{id}/segments/prepare`             | Validate sequence and create a presigned PUT URL  |
| `POST /{id}/segments`                     | Verify object size and commit its immutable index |
| `POST /{id}/archive`                      | Mark a transcript archived                        |
| `GET /{id}/archives/{archiveId}/download` | Create a short-lived signed download URL          |

Object keys contain a SHA-256 digest of the transcript ID rather than the raw
identifier.

## Deployment configuration

Object storage reuses the `ATTACHMENT_S3_*` connection settings:

| Environment variable                            | Default              | Purpose                                  |
| ----------------------------------------------- | -------------------- | ---------------------------------------- |
| `WEWORK_TRANSCRIPT_S3_BUCKET`                   | `wework-transcripts` | Private native transcript segment bucket |
| `WEWORK_TRANSCRIPT_DOWNLOAD_URL_EXPIRE_SECONDS` | `900`                | Upload/download signed URL lifetime      |

Run the Alembic migration before deployment. If object storage is unavailable,
segment metadata is not committed and the outbox keeps its locator while local
execution remains available offline.
