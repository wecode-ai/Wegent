---
sidebar_position: 38
---

# Project assistant hosting status design

This handoff provides a shared display component, a read-only projection adapter, synthetic prototypes, and an acceptance plan for “my assistant in this project.” It does not connect production pages, Backend APIs, device heartbeats, or assignment dispatch. It is not evidence of a shipped feature.

## User outcome and entry points

The project overview and assistant home should consume the same server snapshot for the current user, storage type, and project. Users can see whether hosting is enabled, its project and Tag scope, the current Tag match, endpoint availability, and the time of the latest verified receipt. Switching projects on assistant home must switch the complete context, including the receipt.

Current hosting settings and historical execution remain separate. Pausing hosting leaves a running historical assignment visibly running. Enabling affects new assignments only; it does not redispatch existing assignments. Pausing does not imply cancellation or completion of existing work.

Recovery actions lead to assistant settings, project rules, or the assignment receipt. The shared component invokes supplied handlers; design stories provide explicitly labeled demonstration feedback. Production callers must bind real destinations and explain permission failures.

## Loading, refresh, and failure

The self card and manager summary follow the same request lifecycle:

| Request state                                                 | Display and actions                                                                                                                     |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Initial load without a valid snapshot for the current context | Show synchronization in progress; do not display facts, receipts, or actions from another context                                       |
| Refresh with a valid snapshot for the same context            | Retain the last confirmed facts and historical receipt, with a refresh notice; a refresh is not a new heartbeat or acceptance receipt   |
| Refresh fails with a valid snapshot                           | Retain the last confirmed facts, explicitly identify them as a previous snapshot, and show the failure and a host-provided retry action |
| Initial request fails without a valid snapshot                | Show an explicit failure and retry; the manager view must also distinguish this from pending synchronization                            |
| Project or storage type changes                               | Immediately remove the old context's facts, receipt, and actions while awaiting the new data                                            |

Retry only invokes `onRetry`; it does not mutate hosting, endpoint, or execution state. Without a handler there is no inert button, and a pending request does not offer duplicate retries. Hosts must also isolate requests and caches by user, project, and data source, discarding late responses for a context that has been left. These display constraints do not replace server authorization.

Hosts must supply the current `projectScope: { projectStore, projectId }`. Self snapshots match it using their own project fields. Manager summaries retain the two-field DTO and associate the response with a project through a separate `statusScope`. Missing or mismatched identity hides response data and previous-snapshot actions. The component does not cache snapshots; hosts retain and pass the last same-context snapshot during refresh.

## Proposed contract and data boundaries

This is a proposed projection contract, not an existing published API. New Backend APIs must follow the repository’s Rust route ownership rules.

| Fields                        | Meaning                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `projectId`, `projectStore`   | Project identity and `local` / `cloud` storage; equal IDs do not imply equal projects                                       |
| `ownerUserId`, `roleId`       | Owner and role of the current user’s default assistant                                                                      |
| `enabled`, `scope`            | Hosting setting and project / Tag coverage                                                                                  |
| `tagMatch`, `currentTags`     | Server match result and Tags of the current Issue / assignment context; without an Issue context, the match remains unknown |
| `endpointRef`, `availability` | Client-safe endpoint reference and heartbeat-derived availability, without secrets or local paths                           |
| `reasonCode`, `dispatchable`  | Unavailability reason and explicit server dispatchability; clients do not infer it from settings                            |
| `version`, `source`           | Versioned snapshot and source marker; missing or invalid snapshots remain pending synchronization                           |
| `receipt`, `lastReceiptAt`    | Receipt bound to a human assignment and runtime task; `receivedAt` is the single receipt time source                        |

A receipt requires `humanAssignmentId` and runtime device and task references. A notification, an unbound timestamp, or a client action does not prove acceptance. Without valid bindings, receipt time remains unknown. Results continue to reference `deliveryRef` / `traceRef`; string references alone do not prove a valid delivery. Production servers must verify ownership, access, and delivered status.

The manager view directly consumes the minimal `{ dispatchable, availability }` summary. It must not require another member’s full owner snapshot. The adapter whitelists owner and nested fields, discarding private prompts, memory, transcripts, authentication data, and local paths. This minimizes display data; production still requires server authorization and isolation between users.

## Reasons and execution states

| Reason               | Visible explanation                     | Recovery destination |
| -------------------- | --------------------------------------- | -------------------- |
| `not_enabled`        | Hosting is not enabled for this project | Assistant settings   |
| `tag_mismatch`       | Current Tags are outside hosting scope  | Project rules        |
| `device_offline`     | Execution endpoint is offline           | Assistant settings   |
| `permission_revoked` | Project access was revoked              | Project rules        |
| `execution_failed`   | The latest execution failed             | Assignment receipt   |

Assignment states remain independent: `queued`, `waiting_device`, `blocked_policy`, `running`, `completed`, and `failed`. Unknown availability must not appear online. An unknown reason remains pending synchronization, without inventing success or a generic empty state. A `completed` assignment without `deliveryRef` displays “Completion evidence pending” rather than successful completion.

## Public design handoff

Source lives in `packages/collaboration/src/project-assistant-status/`; the registry descriptor is `packages/collaboration/design-system/project-assistant-status.json`. The module stays independent of production pages and adds no API, persistence, or dispatch path.

Roster CRUD, assistant capability matching, and device migration are outside this scope. The design does not automatically join projects or enable hosting for all projects.

Local CSF stories provide 30 states covering both entry points, five unavailability reasons, six assignment states, paused hosting with historical running work, missing delivery evidence, no receipt, unknown, initial loading, refresh, failure and retry for self and manager views, manager summary, feature off, compact layout, and theme review. All data is synthetic. Every state uses the same shared component and theme structure, with caller-supplied copy.

The full Storybook build environment remains in the design reference repository. This repository provides importable CSF stories and renders them in existing collaboration tests. Component and contract tests do not replace visual approval or production acceptance.

Run from the repository root; these commands also work in Windows terminals:

```sh
pnpm --filter @wegent/collaboration build
pnpm --filter @wegent/collaboration test src/project-assistant-status
```

## Subsequent acceptance

| Scenario                         | Expected result and evidence                                                                                                                                                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hosting enabled for this project | Both entry points use the same snapshot and display scope, Tag match, availability, and canonical receipt time                                                                                           |
| Assigned but not started         | A specific reason and real recovery action appear; matching rules still create a visible assignment when the assistant is unavailable                                                                    |
| Offline endpoint recovers        | Server projects waiting_device, then starts one execution and binds its receipt to the original human assignment and runtime task                                                                        |
| New assignment after pausing     | The project overview immediately shows paused; no new default-assistant execution; historical records and running work follow the existing policy                                                        |
| Manager reads member summary     | Server returns only dispatchability and availability, without private configuration or transcripts                                                                                                       |
| Requests and retry               | Self and manager views distinguish initial load, refresh, and failure; same-context refresh retains facts, failures offer retry, and project or local/cloud switches never display previous-context data |

Production verification must cover idempotency, revoked access, Tag and project isolation, stale snapshots and recovery, plus 1440 / 900 / 390 viewports, keyboard navigation, and screen readers. This design PR does not complete real heartbeat, dispatch, server ACL, or full viewport visual acceptance.

Production callers should gate display with `collab.hostingStatus.v1`. Disabling it hides the cards while preserving endpoint settings, assignments, and historical receipts. Observability should report zero matching assignments without visible unavailability reasons, zero completed displays without a delivery, and zero disclosures of another user’s private data.
