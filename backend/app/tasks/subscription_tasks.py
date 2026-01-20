# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for Subscription Scheduler.

This module contains the Celery tasks for:
1. check_due_subscriptions - Periodic task that checks for subscriptions due for execution
2. execute_subscription_task - Task that executes a single subscription

The architecture separates trigger from execution:
- check_due_subscriptions runs every minute, finds due subscriptions, dispatches execute_subscription_task
- execute_subscription_task runs asynchronously, handles AI response, updates status
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Optional, Tuple

from celery.exceptions import SoftTimeLimitExceeded
from prometheus_client import Counter, Histogram
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings

logger = logging.getLogger(__name__)

# Prometheus metrics
SUBSCRIPTION_EXECUTIONS_TOTAL = Counter(
    "subscription_executions_total",
    "Total subscription executions",
    ["status", "trigger_type"],
)
SUBSCRIPTION_EXECUTION_DURATION = Histogram(
    "subscription_execution_duration_seconds",
    "Subscription execution duration in seconds",
    buckets=[10, 30, 60, 120, 300, 600],
)
SUBSCRIPTION_QUEUE_SIZE = Counter(
    "subscription_tasks_queued_total",
    "Total subscription tasks queued for execution",
)


# ========== Data Classes for Subscription Execution ==========


@dataclass
class SubscriptionExecutionContext:
    """Context object containing all data needed for subscription execution."""

    subscription: Any  # Kind (Subscription)
    subscription_crd: Any  # Subscription CRD
    execution: Any  # BackgroundExecution
    team: Any  # Kind (Team)
    user: Any  # User
    trigger_type: str
    workspace_info: "WorkspaceInfo"
    # History preservation settings
    preserve_history: bool = False
    history_message_count: int = 10
    bound_task_id: int = 0


@dataclass
class WorkspaceInfo:
    """Workspace-related information for task creation."""

    git_url: str = ""
    git_repo: str = ""
    git_repo_id: int = 0
    git_domain: str = ""
    branch_name: str = ""


@dataclass
class SubscriptionTaskResult:
    """Result of a subscription task creation."""

    task: Any
    user_subtask: Any
    assistant_subtask: Any


# ========== Helper Functions ==========


def _load_subscription_execution_context(
    db: Session,
    subscription_id: int,
    execution_id: int,
) -> Optional[SubscriptionExecutionContext]:
    """
    Load all required entities for subscription execution.

    Returns None if any required entity is not found.
    """
    from app.core.constants import KIND_TEAM
    from app.models.kind import Kind
    from app.models.subscription import BackgroundExecution
    from app.models.task import TaskResource
    from app.models.user import User
    from app.schemas.subscription import Subscription

    # Get subscription (stored in kinds table)
    subscription = (
        db.query(Kind)
        .filter(
            Kind.id == subscription_id,
            Kind.kind == "Subscription",
            Kind.is_active == True,
        )
        .first()
    )
    if not subscription:
        logger.error(f"[subscription_tasks] Subscription {subscription_id} not found")
        return None

    subscription_crd = Subscription.model_validate(subscription.json)
    internal = subscription.json.get("_internal", {})
    trigger_type = internal.get("trigger_type", "unknown")

    # Get execution record
    execution = (
        db.query(BackgroundExecution)
        .filter(BackgroundExecution.id == execution_id)
        .first()
    )
    if not execution:
        logger.error(f"[subscription_tasks] Execution {execution_id} not found")
        return None

    # Get team
    team_id = internal.get("team_id")
    team = (
        db.query(Kind)
        .filter(Kind.id == team_id, Kind.kind == KIND_TEAM, Kind.is_active == True)
        .first()
    )
    if not team:
        logger.error(
            f"[subscription_tasks] Team {team_id} not found for subscription {subscription.id}"
        )
        return None

    # Get user
    user = db.query(User).filter(User.id == subscription.user_id).first()
    if not user:
        logger.error(
            f"[subscription_tasks] User {subscription.user_id} not found for subscription {subscription.id}"
        )
        return None

    # Get workspace info
    workspace_id = internal.get("workspace_id")
    workspace_info = _load_workspace_info(db, workspace_id)

    # Extract history preservation settings from Subscription CRD
    preserve_history = getattr(subscription_crd.spec, "preserveHistory", False)
    history_message_count = getattr(subscription_crd.spec, "historyMessageCount", 10)
    bound_task_id = internal.get("bound_task_id", 0) or 0

    return SubscriptionExecutionContext(
        subscription=subscription,
        subscription_crd=subscription_crd,
        execution=execution,
        team=team,
        user=user,
        trigger_type=trigger_type,
        workspace_info=workspace_info,
        preserve_history=preserve_history,
        history_message_count=history_message_count,
        bound_task_id=bound_task_id,
    )


def _load_workspace_info(db: Session, workspace_id: Optional[int]) -> WorkspaceInfo:
    """Load workspace information if workspace_id is specified."""
    from app.core.constants import KIND_WORKSPACE
    from app.models.task import TaskResource

    if not workspace_id:
        return WorkspaceInfo()

    workspace = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == workspace_id,
            TaskResource.kind == KIND_WORKSPACE,
            TaskResource.is_active == True,
        )
        .first()
    )

    if not workspace:
        return WorkspaceInfo()

    ws_json = workspace.json
    repo = ws_json.get("spec", {}).get("repository", {})

    return WorkspaceInfo(
        git_url=repo.get("gitUrl", ""),
        git_repo=repo.get("gitRepo", ""),
        git_repo_id=repo.get("gitRepoId", 0),
        git_domain=repo.get("gitDomain", ""),
        branch_name=repo.get("branchName", ""),
    )


