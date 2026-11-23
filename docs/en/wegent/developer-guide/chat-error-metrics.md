---
sidebar_position: 55
---

# Chat error classification and P0 metrics

Backend and Executor share wegent_protocol::chat_errors; Python execution paths
use shared.utils.error_classifier. Live events and persisted results carry
error_info with bounded code, category, stage and retry_policy. Web and desktop
cards show localized guidance and preserve raw details, manual retry and model selection.
P0 adds no automatic retries.

Specific business codes precede message matching. Legacy generic_error and
llm_error can be refined from explicit causes. Unknown codes become
generic_error/unknown in metrics. Quota exhaustion differs from rate limiting;
a bare 502 does not establish a timeout. Categories are
model/input/access/policy/runtime/tool/transport/platform/unknown.

Agent Skills directory contains unmanaged entries maps to
skills_unmanaged_entries/runtime/prepare/after_change. The directory and management
records disagree. Repair managed state before retrying; classification does not
remove entries or weaken directory protection. Retry policies are
after_backoff/after_change/none/unknown. Stages are
validate/dispatch/prepare/model/tool/stream/persist, with unknown where evidence is absent.

## Existing /metrics endpoint

The Rust Backend exposes three cumulative process counters alongside existing metrics:

```text
wegent_chat_runs_total{outcome,entrypoint,shell,execution_mode}
wegent_chat_run_failures_total{error_category,error_code,stage,entrypoint,shell,execution_mode}
wegent_chat_requests_total{outcome,entrypoint}
```

A run is one assistant execution attempt; multiple Bots count separately. Outcomes
are success/failed/cancelled, and request admission is accepted/rejected.
Entrypoints are web/wework/api/automation/other; shells are
Codex/ClaudeCode/Agno/Dify/Chat/unknown; execution modes are local/remote/unknown.
Resolved shells are stored as server metadata in the existing RUNNING write.
Terminal observation reads locked rows without additional Bot/Shell queries.
Unresolved context uses bounded unknown labels.

Only committed, guarded terminal transitions increment counters. Callback replay,
error followed by done, refresh and stale events do not count again. Resetting the
same assistant ID for manual retry creates another attempt. Outcome and cause
counters increment under one lock; scrapes never drain them. Client disconnects
do not force backend failure. Recovered intermediate errors are outside P0.

Coverage includes Rust admission, standard assistant completion, dispatch failure
and committed Wework runtime execution outcomes. HTTP admission starts inside
handlers, excluding authentication or JSON rejected beforehand by the framework.
Wework API admission is accepted after device confirmation, even when waiting for
output later fails. Pure local personal tasks without server execution records and
direct writes in Python-owned REST cancellation APIs are outside these counters;
P0 does not migrate those APIs.

Labels never contain task, response, user, device, custom model, path or raw error
values. Existing Redis TaskRunMetrics retain current-failed-state semantics.
Counters reset on restart. A crash between commit and increment can lose a count;
these are operational metrics rather than an accounting ledger. P0 adds no outbox
or database migration.

## Queries

Failures per second by cause:

```promql
sum by (error_category, error_code) (rate(wegent_chat_run_failures_total[5m]))
```

Failure ratio, excluding deliberate cancellations:

```promql
sum(rate(wegent_chat_runs_total{outcome="failed"}[5m]))
/ clamp_min(sum(rate(wegent_chat_runs_total{outcome=~"success|failed"}[5m])), 1e-9)
```

Skills conflicts in the last hour:

```promql
sum(increase(wegent_chat_run_failures_total{error_code="skills_unmanaged_entries"}[1h]))
```
