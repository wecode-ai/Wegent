---
sidebar_position: 45
---

# Subscription completion callbacks

After persisting Task and assistant results, the Rust completion flow passes the final result, error and terminal status to the subscription handler. Task completion and subscription execution completion are separate writes. Updating only the Task leaves the automation timeline in `RUNNING`, allowing stale-execution cleanup to misclassify completed work as a timeout.

The event also retains the assistant subtask ID. The handler locks the Task and latest assistant round, verifies the callback's round, then reads the exact execution identified by the Task's execution label. A late callback cannot finish the latest active execution of a reused Task. Runtime cleanup rechecks the round after the status commit. Task-level streaming status is deleted atomically only when its subtask ID matches the callback.

## State and idempotency

The handler reads and locks the matching `background_executions` record in a writer transaction, validates the transition, and guards the update with its status and version. It commits the terminal status, UTC completion time, summary, error, subscription statistics and inbox result together. Duplicate terminal callbacks and version conflicts do not update counters, emit events or enqueue notifications again.

Silent completion becomes `COMPLETED_SILENT` without notifications. Ordinary subscriptions exclude silent runs from counters; Code Wiki scheduled checks retain their execution count. Cancellation sends no notification and resets the originating inbox message to unread with the model's empty subscription reference, `0`.

## Effects after completion

After committing, the handler emits `background:execution_update`. Successful and silent-success subscription executions reuse the executor-manager client to delete their sandbox or executor. Executor deletion must confirm deletion or absence (`success` / `not_found`) before marking the corresponding subtasks with `executor_deleted_at`. HTTP 200 containing `failed`, malformed responses and network errors do not confirm deletion. Cleanup failures log their full error chain without rolling back the terminal execution state.

The executor-manager client explicitly configures its socket-read timeout instead of inheriting Breeze's 400ms default. The read limit uses the longest existing operation budget, while each endpoint retains its original 30 / 60 / 120 / 180 second total request deadline. A Kubernetes deletion that responds within its operation budget must not leave a deleted Pod with a stale database flag because the client timed out early.

History-preserving subscriptions continue reusing the Task, while unified dispatch checks an old executor still marked available in the database. Only confirmed Pod absence causes the deletion flag to be persisted and the existing workspace recovery flow to run before dispatching the current assistant round. Device executors are excluded from Pod checks, and transport errors or inconclusive responses do not trigger recreation.

The Manager queue consumer requires both `status=success` and an executor name. Failed submissions that retain an old executor name enter the existing retry flow. Once retries are exhausted, the error callback finalizes the current assistant round and subscription execution instead of leaving them in `RUNNING`.

Success and failure notifications enqueue `app.tasks.subscription_completion_tasks.notify_execution` using the existing Celery protocol. The worker reads the committed execution and reuses follower preferences, channels and webhooks from the subscription notification dispatcher. It does not replay completion writes or runtime cleanup. Silent, cancelled and scheduled Code Wiki executions do not enqueue generic subscription notifications.

The producer uses `CELERY_BROKER_URL`, or application Redis when no separate broker is configured, and `CELERY_TASK_DEFAULT_QUEUE` (default `wegent_online`). An explicit broker connects on demand and retains its SDK connection. Failed initialization retains the configuration so a later new notification can reconnect without redirecting messages to cache Redis. Delivery remains best effort: previously failed messages are not replayed, and this flow adds neither a transactional outbox nor exactly-once delivery guarantees.

## Rollout and diagnosis

Update and start Backend Celery workers so they register the new task before enabling the Rust completion callback route. Updating the Rust process alone does not provide a notification consumer.

Runtime presence checks require the Python Backend update; submission failure callbacks require the Executor Manager update. Updating only the Backend image does not fix the Manager queue consumer.

Correlate execution and Task IDs across Task/assistant terminal states, `background_executions.status`, subscription counters, inbox results, cleanup flags, and finalization, cleanup and notification logs. `subscription notification enqueue failed` indicates publication failure; callback HTTP 200 does not prove notification delivery.

This flow does not automatically correct historical misclassifications or rerun completed Tasks.