def _generate_task_title(
    subscription_crd: Any, subscription_name: str, prompt: Optional[str]
) -> str:
    """Generate a task title from subscription information."""
    subscription_display_name = subscription_crd.spec.displayName or subscription_name
    task_title = f"[Subscription] {subscription_display_name}"

    if prompt:
        prompt_preview = prompt[:50]
        if len(prompt) > 50:
            prompt_preview += "..."
        task_title = f"[Subscription] {subscription_display_name}: {prompt_preview}"

    return task_title


def _bind_task_to_subscription(db: Session, subscription: Any, task_id: int) -> None:
    """
    Bind a task to a subscription for history preservation.

    Args:
        db: Database session
        subscription: Kind (Subscription) to update
        task_id: Task ID to bind
    """
    from sqlalchemy.orm.attributes import flag_modified

    internal = subscription.json.get("_internal", {})
    internal["bound_task_id"] = task_id
    subscription.json["_internal"] = internal
    flag_modified(subscription, "json")
    db.commit()
    logger.info(
        f"[subscription_tasks] Bound task {task_id} to subscription {subscription.id} for history preservation"
    )


async def _create_subscription_task(
    db: Session,
    ctx: SubscriptionExecutionContext,
    task_title: str,
) -> Optional[SubscriptionTaskResult]:
    """
    Create task and subtasks for subscription execution.

    Uses the unified create_chat_task function.
    Note: Subscription identification is done via labels (type='subscription') set in _add_subscription_labels_to_task,
    not via the source parameter.

    When preserve_history is enabled:
    - If bound_task_id exists and is valid, reuse that task (pass task_id parameter)
    - Otherwise create a new task and bind it to the subscription
    - The system will automatically load history via initialize_redis_chat_history
    """
    from app.models.task import TaskResource
    from app.services.chat.storage import TaskCreationParams, create_chat_task

    ws = ctx.workspace_info

    # Extract model_id from Subscription CRD's modelRef if specified
    model_id = None
    force_override_bot_model = False
    if ctx.subscription_crd.spec.modelRef:
        model_id = ctx.subscription_crd.spec.modelRef.name
        force_override_bot_model = (
            ctx.subscription_crd.spec.forceOverrideBotModel or False
        )

    # Determine if we should reuse an existing task for history preservation
    reuse_task_id = None
    if ctx.preserve_history and ctx.bound_task_id > 0:
        # Check if the bound task still exists and is valid
        bound_task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == ctx.bound_task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active == True,
            )
            .first()
        )

        if bound_task:
            reuse_task_id = ctx.bound_task_id
            logger.info(
                f"[subscription_tasks] Reusing bound task {ctx.bound_task_id} for subscription {ctx.subscription.id} "
                f"(preserve_history=True)"
            )
        else:
            logger.warning(
                f"[subscription_tasks] Bound task {ctx.bound_task_id} not found or inactive, "
                f"will create new task for subscription {ctx.subscription.id}"
            )

    params = TaskCreationParams(
        message=ctx.execution.prompt or "",
        title=task_title,
        model_id=model_id,
        force_override_bot_model=force_override_bot_model,
        is_group_chat=False,
        git_url=ws.git_url,
        git_repo=ws.git_repo,
        git_repo_id=ws.git_repo_id,
        git_domain=ws.git_domain,
        branch_name=ws.branch_name,
    )

    result = await create_chat_task(
        db=db,
        user=ctx.user,
        team=ctx.team,
        message=ctx.execution.prompt or "",
        params=params,
        task_id=reuse_task_id,  # Reuse existing task if available
        should_trigger_ai=True,
        rag_prompt=None,
    )

    if not result.task:
        logger.error(
            f"[subscription_tasks] Failed to create task for subscription {ctx.subscription.id}"
        )
        return None

    # If preserve_history is enabled and we created a new task, bind it to the subscription
    if ctx.preserve_history and reuse_task_id is None:
        _bind_task_to_subscription(db, ctx.subscription, result.task.id)

    return SubscriptionTaskResult(
        task=result.task,
        user_subtask=result.user_subtask,
        assistant_subtask=result.assistant_subtask,
    )


def _add_subscription_labels_to_task(
    db: Session,
    task: Any,
    subscription_id: int,
    execution_id: int,
    supports_direct_chat: bool = False,
) -> None:
    """Add subscription-specific labels to the task.

    Sets:
    - type='subscription': Mark this as a Subscription-triggered task
    - userInteracted='false': Task hidden from history until user interacts
    - subscriptionId: Associated Subscription ID
    - executionId/backgroundExecutionId: Associated execution record ID

    Args:
        db: Database session
        task: Task resource
        subscription_id: Subscription ID
        execution_id: Execution ID
        supports_direct_chat: Not used anymore. Kept for backward compatibility.
    """
    from app.core.constants import (
        LABEL_BACKGROUND_EXECUTION_ID,
        LABEL_EXECUTION_ID,
        LABEL_SUBSCRIPTION_ID,
    )
    from app.schemas.kind import Task

    task_crd = Task.model_validate(task.json)
    if task_crd.metadata.labels:
        # Subscription task identification
        task_crd.metadata.labels["type"] = "subscription"
        task_crd.metadata.labels["userInteracted"] = "false"
        # Subscription-specific labels
        task_crd.metadata.labels[LABEL_SUBSCRIPTION_ID] = str(subscription_id)
        task_crd.metadata.labels[LABEL_EXECUTION_ID] = str(execution_id)
        task_crd.metadata.labels[LABEL_BACKGROUND_EXECUTION_ID] = str(execution_id)
    task.json = task_crd.model_dump(mode="json")
    db.commit()


