---
sidebar_position: 20
---

# Rust background jobs and cutover verification

`brz-schedule` supplies durable execution, periodic triggers, retries, continuations, leases and cooperative shutdown. Its core depends on provider contracts; the Redis implementation is a separate `brz-schedule-redis` package. Wegent owns job registration, business lock keys, SQL, authorization and external protocols. Existing MySQL business rows and Redis cursors remain in place; Celery's internal state machine is not migrated.

## Deployment and execution scope

| Setting | Default | Meaning |
| --- | --- | --- |
| `SCHEDULED_TASKS_ENABLED` | `true` | Produce periodic and startup jobs allowed by this Rust process's allowlist |
| `EMBEDDED_CELERY_ENABLED` | `true` | Enable this Rust process's native worker to consume allowed durable jobs |
| `WEGENT_RS_JOB_ALLOWLIST` | Empty | Limit Rust execution to comma-separated full kinds; no `*`; unknown names fail startup |
| `WEGENT_RS_JOBS_SHUTDOWN_GRACE_SECONDS` | `30` | Cooperative drain period after claims stop |

Rust reuses Python's existing switch names and defaults. In Rust, `EMBEDDED_CELERY_ENABLED` controls only the native worker in this process; it does not start Celery. An empty allowlist prevents Rust from producing or consuming jobs even though both switches default to `true`. An API-only Rust process may configure an allowlist and set both runtime switches to `false`.

The allowlist limits Rust execution without reserving task types exclusively. Python retains all existing Celery publishing and consumption, does not read this allowlist, and does not forward tasks to Rust. Configure the same-named switches separately for each process, and avoid scheduling the same execution family concurrently in Python and Rust.

Public jobs run in `backend-rs`. Deployment-specific jobs and video extensions are injected and registered by the embedding application. Existing business feature flags remain effective, including external document sync, DingTalk auto-sync, internal notifications and alerts. The Rust allowlist does not bypass them.

Durable timestamps use UTC. Cron has an explicit timezone: Python Beat uses UTC, project automation uses its resource timezone and DOM/DOW Or, and APScheduler-style Cron uses DOM/DOW And. The application registers startup behavior, initial delays, start deadlines and business locks.

## Business coverage

This table groups execution families. Exact kinds are defined by the public and internal registration functions. Active route tables remain the sole inventory of HTTP API ownership.

| Family | Entry points and verification |
| --- | --- |
| Subscriptions | Due scan, execution, scheduled CodeWiki update; verify Task/Workspace creation, history reuse, execution records, inbox and completion notifications |
| Project automation | Due scan, incoming event, pending event, event subscription and managed execution; verify event/run deduplication, revoked permissions, collaboration groups and runtime continuation |
| Robot queue | Five-second scans and start deadlines; verify reservations, revoked access cancellation, abandoned claims, stalled output, terminal and revision projections |
| Knowledge processing | Index, external import, document summary, KB summary, stale scan and orphan cleanup; verify generations, converter callbacks, previous-body snapshots and late writes |
| External sync | Daily Wiki cursor, DingTalk scan/refresh and Xiaoxin snapshot; verify source health, non-retryable versions, permissions and cached counts |
| Video and async cards | Provider creation, durable polling, cancellation, upload, Socket.IO and two startup recovery passes; waiting does not consume the failure budget |
| Plugin mirrors | Six-hour sync of explicitly enabled upstreams; verify HTTPS/ZIP safety, immutable versions, review, latest version and administrator delisting |
| Public maintenance | `repository_update`, `executor_cleanup`, `device_heartbeat_monitor`; verify cache refresh, archive before deletion, existing Redis cursors and disconnected devices |
| Internal maintenance | Hourly unread, daily summary email, grading, orphan pods, cloud devices/IP sync and OpenClaw tokens; verify original flags, alert deduplication, archive, timeout and internal protocols |

The Python source has no reachable server consumer for managed Team queue entries. This migration preserves that boundary. Managed execution of an existing Task continues through its original task entry point.

## Data and failure contracts

Business tables, Task/Subtask JSON, document generations, existing cursors, cancellation markers and complete business lock keys remain compatible. Native Rust job storage uses the separate `wegent:rs:schedule:v1` namespace. Python tasks continue to use their existing Celery queues. Rust workers neither consume those queues nor parse Celery messages, and Celery workers do not consume the native Rust job store.

Delivery is at least once. Provider owner tokens protect acknowledgement and renewal; the independent `LockProvider` compares tokens before renewal and release. Locks cannot retract external effects already accepted by another system. SQL claims, generation guards, event identity and business status checks therefore remain necessary. Redis errors propagate to runtime supervision without switching to memory storage.

Normal polling persists a `ContinueAt` timestamp and payload. Failed attempts have a separate retry budget. Start deadlines restrict queued execution; application settings govern execution timeouts. Resident maintenance can omit an overall timeout while retaining HTTP limits, business lease renewal and shutdown cancellation. Shutdown stops production and claims, drains cooperative handlers, then leaves unfinished claims unacknowledged for lease recovery.

## Manual verification and scheduler selection

1. Deploy with an empty allowlist and verify normal startup. Both existing switches default to `true`; the empty allowlist still prevents Rust jobs from running.
2. Choose the scheduling process for each execution family, avoiding concurrent Python and Rust scheduling. Before selecting Rust, pause the corresponding Python periodic producer or resident loop through deployment configuration and drain old Celery queued, reserved and active work. The Rust allowlist does not stop Python Beat or APScheduler or restrict the task types Python accepts.
3. Configure the full kinds to verify only in the selected Rust deployment's allowlist. Video recovery requires both `video.recover_jobs` and `app.tasks.video_tasks.poll_video_job`. Python needs no allowlist and no exclusions for task types Rust supports.
4. Start a Rust worker with `EMBEDDED_CELERY_ENABLED=true`, then set `SCHEDULED_TASKS_ENABLED=true` in the selected scheduling process. One process may enable both; for staged startup, explicitly disable scheduling first. Check triggers, business results, notifications and observable failures.
5. Terminate a worker using disposable data and verify restart recovery. Test duplicate delivery and stale generations for video, external documents and project events.
6. To stop Rust scheduling, set `SCHEDULED_TASKS_ENABLED=false` for that Rust process, keep its worker alive until native work drains, then empty its allowlist or stop the worker. Restore Python scheduling as needed; its Celery queues require no migration to Rust. Do not discard durable queues or flush Redis to simulate draining.

## Verification

The library runs shared provider contracts, memory and real Redis checks, runtime concurrency/shutdown tests and Cron tests. Wegent business tests run with `cargo test --lib background_jobs`. CI explicitly executes isolated MySQL transaction tests for concurrent claims, generations, rollback, snapshots and project run projections. Internal unit tests run in `backend-rs-intra`.

These checks validate scheduling and persistence contracts. SMTP, IM, video providers, the knowledge runtime, Kubernetes and internal device services still require manual verification with test accounts. This migration does not automatically enable production jobs.
