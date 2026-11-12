---
sidebar_position: 13
---

# Knowledge query timing diagnostics

Knowledge Runtime logs retrieval stages with the `[KnowledgeTiming]` marker.
`request_id` correlates a query, `kb_id` identifies its knowledge base, and
`task_id` identifies the originating task when Backend supplies `X-Task-ID`.
The task header is diagnostic metadata and grants no permissions.
Context propagates into retrieval worker threads and is restored after each request.

## Stages

| Stage | Meaning |
| --- | --- |
| `query_total` | Complete runtime query, including configuration and aggregation |
| `config_resolution` | Resolve and validate retrieval configuration |
| `storage_backend_init` / `embedding_model_init` | Initialize retrieval objects |
| `worker_queue` | Time waiting for a retrieval worker to start |
| `retrieval_total` / `storage_retrieve` | Per-library retrieval and storage work |
| `vector_store_init` | Initialize the Elasticsearch vector store |
| `query_embedding` / `embedding_call` | Generate query vectors, including retries |
| `embedding_request` | One custom adapter HTTP request and response parsing |
| `embedding_attempt` / `embedding_retry` | Adapter attempt, delay and exception type |
| `search` | Elasticsearch search |
| `result_processing` / `retrieval_result` | Process results and report counts and thresholds |
| `hierarchical_merge` | Merge hierarchical retrieval results |
| `query_result` | Final runtime result count |

Completion events use `event=end` and milliseconds in `duration_ms`; errors use
`event=error` and record the exception type. Stages overlap, so their durations
must not be added together. A queued worker that never starts has no completed
`worker_queue` event.

INFO includes total time, configuration, backend initialization, worker queue,
embedding requests, search and result counts. Stage starts, normal first attempts,
and detailed overlapping stages use DEBUG. All stage errors use ERROR.
Adapter retry conditions, counts and backoff remain unchanged. SDK retries are
included in total call time rather than counted as adapter attempts.

## Finding a slow query

Filter logs by `task_id`, or find a `request_id` from the knowledge base ID and
time window, then inspect all entries for that request. A long `worker_queue`
points to worker capacity; long embedding stages point to the provider, network
or retries; a long `search` points to Elasticsearch.

Set `KNOWLEDGE_RUNTIME_LOG_LEVEL=DEBUG` before reproducing a problem to inspect
stage starts and detailed stages. Historical INFO logs cannot recover DEBUG
events. New timing logs omit query text, document contents, credentials, service
URLs and exception response bodies; existing query-plan logs are retained.
Client-session lifecycle problems require separate investigation.