def _link_task_to_execution(db: Session, execution: Any, task_id: int) -> None:
    """Link task to execution and update execution status to RUNNING."""
    from app.schemas.subscription import BackgroundExecutionStatus

    execution.task_id = task_id
    execution.status = BackgroundExecutionStatus.RUNNING.value
    execution.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


async def _trigger_chat_shell_response(
    ctx: SubscriptionExecutionContext,
    task: Any,
    assistant_subtask: Any,
    user_subtask: Any,
) -> None:
    """
    Trigger AI response for Chat Shell type subscriptions.

    Uses circuit breaker to protect against AI service failures.
    """
    from app.core.circuit_breaker import (
        CircuitBreakerOpenError,
        ai_service_breaker,
        with_circuit_breaker_async,
    )
    from app.core.constants import get_task_room
    from app.schemas.subscription import SubscriptionTriggerPayload
    from app.services.chat.trigger import trigger_ai_response
    from app.services.chat.trigger.emitter import SubscriptionEventEmitter

    # Extract model override from Subscription CRD's modelRef if specified
    override_model_name = None
    if ctx.subscription_crd.spec.modelRef:
        override_model_name = ctx.subscription_crd.spec.modelRef.name

    payload = SubscriptionTriggerPayload(
        force_override_bot_model=override_model_name,
    )
    task_room = get_task_room(task.id)
    subscription_emitter = SubscriptionEventEmitter(execution_id=ctx.execution.id)

    # Determine history_limit based on preserve_history setting
    # If preserve_history is enabled, use the configured history_message_count
    # Otherwise, pass None to use default behavior (no history limit)
    history_limit = ctx.history_message_count if ctx.preserve_history else None
    logger.info(
        f"[subscription_tasks] History settings: preserve_history={ctx.preserve_history}, "
        f"history_message_count={ctx.history_message_count}, history_limit={history_limit}"
    )

    # Wrap the AI call with circuit breaker protection
    @with_circuit_breaker_async(ai_service_breaker)
    async def _call_ai_service():
        await trigger_ai_response(
            task=task,
            assistant_subtask=assistant_subtask,
            team=ctx.team,
            user=ctx.user,
            message=ctx.execution.prompt or "",
            payload=payload,
            task_room=task_room,
            supports_direct_chat=True,
            namespace=None,
            user_subtask_id=user_subtask.id if user_subtask else None,
            event_emitter=subscription_emitter,
            history_limit=history_limit,
        )

    try:
        await _call_ai_service()
    except CircuitBreakerOpenError as e:
        logger.error(
            f"[subscription_tasks] Circuit breaker open for subscription {ctx.subscription.id}: {e}"
        )
        # Update execution with circuit breaker error
        from app.db.session import get_db_session
        from app.schemas.subscription import BackgroundExecutionStatus
        from app.services.subscription import subscription_service

        with get_db_session() as db:
            subscription_service.update_execution_status(
                db,
                execution_id=ctx.execution.id,
                status=BackgroundExecutionStatus.FAILED,
                error_message=f"AI service temporarily unavailable: {e}",
            )
        raise


def _handle_execution_failure(
    db: Session,
    execution_id: int,
    error_message: str,
    trigger_type: str,
) -> Dict[str, Any]:
    """Handle execution failure by updating status and recording metrics."""
    from app.schemas.subscription import BackgroundExecutionStatus
    from app.services.subscription import subscription_service

    subscription_service.update_execution_status(
        db,
        execution_id=execution_id,
        status=BackgroundExecutionStatus.FAILED,
        error_message=error_message,
    )
    SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
        status="failed", trigger_type=trigger_type
    ).inc()
    return {"status": "error", "message": error_message}


# ========== Celery Tasks ==========


# Batch size for processing due subscriptions (to avoid memory issues with large datasets)
SUBSCRIPTION_BATCH_SIZE = 100

# Lock timeout for check_due_subscriptions (should be longer than expected execution time)
CHECK_DUE_SUBSCRIPTIONS_LOCK_TIMEOUT = 120  # seconds


