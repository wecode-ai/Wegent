---
sidebar_position: 12
---

# Knowledge Indexing Protection

## Web refresh and document publication

Web auto update reuses the DingTalk Rust daily scan, paginated cursor and existing
document index state machine. Rust dispatches
`app.tasks.web_auto_update_tasks.refresh_web_document` to the Python `wegent_online`
queue. Manual refresh uses the same Python service, which explicitly dispatches
the existing indexing task to that queue. Do not add a second Python web cron or
send web candidates to the Rust index executor.

The sequence is fetch → build a candidate index → verify visibility → switch the
database publication pointer → collect retired versions later. This is a staged
protocol, not an atomic transaction across the database and vector store.

| State                 | Existing storage                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Business generation   | `knowledge_documents.index_generation` fences stale tasks                                                                     |
| Candidate             | `source_config._web_refresh` records URL, resource fingerprint, immutable attachment, hash, requester and user controls       |
| Published version     | `source_config.published_generation`, separate from the running generation                                                    |
| Published hash/config | `webAutoUpdate.content_hash` / `published_index_fingerprint`; skip rebuilding only when both match                            |
| Cleanup identity      | Attachment `type_data.web_index_version` records the exact version, original storage resource revision and retention deadline |

Physical candidate references are `document_id@generation`. Documents without a
publication pointer retain their original reference. Runtime resolves pointers
from the database and pushes paired document/version filters into Elasticsearch,
Milvus and Qdrant recall and chunk listing before top-k. Caller-supplied version
maps do not determine visibility. Body attachments, chunks, converted references
and summaries switch together; summary callbacks condition writes on their source
attachment.

