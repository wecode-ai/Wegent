---
sidebar_position: 12
---

# Knowledge Indexing Protection

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

- `index_status`: `not_indexed | queued | indexing | success | failed`
- `index_generation`

`index_generation` is the key field. Every valid new indexing attempt gets a new generation. Any older task becomes stale automatically.

`not_indexed` is the explicit initial state. It separates "never indexed yet" from a real execution failure instead of overloading both into `failed`.

### 2. Business dedupe before enqueue

Before sending a Celery task, the orchestrator updates database state first:

- if the document is already `queued / indexing`, duplicate enqueue is skipped
- if `queued / indexing` has been stuck too long, a new request can take over with a new generation
- if the document is already `success`, normal retry requests are skipped
- only flows that explicitly need a new attempt create a new generation

Current policy:

- new document: create a new generation
- retry for failed document: create a new generation
- content update / web refresh: replace the active generation so old tasks become stale
- long-lived `queued / indexing`: allow takeover after stale detection based on `updated_at`

Current default thresholds:

- `queued` older than 10 minutes can be replaced by a new generation
- `indexing` older than 45 minutes can be replaced by a new generation

### 3. Final guard before worker execution

Before calling the embedding model, the Celery worker:

1. acquires a Redis distributed lock based on `document_id`
2. validates the current `index_generation` and `index_status` in the database

The task only executes when:

- the task generation matches the current database generation
- the current status is still `queued` or `indexing`

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