@celery_app.task(bind=True, name="app.tasks.subscription_tasks.check_due_subscriptions")
def check_due_subscriptions(self):
    """
    Periodic task that checks for subscriptions due for execution.

    This task:
    1. Acquires a distributed lock to avoid duplicate processing across instances
    2. Recovers any stale PENDING executions from previous runs
    3. Queries for enabled subscriptions with next_execution_time <= now (in batches)
    4. Creates execution records and dispatches execute_subscription_task for each
    5. Updates next_execution_time for recurring subscriptions

    Runs every FLOW_SCHEDULER_INTERVAL_SECONDS (default: 60 seconds).
    """
    from app.core.distributed_lock import distributed_lock
    from app.db.session import get_db_session
    from app.models.kind import Kind
    from app.schemas.subscription import Subscription, SubscriptionTriggerType
    from app.services.subscription import subscription_service

    logger.info("[subscription_tasks] Starting check_due_subscriptions cycle")

    # Acquire distributed lock to prevent multiple instances from processing
    with distributed_lock.acquire_context(
        "check_due_subscriptions", expire_seconds=CHECK_DUE_SUBSCRIPTIONS_LOCK_TIMEOUT
    ) as acquired:
        if not acquired:
            logger.info(
                "[subscription_tasks] Another instance is already running check_due_subscriptions, skipping"
            )
            return {"status": "skipped", "reason": "lock_held_by_another_instance"}

        with get_db_session() as db:
            try:
                # First, recover any orphaned PENDING executions
                recovered = _recover_stale_pending_executions(db)

                # Then, cleanup any stale RUNNING executions
                cleaned_running = _cleanup_stale_running_executions(db)

                # Use UTC for comparison since next_execution_time is stored in UTC
                now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

                # Query all active subscriptions
                all_subscriptions = (
                    db.query(Kind)
                    .filter(
                        Kind.kind == "Subscription",
                        Kind.is_active == True,
                    )
                    .all()
                )

                # Filter due subscriptions based on _internal fields
                due_subscriptions = []
                for sub in all_subscriptions:
                    internal = sub.json.get("_internal", {})
                    if not internal.get("enabled", True):
                        continue

                    trigger_type = internal.get("trigger_type")
                    if trigger_type not in [
                        SubscriptionTriggerType.CRON.value,
                        SubscriptionTriggerType.INTERVAL.value,
                        SubscriptionTriggerType.ONE_TIME.value,
                    ]:
                        continue

                    next_exec_time_str = internal.get("next_execution_time")
                    if not next_exec_time_str:
                        continue

                    try:
                        next_exec_time = datetime.fromisoformat(next_exec_time_str)
                        if next_exec_time <= now_utc:
                            due_subscriptions.append(sub)
                    except (ValueError, TypeError):
                        continue

                total_due = len(due_subscriptions)

                if total_due == 0:
                    logger.debug(
                        "[subscription_tasks] No subscriptions due for execution"
                    )
                    return {
                        "due_subscriptions": 0,
                        "dispatched": 0,
                        "recovered_pending": recovered,
                        "cleaned_running": cleaned_running,
                    }

                logger.info(
                    f"[subscription_tasks] Found {total_due} subscription(s) due for execution"
                )

                # Process in batches to avoid memory issues
                dispatched = 0
                offset = 0

                # Track last lock extension time for watchdog pattern
                import time

                last_lock_extend_time = time.time()
                LOCK_EXTEND_INTERVAL = 30  # Extend lock every 30 seconds

                while offset < total_due:
                    batch = due_subscriptions[offset : offset + SUBSCRIPTION_BATCH_SIZE]

                    if not batch:
                        break

                    for idx, subscription in enumerate(batch):
                        # Watchdog: extend lock periodically during processing
                        current_time = time.time()
                        if current_time - last_lock_extend_time >= LOCK_EXTEND_INTERVAL:
                            distributed_lock.extend(
                                "check_due_subscriptions",
                                expire_seconds=CHECK_DUE_SUBSCRIPTIONS_LOCK_TIMEOUT,
                            )
                            last_lock_extend_time = current_time
                            logger.debug(
                                f"[subscription_tasks] Extended lock during batch processing "
                                f"(processed {offset + idx}/{total_due})"
                            )
                        try:
                            subscription_crd = Subscription.model_validate(
                                subscription.json
                            )
                            internal = subscription.json.get("_internal", {})
                            trigger_type = internal.get("trigger_type")

                            # Determine trigger reason
                            trigger_reason = _get_trigger_reason(
                                subscription_crd, trigger_type
                            )

                            # Create execution record
                            execution = subscription_service.create_execution(
                                db,
                                subscription=subscription,
                                user_id=subscription.user_id,
                                trigger_type=trigger_type,
                                trigger_reason=trigger_reason,
                            )

                            # Dispatch execution using unified method
                            subscription_service.dispatch_background_execution(
                                subscription, execution, use_sync=False
                            )
                            SUBSCRIPTION_QUEUE_SIZE.inc()
                            dispatched += 1

                            logger.info(
                                f"[subscription_tasks] Dispatched execution {execution.id} for subscription {subscription.id} ({subscription.name})"
                            )

                            # Update next execution time
                            _update_next_execution_time(
                                db, subscription, subscription_crd, trigger_type
                            )

                        except Exception as e:
                            logger.error(
                                f"[subscription_tasks] Error processing subscription {subscription.id}: {str(e)}",
                                exc_info=True,
                            )
                            db.rollback()
                            continue

                    offset += len(batch)

                    # Additional lock extension between batches (backup to watchdog)
                    if offset < total_due:
                        distributed_lock.extend(
                            "check_due_subscriptions",
                            expire_seconds=CHECK_DUE_SUBSCRIPTIONS_LOCK_TIMEOUT,
                        )
                        last_lock_extend_time = time.time()

                logger.info(
                    f"[subscription_tasks] check_due_subscriptions completed: {dispatched}/{total_due} subscriptions dispatched, {recovered} pending recovered, {cleaned_running} running cleaned"
                )
                return {
                    "due_subscriptions": total_due,
                    "dispatched": dispatched,
                    "recovered_pending": recovered,
                    "cleaned_running": cleaned_running,
                }

            except Exception as e:
                logger.error(
                    f"[subscription_tasks] Error in check_due_subscriptions: {str(e)}",
                    exc_info=True,
                )
                raise


