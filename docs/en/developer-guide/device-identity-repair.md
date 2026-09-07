---
sidebar_position: 90
---

# Wework identity and legacy records

## Rollout and data boundaries

No new database columns, unique index, manual cleanup SQL, or bulk migration are required.
Deploy the backend and frontend, then reconnect Wework to establish record-scoped online routes.
Complete the backend rollout before verifying: connections maintained by old servers do not exercise the new routing.
Normal registration and user-requested removal still update records through application APIs.

## Identity contract

- New Wework installations persist a UUIDv4 `device_id`. Restarts preserve it. Existing IDs, including `local-device`, and explicit configurations remain unchanged.
- `runtime_instance_id` identifies the persistent Runtime installation; `app_device_id` identifies its desktop IPC exposure.
- App records expose `execution_target_id` as `app-record-<primary key>` for exact routing. The UI still displays the registered device ID.
- Configuration creation is file-locked and atomically persisted. Corrupt or unwritable configuration fails explicitly; it never invents a shared fallback identity.

Registration matches the owner, default namespace, device ID, Runtime and IPC identities. Identical historical duplicates reuse a stable record; distinct installations retain separate records, online states and execution routes. Ambiguous identities are rejected, never guessed from display names.
An existing owner-row transaction lock serializes registration. A Redis lock covers the registration-to-online transition and deletion, without a schema change.

## Device removal and history

The card menu asks for confirmation and submits the record primary key. Wework, remote and local devices must be offline with no unfinished tasks to be removed. Only cloud devices may be removed while online or busy. Both deletion endpoints recheck ownership and these rules. Protected online or busy records return a conflict; foreign records return not found.
Removal only deactivates the selected registration. Task history and local files remain intact. Reconnecting the same installation can restore its record.

Historical task, project and default-device references are not bulk rewritten. A unique legacy ID resolves to its record. An ambiguous ID shared by different installations requires an explicit device choice; it must not silently launch on another installation. Removal is not an installation migration.

## QA and CI

Use isolated databases, Redis, users and Electron profiles, never production databases or personal Wework windows.

| Scenario | Expected result |
| --- | --- |
| Concurrent registration and reconnect | Three real Socket.IO registrations create one row; reconnect reuses its key |
| Legacy duplicates | Seed identical and distinct Runtime records sharing an ID; match exactly and isolate heartbeat and online states; keep app remote control disabled |
| Remove and restore | Reject online Wework and foreign removal; UI confirmation removes only the clicked offline row; reconnect restores its key |
| Device-type removal rules | Reject online Wework, remote and local deletion in menus and both APIs; allow confirmed online cloud removal; disable confirmation when a device reconnects |
| UUID persistence | UUIDv4 on first start; stable across restarts and concurrent startup; separate homes differ; legacy IDs remain; corrupt configuration fails |
| Historical references | Resolve unique old IDs without guessing ambiguous ones or rewriting task JSON |
| Conversation and desktop | Device-page chat response and follow-up; real desktop registration exposes a UUID and record route |

The platform chromium shards run `frontend/e2e/tests/devices/app-device-identity.spec.ts`.
The executor-chromium job runs the app conversation in `tasks/agent-conversation-regression.spec.ts`.
Desktop CI covers the existing shared-runner `remote-device-onboarding` checkpoint.
Unit tests cover ownership, unfinished-task protection, historical references and concurrent persistence.
Report actual execution results separately; adding coverage is not evidence that it passed.
