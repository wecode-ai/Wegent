---
sidebar_position: 32
---

# Xiaoxin HR Knowledge Sync Release and Verification

Xiaoxin HR knowledge sync projects the authoritative full snapshot into one external
`FAQ.md` in a fixed knowledge base. Initialization, notifications, and the daily
fallback reuse the same fixed-target service and existing external import, attachment,
and indexing pipeline.

## Configuration

The Xiaoxin app ID is fixed to `robot` in code. Configure the environment-specific
pull URL and inject the following values through runtime environment variables:

```dotenv
XIAOXIN_SYNC_ENABLED=true
XIAOXIN_SYNC_TOKEN=<notification-bearer-token>
XIAOXIN_KNOWLEDGE_PULL_URL=<xiaoxin-environment-pull-url>
XIAOXIN_SIGN_SECRET=<xiaoxin-sign-secret>
XIAOXIN_TARGET_KB_ID=<knowledge-base-id>
XIAOXIN_SYNC_USER_ID=<sync-user-id>
```

The sync user must be active and able to manage documents in the active target
knowledge base, which must have RAG configuration. The existing Beat dispatches
`app.tasks.xiaoxin_knowledge_tasks.sync_xiaoxin_hr_knowledge` daily at 03:00
Asia/Shanghai (19:00 UTC). If multiple instances trigger together, the Redis
distributed lock allows only one to submit the sync.

## Initialization

After configuration, initialize through the notification endpoint so no second publish
path is introduced. This example contains placeholders only:

```bash
curl --request POST 'https://<wegent-host>/api/integrations/xiaoxin/knowledge-sync/notify' \
  --header 'Authorization: Bearer <notification-bearer-token>' \
  --header 'Content-Type: application/json' \
  --data '{
    "domains": ["HR"],
    "sync_time": "2026-08-31 09:00:00",
    "operator": "<operator>",
    "pull_api": "https://<compatibility-only-placeholder>"
  }'
```

HTTP 202 means the refresh was submitted or the same document was already processing;
it does not mean pull and indexing have completed. The request `pull_api` is accepted
for protocol compatibility only. Wegent always calls the configured
`XIAOXIN_KNOWLEDGE_PULL_URL`.

## Operations

Locate the unique document by `provider=xiaoxin`, `external_resource_id=HR`, and the
target knowledge base. Reuse the existing `index_status`, `index_generation`,
`processing_error`, and `is_active` fields plus external metadata `source_total`,
`filtered_count`, and `generated_qa_count`.

Sync submission logs record `trigger_source=notification|daily`. Correlate asynchronous
pull, projection, and indexing by request time, document ID, `index_generation`, and
existing status fields. Logs include counts, durations, failure stage, and stable error
code without tokens, signatures, full responses, or answer bodies.

## Phase-one release boundary

- A refresh temporarily makes the old document unavailable. Phase one is not atomic
  publication or continuous availability.
- Pull, conversion, or indexing failures use the existing `FAILED` state and do not
  roll back to the previous generation.
- The next notification or daily run retries the same external document. The missed
  notification fallback boundary is approximately 24 hours.
- A notification received during active processing does not enqueue a second task.
- No lock, dirty flag, event table, compensation queue, sync history table, or admin
  page is introduced.
- Xiaoxin supplies knowledge-level `updated_at`. Every FAQ block displays that
  authoritative update time; region or employee expansions reuse the source
  knowledge item's timestamp.

## Release verification

Before release, pass focused Xiaoxin tests, affected external import/indexing
regressions, Black, isort, and `git diff --check`. After initialization, verify that
only one external `FAQ.md` exists, the `商保体检` and `ER政策法规` categories are absent,
every FAQ block contains its update time, and the document reaches `SUCCESS`. Also
verify that failures remain observable and a later notification or daily run advances
a new generation on the same document.