def _recover_stale_pending_executions(db: Session) -> int:
    """
    Recover stale PENDING executions that were not dispatched.

    This handles the case where:
    1. A BackgroundExecution was created with PENDING status
    2. The service crashed before dispatch_background_execution was called
    3. The execution is now orphaned

    Uses SELECT FOR UPDATE SKIP LOCKED to prevent race conditions.

    Args:
        db: Database session

    Returns:
        Number of recovered executions
    """
    from app.models.kind import Kind
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import (
        BackgroundExecutionInDB,
        BackgroundExecutionStatus,
    )
    from app.services.subscription import subscription_service

    try:
        # Find PENDING executions older than threshold (likely orphaned)
        stale_threshold = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            hours=settings.FLOW_STALE_PENDING_HOURS
        )

        # Use FOR UPDATE SKIP LOCKED to prevent race conditions
        stale_executions = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.status == BackgroundExecutionStatus.PENDING.value,
                BackgroundExecution.created_at < stale_threshold,
                BackgroundExecution.task_id == 0,  # Never linked to a task
            )
            .with_for_update(skip_locked=True)
            .limit(50)
            .all()
        )

        if not stale_executions:
            return 0

        logger.info(
            f"[subscription_tasks] Found {len(stale_executions)} stale PENDING executions to recover "
            f"(threshold: {settings.FLOW_STALE_PENDING_HOURS}h, before {stale_threshold})"
        )

        recovered = 0
        for execution in stale_executions:
            try:
                # Calculate how long it's been pending
                pending_duration = (
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    - execution.created_at
                )
                pending_hours = pending_duration.total_seconds() / 3600

                # Get the subscription
                subscription = (
                    db.query(Kind)
                    .filter(
                        Kind.id == execution.subscription_id,
                        Kind.kind == "Subscription",
                        Kind.is_active == True,
                    )
                    .first()
                )

                if not subscription:
                    # Subscription was deleted, mark execution as CANCELLED
                    execution.status = BackgroundExecutionStatus.CANCELLED.value
                    execution.error_message = (
                        "Subscription was deleted while execution was pending"
                    )
                    execution.updated_at = datetime.now(timezone.utc).replace(
                        tzinfo=None
                    )
                    db.commit()
                    logger.warning(
                        f"[subscription_tasks] Cancelled orphaned PENDING execution {execution.id}: "
                        f"subscription_id={execution.subscription_id} was deleted, pending_hours={pending_hours:.1f}h"
                    )
                    continue

                # Mark as RUNNING before dispatch to prevent duplicate recovery
                execution.status = BackgroundExecutionStatus.RUNNING.value
                execution.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
                execution.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                db.commit()

                # Re-dispatch the execution
                exec_in_db = BackgroundExecutionInDB(
                    id=execution.id,
                    user_id=execution.user_id,
                    subscription_id=execution.subscription_id,
                    task_id=execution.task_id,
                    trigger_type=execution.trigger_type,
                    trigger_reason=execution.trigger_reason,
                    prompt=execution.prompt,
                    status=BackgroundExecutionStatus.RUNNING,
                    result_summary=execution.result_summary,
                    error_message=execution.error_message,
                    retry_attempt=execution.retry_attempt,
                    started_at=execution.started_at,
                    completed_at=execution.completed_at,
                    created_at=execution.created_at,
                    updated_at=execution.updated_at,
                )

                subscription_service.dispatch_background_execution(
                    subscription, exec_in_db, use_sync=False
                )
                recovered += 1

                logger.info(
                    f"[subscription_tasks] Recovered stale PENDING execution {execution.id}: "
                    f"subscription_id={subscription.id}, subscription_name={subscription.name}, "
                    f"pending_hours={pending_hours:.1f}h, re-dispatched"
                )

            except Exception as e:
                logger.error(
                    f"[subscription_tasks] Failed to recover execution {execution.id}: {e}",
                    exc_info=True,
                )
                db.rollback()
                continue

        return recovered

    except Exception as e:
        logger.error(
            f"[subscription_tasks] Error recovering stale executions: {e}",
            exc_info=True,
        )
        return 0


def _cleanup_stale_running_executions(db: Session) -> int:
    """
    Cleanup stale RUNNING executions that have been stuck for too long.

    This handles the case where:
    1. A BackgroundExecution was started (RUNNING status)
    2. The executor/chat_shell never completed or failed to callback
    3. The execution is now stuck in RUNNING forever

    Uses FLOW_STALE_RUNNING_HOURS from settings (default 3 hours).

    Args:
        db: Database session

    Returns:
        Number of cleaned up executions
    """
    from app.models.subscription import BackgroundExecution
    from app.schemas.subscription import BackgroundExecutionStatus

    try:
        stale_threshold = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
            hours=settings.FLOW_STALE_RUNNING_HOURS
        )

        stale_executions = (
            db.query(BackgroundExecution)
            .filter(
                BackgroundExecution.status == BackgroundExecutionStatus.RUNNING.value,
                BackgroundExecution.started_at < stale_threshold,
            )
            .limit(50)
            .all()
        )

        if not stale_executions:
            return 0

        logger.info(
            f"[subscription_tasks] Found {len(stale_executions)} stale RUNNING executions to cleanup "
            f"(threshold: {settings.FLOW_STALE_RUNNING_HOURS}h, before {stale_threshold})"
        )

        cleaned = 0
        for execution in stale_executions:
            try:
                running_duration = (
                    datetime.now(timezone.utc).replace(tzinfo=None)
                    - execution.started_at
                )
                running_hours = running_duration.total_seconds() / 3600

                execution.status = BackgroundExecutionStatus.FAILED.value
                execution.error_message = (
                    f"Execution timed out after {running_hours:.1f} hour(s) "
                    f"(stuck in RUNNING state, threshold: {settings.FLOW_STALE_RUNNING_HOURS}h)"
                )
                execution.completed_at = datetime.now(timezone.utc).replace(tzinfo=None)
                execution.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
                cleaned += 1

                logger.warning(
                    f"[subscription_tasks] Cleaned stale RUNNING execution {execution.id}: "
                    f"subscription_id={execution.subscription_id}, task_id={execution.task_id}, "
                    f"started_at={execution.started_at}, running_hours={running_hours:.1f}h, "
                    f"reason=exceeded {settings.FLOW_STALE_RUNNING_HOURS}h threshold"
                )

            except Exception as e:
                logger.error(
                    f"[subscription_tasks] Failed to cleanup execution {execution.id}: {e}",
                    exc_info=True,
                )
                continue

        db.commit()
        return cleaned

    except Exception as e:
        logger.error(
            f"[subscription_tasks] Error cleaning up stale RUNNING executions: {e}",
            exc_info=True,
        )
        return 0