Before publication, Elasticsearch refreshes the indexes and checks failed shards;
Milvus verifies the complete candidate with Strong reads without a per-document
collection flush; Qdrant checks candidate nodes
across all replicas. Batched validation checks every child and parent node.
Partial writes cannot publish. Verify these contracts on the target deployment:
unit tests and embedded Qdrant do not prove distributed cluster consistency.
Only versioned Milvus searches use Strong, passed through the existing client
wrapper; unversioned searches retain their original defaults. Parent reads raise
consistency only for publication checks and versioned queries. See the Milvus
[consistency contract](https://milvus.io/docs/v2.5.x/tune_consistency.md) and
[flush performance guidance](https://milvus.io/api-reference/pymilvus/v2.5.x/ORM/Partition/flush.md).

The existing document lock key gains token-owned renewal and release. Existing
business state hands ownership between fetch, queued and indexing stages. The
publication transaction rechecks generation, source URL, resource fingerprints,
requester permissions, KB existence, automatic-update flags and unchanged user
controls. Refresh never enables a disabled document; automatic scans skip it.
First indexing marks content ready while respecting the explicit choice recorded
in the existing JSON as `web_user_status`. System-default disabled documents can
become enabled on first success; explicitly disabled documents remain disabled
and can be enabled later. Candidates capture this choice and recheck it before
publication. The original initial-index task also respects the choice.

Refresh opts into accepting valid short bodies, including PDF, Playwright frames
and text extraction, through the existing quality checks. Authentication/block
shells, density, repetition, HTTP status and SSRF checks remain active; other
callers retain their length defaults. Unchanged-content completion also reloads
state under a database row lock, updates conditionally on generation, and checks
lease ownership before committing.

During fetching, Redis serializes each destination domain and enforces at least
five seconds between crawl starts using Redis time. HTTP, PDF, browser navigation,
redirect and iframe destinations require admission too; same-domain resources
within one crawl share its admission. Domain leases end after fetching, before
indexing. Redis failures reject the refresh.

Retired indexes and unpublished attachments remain for at least 24 hours, covering
in-flight reads within the existing ten-minute gateway deadline. The existing
attachment maintenance entry processes consecutive batches (200 by default),
reusing `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS` (10000) and the existing time budget,
capped by the cleanup interval. It saves the cursor when its budget expires and addresses
the exact original version/store, retains failures for retry, and never rolls back
a successful publication. Published versions and running candidates are protected;
invalidated candidates and unconsumed drafts become collectible. Failed fetches,
dispatches and indexing preserve a staged draft for retry. Expiry invalidates its
attachment reference and explicitly requires another refresh before reindexing.
If the original
Retriever resource disappears or changes, cleanup retains its record and logs a
warning instead of guessing the new storage location.

### Enabling and rollback

- Both deployment and KB switches default to off. Set
  `WEB_AUTO_UPDATE_SCHEDULE_ENABLED=true` in the Rust scheduler and Python worker
  deployments, then enable web updates in the KB edit dialog as creator/Maintainer.
  Without `WEGENT_RS_JOB_ALLOWLIST`, this opt-in also enables the existing stale-recovery and attachment-cleanup jobs.
  An explicit allowlist must include `app.tasks.web_auto_update_tasks.scan_web_documents`,
  `app.tasks.knowledge_tasks.scan_stale_index_tasks`, and `app.tasks.knowledge_tasks.cleanup_knowledge_attachment_orphans`; missing dependencies fail startup with a configuration error.
  Rust publication and Python workers use the same `CELERY_BROKER_URL` (Redis transport only, falling back to `REDIS_URL`). Result subscriptions remain separate.
- The fixed daily scan is **04:00 UTC (12:00 Beijing)**, independent of host time
  zone. It reuses `EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS` (10000 by default) and
  `EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS` (2700), preserving a cursor between runs.
- KB flags are rechecked before execution and publication. Global environment
  flags are process configuration: editing an environment file does not notify
  running workers. For emergency shutdown, disable affected KBs, stop scheduling
  and drain/stop old workers. Manual refresh remains available.
- Automatic summary generation defaults to off; explicit manual options remain.
- Duplicate document tasks use the existing `KNOWLEDGE_INDEX_LOCK_MAX_RETRIES`
  and `KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS` (one retry after 15 seconds by default),
  then skip until a subsequent scan. Domain contention instead retries with
  exponential backoff and jitter, up to about five minutes between attempts,
  within the original scan message's 24-hour expiry. It does not share the
  duplicate-task retry budget or extend the deadline. No new queue, scheduler or
  configuration is introduced.
- With a published index, `trigger_indexing=false` stages a draft for subsequent
  reindexing. Never-indexed web documents can still update their body first.
  An expired draft must be fetched again.
- Upgrade Backend, Runtime, Engine and shared protocol together. Once versions
  are published, **do not roll back only Runtime to code that ignores pointers**.
  Stop updates and retain compatible readers, or perform a validated index/data
  migration first. No new database table or column migration is required.

Rust owns `GET/PUT /api/knowledge-bases/{id}/web-auto-update`, with
`{"enabled": boolean}` request/response data. Missing KBs return 404; access denial
returns 403. PUT requires creator/Maintainer and rejects non-boolean input with 422. Existing KB APIs keep their original route ownership.

## Background

Document RAG indexing previously relied mostly on Celery delivery and retry behavior, without a business-level idempotency guard.

In production, the following situations could cause repeated embedding for the same large file:

- worker / Pod restarts that trigger broker redelivery
- duplicate enqueue for the same document
- an old task resuming after a newer indexing attempt has already started

## Goals

- Only one active indexing generation should be valid for a document at a time
- Old redelivery / retry tasks must not overwrite newer results
- Even if Celery re-delivers a task, the business layer should reject it quickly
- Indexing state should be explicit for debugging and future UI usage

## Design

The protection has three layers.

### 1. Document indexing state machine

The `knowledge_documents` table now stores:

- `index_status`: `not_indexed | queued | pending_conversion | converting | indexing | success | failed`
- `index_generation`

`index_generation` is the key field. Every valid new indexing attempt gets a new generation. Any older task becomes stale automatically.

`not_indexed` is the explicit initial state. It separates "never indexed yet" from a real execution failure instead of overloading both into `failed`.

### 2. Business dedupe before enqueue

Before sending a Celery task, the orchestrator updates database state first:

- if the document is already `queued / pending_conversion / converting / indexing`, duplicate enqueue is skipped
- if `queued / pending_conversion / converting / indexing` has been stuck too long, a new request can take over with a new generation
- if the document is already `success`, normal retry requests are skipped
- only flows that explicitly need a new attempt create a new generation

Current policy:

- new document: create a new generation
- retry for failed document: create a new generation
- content update / web refresh: replace the active generation so old tasks become stale
- long-lived `queued / pending_conversion / converting / indexing`: allow takeover after stale detection based on `updated_at`

Current default thresholds:

- `queued` older than 10 minutes can be replaced by a new generation
- `pending_conversion` older than 20 minutes can be replaced by a new generation
- `indexing` older than 45 minutes can be replaced by a new generation

### 3. Final guard before worker execution

Before calling the embedding model, the Celery worker:

1. acquires a Redis distributed lock based on `document_id`
2. validates the current `index_generation` and `index_status` in the database

The task only executes when:

- the task generation matches the current database generation
- the current status is still `queued`, `pending_conversion`, or `indexing`

Otherwise it returns `skipped` and does not call the embedding model again.

## Why generation solves redelivery

A lock alone is not enough.

After a worker crash, the lock will eventually expire, while the old broker message may still be redelivered. Without generation checks, that old message could acquire the lock later and run again.

With generation:

- a new indexing attempt increments the generation
- old redelivered messages become stale immediately
- even if an old task reaches the final write phase, it cannot overwrite the latest generation state

## Long-running lock watchdog

Embedding can run for many minutes, so the document-level Redis lock uses a watchdog extension pattern:

- short initial TTL
- background extension while the task is alive
- natural expiration after process exit or crash

This avoids both failure modes:

- lock expires too early during a long task
- lock stays too long after a crashed worker

## Relationship with Celery retry

This change still focuses on business-side protection first, so `index_document` no longer uses generic retry for all failures.

The current behavior is:

- `lock_held`: limited short-delay retries only, to cover the leftover lock window after worker restarts
- duplicate / stale tasks that business logic can explain: `skipped`
- actual execution failure: persisted as `failed`
- if the indexing layer returns a business `skipped` result during execution: it is also persisted as `failed` instead of `success`
- any further retry must create a new business generation explicitly

This prevents the same failed logical task from being replayed repeatedly between broker and workers.

Current default lock settings:

- document lock TTL: 120 seconds
- watchdog extend interval: 30 seconds
- `lock_held` retry delay: 15 seconds
- `lock_held` max retries: 10

## Existing data migration

The migration initializes historical documents as follows:

- `is_active = true` becomes `index_status = success`
- all other historical documents default to `index_status = not_indexed`

This lets existing rows enter the new state machine immediately.

## Follow-up work

This change fixes business idempotency and repeated execution, but it is not the end state for Celery operations. Production still should move toward:

- separate Web / Worker / Beat deployments
- disabling embedded Celery in production
- dedicated queues for knowledge indexing
- timeout handling, stale recovery, and monitoring metrics

Business protection is the safety net. Celery deployment hardening should still continue.
