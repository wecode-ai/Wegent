---
sidebar_position: 28
---

# Wework stand-in telemetry

Stand-ins use the existing Wework telemetry boundary: `VITE_WEWORK_TELEMETRY_DISTRIBUTION=public` sends to PostHog with user consent; `internal` sends to registered DSH sinks without initializing the public SDK.

## Events and measurement

`wework/src/telemetry/registry/standInRegistry.json` is the source of truth. Generate types, runtime allowlists and the public catalog with `pnpm --filter wework telemetry:catalog`.

| Event | Meaning |
| --- | --- |
| `stand_in_opened` | Opening overview, settings, memory, conversation or work details; ordinary rerenders do not count again |
| `stand_in_configuration_succeeded/failed` | Confirmed settings writes; successful actions are derived from persisted configuration differences |
| `stand_in_conversation_succeeded/failed` | Runtime acceptance or rejection of an identity conversation message, including follow-ups |
| `stand_in_proposal_succeeded/failed` | Accepting or rejecting a configuration proposal; rolled-back draft validation creates no successful settings events |
| `stand_in_work_action_succeeded/failed` | Confirmation, reply, retry, split, merge, move, adjustment or undo |
| `stand_in_dispatch_succeeded/failed` | An actual dispatch attempt for each matching identity; existing tasks and duplicate notifications are not new dispatches |
| `stand_in_execution_started` | Actual execution start, deduplicated locally by task and native turn |
| `stand_in_execution_waiting` | Entering a state that requires user input or confirmation |
| `stand_in_execution_completed` | Confirmed execution end with `success`, `failure` or `cancelled`, plus Executor-measured `duration_ms` |

Dispatch acceptance is distinct from execution completion and business acceptance. A single configuration write can emit several distinct actions, so configuration action counts are not save-request counts. Failure stages use explicit error-code mappings, never model output or raw error text.

Public dimensions are bounded enums for domain, identity, surface, source, trigger, action, executor location, failure stage and result, plus bounded nonnegative duration. Identity is `unknown` when the operation cannot establish it. Executor location reuses the device catalog classification. Source distinguishes local projects, cloud projects, DingTalk, other connections and identity conversations. Account, device, task and identity IDs, names, messages, prompts, code, paths and credentials are excluded. Transport UUIDs are randomly generated rather than derived from business identifiers.

## Durable handoff

The Executor stores consent policy, pending facts and execution deduplication state in SQLite. Recording follows actual operations and Runtime transitions and does not depend on a stand-in page being open. Collection defaults to disabled; upgrading does not backfill historical tasks.

The main window polls the local and online executors every five seconds through existing device routing:

- `runtime.stand_in.telemetry.configure`: `userId`, `enabled`, and an optional UTC millisecond `enabledSince` boundary for public collection.
- `runtime.stand_in.telemetry.list`: up to 100 account-scoped facts with random `id`, original `occurredAt`, event name and allowed properties.
- `runtime.stand_in.telemetry.ack`: acknowledge up to 100 account-scoped UUIDs; repeated acknowledgements are idempotent.

The client persists each batch under distribution, account and device before acknowledging the Executor. It removes public records only after HTTP acceptance and retains failed deliveries. Replays preserve UUID, occurrence time and the anonymous installation identity captured during handoff. Because SDK `capture` only confirms in-memory enqueueing, the existing telemetry client uses the same SDK request router and receipt-capable transport for durable facts. SDK upgrades must verify this adapter. Internal sinks receive stable event IDs, and successful sinks are not called again when another sink fails.

Each queue retains at most 30 days and 10,000 records per account or account/device scope. Oldest records are discarded on expiry or overflow. Executor diagnostics include counts, not payloads. Window closure does not change Executor lifecycle: replay covers facts actually recorded while the Executor was running. Unconfirmed crash outcomes are not guessed.

Disabling public telemetry clears client queues; each Executor stops and clears its queue when next connected. Re-enabling updates the collection boundary, and reconnecting devices discard earlier facts so disabled-period data is not replayed. UTC boundaries assume synchronized device clocks.

This is durable, replayable delivery, not immediate exactly-once delivery. PostHog eventual deduplication requires matching UUID, event, timestamp and anonymous identity. Internal asynchronous sinks depend on their `accept` contract. Concurrent consumers of a remote queue with different installation identities cannot rely on PostHog to merge duplicate deliveries.

## Verification

Focused tests cover native-turn deduplication, completion/input ordering, retries, cancellation, consent, account isolation, pagination, idempotent ACK, configuration differences, rolled-back proposals, real Store transitions without a desktop subscriber, storage failures, lost ACK, transport failures and per-sink retry.

The CI-covered `stand-in-telemetry` desktop checkpoint uses a real Executor and local PostHog receiver. It verifies queue retention across window reload, repeated reads and ACK, actual conversation start/completion, and exclusion of a synthetic private prompt and business IDs. Only model responses are mocked. Run local E2E and `ai:verify` only when explicitly requested.