def _get_trigger_reason(subscription_crd: Any, trigger_type: str) -> str:
    """Get human-readable trigger reason based on trigger type."""
    from app.schemas.subscription import SubscriptionTriggerType

    if trigger_type == SubscriptionTriggerType.CRON.value:
        return f"Scheduled (cron: {subscription_crd.spec.trigger.cron.expression})"
    elif trigger_type == SubscriptionTriggerType.INTERVAL.value:
        interval = subscription_crd.spec.trigger.interval
        return f"Scheduled (interval: {interval.value} {interval.unit})"
    elif trigger_type == SubscriptionTriggerType.ONE_TIME.value:
        return "One-time scheduled execution"
    else:
        return "Scheduled execution"


def _update_next_execution_time(
    db: Session, subscription: Any, subscription_crd: Any, trigger_type: str
) -> None:
    """Update next execution time for a subscription after dispatch."""
    from sqlalchemy.orm.attributes import flag_modified

    from app.schemas.subscription import SubscriptionTriggerType
    from app.services.subscription import subscription_service

    internal = subscription.json.get("_internal", {})
    trigger_config = subscription_service.extract_trigger_config(
        subscription_crd.spec.trigger
    )

    if trigger_type == SubscriptionTriggerType.ONE_TIME.value:
        # One-time subscriptions should be disabled after execution
        internal["enabled"] = False
        internal["next_execution_time"] = None
        subscription_crd.spec.enabled = False
        subscription.json = subscription_crd.model_dump(mode="json")
        subscription.json["_internal"] = internal
        flag_modified(subscription, "json")
        logger.info(
            f"[subscription_tasks] One-time subscription {subscription.id} will be disabled after execution"
        )
    else:
        # Calculate next execution time for recurring subscriptions
        next_time = subscription_service.calculate_next_execution_time(
            trigger_type, trigger_config
        )
        internal["next_execution_time"] = next_time.isoformat() if next_time else None
        subscription.json["_internal"] = internal
        flag_modified(subscription, "json")
        logger.info(
            f"[subscription_tasks] Next execution for subscription {subscription.id}: {next_time}"
        )

    db.commit()


@celery_app.task(
    bind=True,
    name="app.tasks.subscription_tasks.execute_subscription_task",
    max_retries=settings.FLOW_DEFAULT_RETRY_COUNT,
    default_retry_delay=60,
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
)
def execute_subscription_task(
    self,
    subscription_id: int,
    execution_id: int,
    timeout_seconds: Optional[int] = None,
):
    """
    Execute a single subscription task.

    This task:
    1. Loads all required entities (subscription, execution, team, user)
    2. Creates Task and Subtasks via create_chat_task
    3. For Chat Shell type: triggers AI response
    4. For Executor type: subtasks are picked up by executor_manager
    5. Updates BackgroundExecution status on completion/failure

    Args:
        subscription_id: The Subscription ID to execute
        execution_id: The BackgroundExecution ID to update
        timeout_seconds: Optional timeout override
    """
    import time

    from app.db.session import get_db_session
    from app.services.chat.config import should_use_direct_chat

    start_time = time.time()
    trigger_type = "unknown"

    with get_db_session() as db:
        try:
            # Load all required entities
            ctx = _load_subscription_execution_context(
                db, subscription_id, execution_id
            )
            if not ctx:
                return {
                    "status": "error",
                    "message": "Failed to load subscription execution context",
                }

            trigger_type = ctx.trigger_type

            # Check if team supports direct chat
            supports_direct_chat = should_use_direct_chat(
                db, ctx.team, ctx.subscription.user_id
            )
            logger.debug(
                f"[subscription_tasks] supports_direct_chat={supports_direct_chat} for subscription {subscription_id}"
            )

            # Generate task title
            task_title = _generate_task_title(
                ctx.subscription_crd, ctx.subscription.name, ctx.execution.prompt
            )

            # Create event loop for async operations
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Create task and subtasks
                task_result = loop.run_until_complete(
                    _create_subscription_task(db, ctx, task_title)
                )

                if not task_result:
                    return _handle_execution_failure(
                        db, execution_id, "Failed to create task", trigger_type
                    )

                task = task_result.task
                task_id = task.id

                # Add subscription labels to task
                _add_subscription_labels_to_task(
                    db, task, subscription_id, execution_id, supports_direct_chat
                )

                # Link task to execution
                _link_task_to_execution(db, ctx.execution, task_id)

                logger.info(
                    f"[subscription_tasks] Created task {task_id} for subscription {subscription_id} execution {execution_id}"
                )

                if supports_direct_chat:
                    # Chat Shell type - trigger AI response
                    if not task_result.assistant_subtask:
                        return _handle_execution_failure(
                            db, execution_id, "No assistant subtask found", trigger_type
                        )

                    logger.debug(
                        f"[subscription_tasks] Chat Shell type, triggering AI response for task {task_id}"
                    )
                    loop.run_until_complete(
                        _trigger_chat_shell_response(
                            ctx,
                            task,
                            task_result.assistant_subtask,
                            task_result.user_subtask,
                        )
                    )
                    logger.debug(
                        f"[subscription_tasks] AI response completed for task {task_id}"
                    )
                else:
                    # Executor type - subtask picked up by executor_manager
                    logger.debug(
                        f"[subscription_tasks] Executor type, task {task_id} dispatched to executor_manager"
                    )

                # Update execution status to COMPLETED for Chat Shell type
                # For Executor type, status will be updated by executor when done
                if supports_direct_chat:
                    from app.schemas.subscription import BackgroundExecutionStatus
                    from app.services.subscription import subscription_service

                    subscription_service.update_execution_status(
                        db,
                        execution_id=execution_id,
                        status=BackgroundExecutionStatus.COMPLETED,
                        result_summary=f"Task {task_id} created and AI response triggered",
                    )

            finally:
                loop.close()

            duration = time.time() - start_time
            SUBSCRIPTION_EXECUTION_DURATION.observe(duration)
            SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
                status="success", trigger_type=trigger_type
            ).inc()

            return {
                "status": "success",
                "subscription_id": subscription_id,
                "execution_id": execution_id,
                "task_id": task_id,
                "duration": duration,
            }

        except SoftTimeLimitExceeded:
            logger.error(
                f"[subscription_tasks] Execution timeout for subscription {subscription_id}, execution {execution_id}"
            )
            _handle_timeout_failure(db, execution_id, timeout_seconds, trigger_type)
            raise

        except Exception as e:
            logger.error(
                f"[subscription_tasks] Error executing subscription {subscription_id}: {str(e)}",
                exc_info=True,
            )
            _handle_exception_failure(db, execution_id, str(e), trigger_type)
            raise self.retry(exc=e)


def _handle_timeout_failure(
    db: Session,
    execution_id: int,
    timeout_seconds: Optional[int],
    trigger_type: str,
) -> None:
    """Handle timeout failure."""
    try:
        from app.schemas.subscription import BackgroundExecutionStatus
        from app.services.subscription import subscription_service

        effective_timeout = timeout_seconds or settings.FLOW_DEFAULT_TIMEOUT_SECONDS
        subscription_service.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.FAILED,
            error_message=f"Execution timeout after {effective_timeout}s",
        )
    except Exception as update_error:
        logger.error(
            f"[subscription_tasks] Failed to update timeout status: {update_error}"
        )

    SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
        status="timeout", trigger_type=trigger_type
    ).inc()


def _handle_exception_failure(
    db: Session,
    execution_id: int,
    error_message: str,
    trigger_type: str,
) -> None:
    """Handle general exception failure."""
    try:
        from app.schemas.subscription import BackgroundExecutionStatus
        from app.services.subscription import subscription_service

        subscription_service.update_execution_status(
            db,
            execution_id=execution_id,
            status=BackgroundExecutionStatus.FAILED,
            error_message=error_message,
        )
    except Exception as update_error:
        logger.error(
            f"[subscription_tasks] Failed to update error status: {update_error}"
        )

    SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
        status="failed", trigger_type=trigger_type
    ).inc()


# ========== Sync Functions for Non-Celery Backends ==========


def check_due_subscriptions_sync():
    """
    Synchronous version of check_due_subscriptions for non-Celery backends.

    This function performs the same logic as the Celery task but:
    - Executes synchronously (not as a Celery task)
    - Used by APScheduler and XXL-JOB backends
    - Calls execute_subscription_task_sync instead of dispatching Celery tasks
    """
    from app.db.session import get_db_session
    from app.models.kind import Kind
    from app.schemas.subscription import Subscription, SubscriptionTriggerType
    from app.services.subscription import subscription_service

    logger.info("[subscription_tasks] Starting check_due_subscriptions_sync cycle")

    with get_db_session() as db:
        try:
            # First, recover any orphaned PENDING executions
            recovered = _recover_stale_pending_executions(db)

            # Then, cleanup any stale RUNNING executions
            cleaned_running = _cleanup_stale_running_executions(db)

            # Use UTC for comparison since next_execution_time is stored in UTC
            now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

            # Query all active subscriptions
            all_subscriptions = (
                db.query(Kind)
                .filter(
                    Kind.kind == "Subscription",
                    Kind.is_active == True,
                )
                .all()
            )

            # Filter due subscriptions based on _internal fields
            due_subscriptions = []
            for sub in all_subscriptions:
                internal = sub.json.get("_internal", {})
                if not internal.get("enabled", True):
                    continue

                trigger_type = internal.get("trigger_type")
                if trigger_type not in [
                    SubscriptionTriggerType.CRON.value,
                    SubscriptionTriggerType.INTERVAL.value,
                    SubscriptionTriggerType.ONE_TIME.value,
                ]:
                    continue

                next_exec_time_str = internal.get("next_execution_time")
                if not next_exec_time_str:
                    continue

                try:
                    next_exec_time = datetime.fromisoformat(next_exec_time_str)
                    if next_exec_time <= now_utc:
                        due_subscriptions.append(sub)
                except (ValueError, TypeError):
                    continue

            if not due_subscriptions:
                logger.debug(
                    "[subscription_tasks] No subscriptions due for execution (sync)"
                )
                return {
                    "due_subscriptions": 0,
                    "dispatched": 0,
                    "recovered_pending": recovered,
                    "cleaned_running": cleaned_running,
                }

            logger.info(
                f"[subscription_tasks] Found {len(due_subscriptions)} subscription(s) due for execution (sync)"
            )

            dispatched = 0
            for subscription in due_subscriptions:
                try:
                    subscription_crd = Subscription.model_validate(subscription.json)
                    internal = subscription.json.get("_internal", {})
                    trigger_type = internal.get("trigger_type")

                    # Determine trigger reason
                    trigger_reason = _get_trigger_reason(subscription_crd, trigger_type)

                    # Create execution record
                    execution = subscription_service.create_execution(
                        db,
                        subscription=subscription,
                        user_id=subscription.user_id,
                        trigger_type=trigger_type,
                        trigger_reason=trigger_reason,
                    )

                    # Dispatch execution using unified method (sync mode)
                    subscription_service.dispatch_background_execution(
                        subscription, execution, use_sync=True
                    )
                    SUBSCRIPTION_QUEUE_SIZE.inc()
                    dispatched += 1

                    logger.info(
                        f"[subscription_tasks] Started execution {execution.id} for subscription {subscription.id} ({subscription.name}) (sync)"
                    )

                    # Update next execution time
                    _update_next_execution_time(
                        db, subscription, subscription_crd, trigger_type
                    )

                except Exception as e:
                    logger.error(
                        f"[subscription_tasks] Error processing subscription {subscription.id} (sync): {str(e)}",
                        exc_info=True,
                    )
                    db.rollback()
                    continue

            logger.info(
                f"[subscription_tasks] check_due_subscriptions_sync completed: {dispatched}/{len(due_subscriptions)} subscriptions dispatched, {recovered} pending recovered, {cleaned_running} running cleaned"
            )
            return {
                "due_subscriptions": len(due_subscriptions),
                "dispatched": dispatched,
                "recovered_pending": recovered,
                "cleaned_running": cleaned_running,
            }

        except Exception as e:
            logger.error(
                f"[subscription_tasks] Error in check_due_subscriptions_sync: {str(e)}",
                exc_info=True,
            )
            raise


def execute_subscription_task_sync(
    subscription_id: int,
    execution_id: int,
    timeout_seconds: Optional[int] = None,
):
    """
    Synchronous version of execute_subscription_task for non-Celery backends.

    This function performs the same logic as the Celery task but:
    - Executes synchronously (not as a Celery task)
    - Used by APScheduler and XXL-JOB backends
    - Does not have Celery retry mechanisms (implements its own)

    Args:
        subscription_id: The Subscription ID to execute
        execution_id: The BackgroundExecution ID to update
        timeout_seconds: Optional timeout override
    """
    import time

    from app.db.session import get_db_session
    from app.services.chat.config import should_use_direct_chat

    start_time = time.time()
    trigger_type = "unknown"

    with get_db_session() as db:
        try:
            # Load all required entities
            ctx = _load_subscription_execution_context(
                db, subscription_id, execution_id
            )
            if not ctx:
                return {
                    "status": "error",
                    "message": "Failed to load subscription execution context",
                }

            trigger_type = ctx.trigger_type

            # Check if team supports direct chat
            supports_direct_chat = should_use_direct_chat(
                db, ctx.team, ctx.subscription.user_id
            )
            logger.debug(
                f"[subscription_tasks] supports_direct_chat={supports_direct_chat} for subscription {subscription_id} (sync)"
            )

            # Generate task title
            task_title = _generate_task_title(
                ctx.subscription_crd, ctx.subscription.name, ctx.execution.prompt
            )

            # Create event loop for async operations
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Create task and subtasks
                task_result = loop.run_until_complete(
                    _create_subscription_task(db, ctx, task_title)
                )

                if not task_result:
                    return _handle_execution_failure(
                        db, execution_id, "Failed to create task", trigger_type
                    )

                task = task_result.task
                task_id = task.id

                # Add subscription labels to task
                _add_subscription_labels_to_task(
                    db, task, subscription_id, execution_id, supports_direct_chat
                )

                # Link task to execution
                _link_task_to_execution(db, ctx.execution, task_id)

                logger.info(
                    f"[subscription_tasks] Created task {task_id} for subscription {subscription_id} execution {execution_id} (sync)"
                )

                # For Chat Shell type: trigger AI response
                if supports_direct_chat:
                    logger.info(
                        f"[subscription_tasks] Triggering Chat Shell response for task {task_id} (sync)"
                    )
                    loop.run_until_complete(
                        _trigger_chat_shell_response(
                            ctx,
                            task,
                            task_result.assistant_subtask,
                            task_result.user_subtask,
                        )
                    )

                # Update execution status
                from app.services.subscription import subscription_service

                if supports_direct_chat:
                    # For Chat Shell, mark as completed after AI response is triggered
                    subscription_service.update_execution_status(
                        db,
                        execution_id,
                        "COMPLETED",
                        result_summary=f"Task {task_id} created and AI response triggered",
                    )
                else:
                    # For Executor type, keep as RUNNING until executor completes
                    subscription_service.update_execution_status(
                        db,
                        execution_id,
                        "RUNNING",
                        result_summary=f"Task {task_id} created, waiting for executor",
                    )

                duration = time.time() - start_time
                SUBSCRIPTION_EXECUTION_DURATION.observe(duration)
                SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
                    status="success", trigger_type=trigger_type
                ).inc()

                return {
                    "status": "success",
                    "task_id": task_id,
                    "execution_id": execution_id,
                    "duration": duration,
                }

            finally:
                loop.close()

        except Exception as e:
            error_message = str(e)
            logger.error(
                f"[subscription_tasks] Error in execute_subscription_task_sync: {error_message}",
                exc_info=True,
            )

            # Update execution status with error
            try:
                from app.services.subscription import subscription_service

                subscription_service.update_execution_status(
                    db,
                    execution_id,
                    "FAILED",
                    error_message=error_message,
                )
            except Exception as update_error:
                logger.error(
                    f"[subscription_tasks] Failed to update error status (sync): {update_error}"
                )

            SUBSCRIPTION_EXECUTIONS_TOTAL.labels(
                status="failed", trigger_type=trigger_type
            ).inc()

            # Add to DLQ for non-Celery backends
            try:
                from app.core.dead_letter_queue import add_to_dlq

                add_to_dlq(
                    task_id=f"subscription-sync-{subscription_id}-{execution_id}",
                    task_name="execute_subscription_task_sync",
                    args=(subscription_id, execution_id),
                    kwargs={"timeout_seconds": timeout_seconds},
                    exception=e,
                )
            except Exception as dlq_error:
                logger.warning(
                    f"[subscription_tasks] Failed to add to DLQ: {dlq_error}"
                )

            return {"status": "error", "message": error_message}
