# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for Flow Scheduler.

This module contains the Celery tasks for:
1. check_due_flows - Periodic task that checks for flows due for execution
2. execute_flow_task - Task that executes a single flow

The architecture separates trigger from execution:
- check_due_flows runs every minute, finds due flows, dispatches execute_flow_task
- execute_flow_task runs asynchronously, handles AI response, updates status
"""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

from celery.exceptions import SoftTimeLimitExceeded
from prometheus_client import Counter, Histogram
from sqlalchemy.orm import Session

from app.core.celery_app import celery_app
from app.core.config import settings

logger = logging.getLogger(__name__)

# Prometheus metrics
FLOW_EXECUTIONS_TOTAL = Counter(
    "flow_executions_total",
    "Total flow executions",
    ["status", "trigger_type"],
)
FLOW_EXECUTION_DURATION = Histogram(
    "flow_execution_duration_seconds",
    "Flow execution duration in seconds",
    buckets=[10, 30, 60, 120, 300, 600],
)
FLOW_QUEUE_SIZE = Counter(
    "flow_tasks_queued_total",
    "Total flow tasks queued for execution",
)


# ========== Data Classes for Flow Execution ==========


@dataclass
class FlowExecutionContext:
    """Context object containing all data needed for flow execution."""

    flow: Any  # FlowResource
    flow_crd: Any  # Flow CRD
    execution: Any  # FlowExecution
    team: Any  # Kind (Team)
    user: Any  # User
    trigger_type: str
    workspace_info: "WorkspaceInfo"


@dataclass
class WorkspaceInfo:
    """Workspace-related information for task creation."""

    git_url: str = ""
    git_repo: str = ""
    git_repo_id: int = 0
    git_domain: str = ""
    branch_name: str = ""


@dataclass
class FlowTaskResult:
    """Result of a flow task creation."""

    task: Any
    user_subtask: Any
    assistant_subtask: Any


# ========== Helper Functions ==========


def _load_flow_execution_context(
    db: Session,
    flow_id: int,
    execution_id: int,
) -> Optional[FlowExecutionContext]:
    """
    Load all required entities for flow execution.

    Returns None if any required entity is not found.
    """
    from app.core.constants import KIND_TEAM
    from app.models.flow import FlowExecution, FlowResource
    from app.models.kind import Kind
    from app.models.task import TaskResource
    from app.models.user import User
    from app.schemas.flow import Flow

    # Get flow
    flow = (
        db.query(FlowResource)
        .filter(FlowResource.id == flow_id, FlowResource.is_active == True)
        .first()
    )
    if not flow:
        logger.error(f"[flow_tasks] Flow {flow_id} not found")
        return None

    flow_crd = Flow.model_validate(flow.json)
    trigger_type = flow.trigger_type or "unknown"

    # Get execution record
    execution = db.query(FlowExecution).filter(FlowExecution.id == execution_id).first()
    if not execution:
        logger.error(f"[flow_tasks] Execution {execution_id} not found")
        return None

    # Get team
    team = (
        db.query(Kind)
        .filter(Kind.id == flow.team_id, Kind.kind == KIND_TEAM, Kind.is_active == True)
        .first()
    )
    if not team:
        logger.error(f"[flow_tasks] Team {flow.team_id} not found for flow {flow.id}")
        return None

    # Get user
    user = db.query(User).filter(User.id == flow.user_id).first()
    if not user:
        logger.error(f"[flow_tasks] User {flow.user_id} not found for flow {flow.id}")
        return None

    # Get workspace info
    workspace_info = _load_workspace_info(db, flow.workspace_id)

    return FlowExecutionContext(
        flow=flow,
        flow_crd=flow_crd,
        execution=execution,
        team=team,
        user=user,
        trigger_type=trigger_type,
        workspace_info=workspace_info,
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


def _generate_task_title(flow_crd: Any, flow_name: str, prompt: Optional[str]) -> str:
    """Generate a task title from flow information."""
    flow_display_name = flow_crd.spec.displayName or flow_name
    task_title = f"[Flow] {flow_display_name}"

    if prompt:
        prompt_preview = prompt[:50]
        if len(prompt) > 50:
            prompt_preview += "..."
        task_title = f"[Flow] {flow_display_name}: {prompt_preview}"

    return task_title


async def _create_flow_task(
    db: Session,
    ctx: FlowExecutionContext,
    task_title: str,
) -> Optional[FlowTaskResult]:
    """
    Create task and subtasks for flow execution.

    Uses the unified create_chat_task function.
    """
    from app.core.constants import FLOW_SOURCE
    from app.services.chat.storage import TaskCreationParams, create_chat_task

    ws = ctx.workspace_info
    params = TaskCreationParams(
        message=ctx.execution.prompt or "",
        title=task_title,
        model_id=None,
        force_override_bot_model=False,
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
        task_id=None,
        should_trigger_ai=True,
        rag_prompt=None,
        source=FLOW_SOURCE,
    )

    if not result.task:
        logger.error(f"[flow_tasks] Failed to create task for flow {ctx.flow.id}")
        return None

    return FlowTaskResult(
        task=result.task,
        user_subtask=result.user_subtask,
        assistant_subtask=result.assistant_subtask,
    )


def _add_flow_labels_to_task(
    db: Session, task: Any, flow_id: int, execution_id: int
) -> None:
    """Add flow-specific labels to the task."""
    from app.core.constants import (
        FLOW_SOURCE,
        LABEL_EXECUTION_ID,
        LABEL_FLOW_EXECUTION_ID,
        LABEL_FLOW_ID,
        LABEL_SOURCE,
    )
    from app.schemas.kind import Task

    task_crd = Task.model_validate(task.json)
    if task_crd.metadata.labels:
        task_crd.metadata.labels[LABEL_FLOW_ID] = str(flow_id)
        task_crd.metadata.labels[LABEL_EXECUTION_ID] = str(execution_id)
        task_crd.metadata.labels[LABEL_FLOW_EXECUTION_ID] = str(execution_id)
        task_crd.metadata.labels[LABEL_SOURCE] = FLOW_SOURCE
    task.json = task_crd.model_dump(mode="json")
    db.commit()


def _link_task_to_execution(db: Session, execution: Any, task_id: int) -> None:
    """Link task to execution and update execution status to RUNNING."""
    from app.schemas.flow import FlowExecutionStatus

    execution.task_id = task_id
    execution.status = FlowExecutionStatus.RUNNING.value
    execution.started_at = datetime.now(timezone.utc).replace(tzinfo=None)
    db.commit()


async def _trigger_chat_shell_response(
    ctx: FlowExecutionContext,
    task: Any,
    assistant_subtask: Any,
    user_subtask: Any,
) -> None:
    """Trigger AI response for Chat Shell type flows."""
    from app.core.constants import get_task_room
    from app.schemas.flow import FlowTriggerPayload
    from app.services.chat.trigger import trigger_ai_response
    from app.services.chat.trigger.emitter import FlowEventEmitter

    payload = FlowTriggerPayload()
    task_room = get_task_room(task.id)
    flow_emitter = FlowEventEmitter(execution_id=ctx.execution.id)

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
        event_emitter=flow_emitter,
    )


def _handle_execution_failure(
    db: Session,
    execution_id: int,
    error_message: str,
    trigger_type: str,
) -> Dict[str, Any]:
    """Handle execution failure by updating status and recording metrics."""
    from app.schemas.flow import FlowExecutionStatus
    from app.services.flow import flow_service

    flow_service.update_execution_status(
        db,
        execution_id=execution_id,
        status=FlowExecutionStatus.FAILED,
        error_message=error_message,
    )
    FLOW_EXECUTIONS_TOTAL.labels(status="failed", trigger_type=trigger_type).inc()
    return {"status": "error", "message": error_message}


# ========== Celery Tasks ==========


@celery_app.task(bind=True, name="app.tasks.flow_tasks.check_due_flows")
def check_due_flows(self):
    """
    Periodic task that checks for flows due for execution.

    This task:
    1. Acquires a check to avoid duplicate processing
    2. Queries for enabled flows with next_execution_time <= now
    3. Creates execution records and dispatches execute_flow_task for each
    4. Updates next_execution_time for recurring flows

    Runs every FLOW_SCHEDULER_INTERVAL_SECONDS (default: 60 seconds).
    """
    from app.db.session import get_db_session
    from app.models.flow import FlowResource
    from app.schemas.flow import Flow, FlowTriggerType
    from app.services.flow import flow_service

    logger.info("[flow_tasks] Starting check_due_flows cycle")

    with get_db_session() as db:
        try:
            # Use UTC for comparison since next_execution_time is stored in UTC
            now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

            # Query for due flows
            due_flows = (
                db.query(FlowResource)
                .filter(
                    FlowResource.is_active == True,
                    FlowResource.enabled == True,
                    FlowResource.next_execution_time != None,
                    FlowResource.next_execution_time <= now_utc,
                    FlowResource.trigger_type.in_(
                        [
                            FlowTriggerType.CRON.value,
                            FlowTriggerType.INTERVAL.value,
                            FlowTriggerType.ONE_TIME.value,
                        ]
                    ),
                )
                .all()
            )

            if not due_flows:
                logger.debug("[flow_tasks] No flows due for execution")
                return {"due_flows": 0, "dispatched": 0}

            logger.info(
                f"[flow_tasks] Found {len(due_flows)} flow(s) due for execution"
            )

            dispatched = 0
            for flow in due_flows:
                try:
                    flow_crd = Flow.model_validate(flow.json)
                    trigger_type = flow.trigger_type

                    # Determine trigger reason
                    trigger_reason = _get_trigger_reason(flow_crd, trigger_type)

                    # Create execution record
                    execution = flow_service.create_execution(
                        db,
                        flow=flow,
                        user_id=flow.user_id,
                        trigger_type=trigger_type,
                        trigger_reason=trigger_reason,
                    )

                    # Get timeout from flow config or use default
                    timeout_seconds = getattr(
                        flow_crd.spec,
                        "timeout_seconds",
                        settings.FLOW_DEFAULT_TIMEOUT_SECONDS,
                    )
                    retry_count = (
                        flow_crd.spec.retryCount or settings.FLOW_DEFAULT_RETRY_COUNT
                    )

                    # Dispatch async execution task
                    execute_flow_task.apply_async(
                        args=[flow.id, execution.id],
                        kwargs={"timeout_seconds": timeout_seconds},
                        max_retries=retry_count,
                    )
                    FLOW_QUEUE_SIZE.inc()
                    dispatched += 1

                    logger.info(
                        f"[flow_tasks] Dispatched execution {execution.id} for flow {flow.id} ({flow.name})"
                    )

                    # Update next execution time
                    _update_next_execution_time(db, flow, flow_crd, trigger_type)

                except Exception as e:
                    logger.error(
                        f"[flow_tasks] Error processing flow {flow.id}: {str(e)}",
                        exc_info=True,
                    )
                    db.rollback()
                    continue

            logger.info(
                f"[flow_tasks] check_due_flows completed: {dispatched}/{len(due_flows)} flows dispatched"
            )
            return {"due_flows": len(due_flows), "dispatched": dispatched}

        except Exception as e:
            logger.error(
                f"[flow_tasks] Error in check_due_flows: {str(e)}", exc_info=True
            )
            raise


def _get_trigger_reason(flow_crd: Any, trigger_type: str) -> str:
    """Get human-readable trigger reason based on trigger type."""
    from app.schemas.flow import FlowTriggerType

    if trigger_type == FlowTriggerType.CRON.value:
        return f"Scheduled (cron: {flow_crd.spec.trigger.cron.expression})"
    elif trigger_type == FlowTriggerType.INTERVAL.value:
        interval = flow_crd.spec.trigger.interval
        return f"Scheduled (interval: {interval.value} {interval.unit})"
    elif trigger_type == FlowTriggerType.ONE_TIME.value:
        return "One-time scheduled execution"
    else:
        return "Scheduled execution"


def _update_next_execution_time(
    db: Session, flow: Any, flow_crd: Any, trigger_type: str
) -> None:
    """Update next execution time for a flow after dispatch."""
    from app.schemas.flow import FlowTriggerType
    from app.services.flow import flow_service

    trigger_config = flow_service.extract_trigger_config(flow_crd.spec.trigger)

    if trigger_type == FlowTriggerType.ONE_TIME.value:
        # One-time flows should be disabled after execution
        flow.enabled = False
        flow.next_execution_time = None
        flow_crd.spec.enabled = False
        flow.json = flow_crd.model_dump(mode="json")
        logger.info(
            f"[flow_tasks] One-time flow {flow.id} will be disabled after execution"
        )
    else:
        # Calculate next execution time for recurring flows
        flow.next_execution_time = flow_service.calculate_next_execution_time(
            trigger_type, trigger_config
        )
        logger.info(
            f"[flow_tasks] Next execution for flow {flow.id}: {flow.next_execution_time}"
        )

    db.commit()


@celery_app.task(
    bind=True,
    name="app.tasks.flow_tasks.execute_flow_task",
    max_retries=settings.FLOW_DEFAULT_RETRY_COUNT,
    default_retry_delay=60,
    retry_backoff=True,
    retry_backoff_max=600,
    retry_jitter=True,
)
def execute_flow_task(
    self,
    flow_id: int,
    execution_id: int,
    timeout_seconds: Optional[int] = None,
):
    """
    Execute a single flow task.

    This task:
    1. Loads all required entities (flow, execution, team, user)
    2. Creates Task and Subtasks via create_chat_task
    3. For Chat Shell type: triggers AI response
    4. For Executor type: subtasks are picked up by executor_manager
    5. Updates FlowExecution status on completion/failure

    Args:
        flow_id: The Flow ID to execute
        execution_id: The FlowExecution ID to update
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
            ctx = _load_flow_execution_context(db, flow_id, execution_id)
            if not ctx:
                return {
                    "status": "error",
                    "message": "Failed to load flow execution context",
                }

            trigger_type = ctx.trigger_type

            # Validate team still exists and has required data
            from app.services.flow import flow_service

            # Check if team supports direct chat
            supports_direct_chat = should_use_direct_chat(
                db, ctx.team, ctx.flow.user_id
            )
            logger.debug(
                f"[flow_tasks] supports_direct_chat={supports_direct_chat} for flow {flow_id}"
            )

            # Generate task title
            task_title = _generate_task_title(
                ctx.flow_crd, ctx.flow.name, ctx.execution.prompt
            )

            # Create event loop for async operations
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Create task and subtasks
                task_result = loop.run_until_complete(
                    _create_flow_task(db, ctx, task_title)
                )

                if not task_result:
                    return _handle_execution_failure(
                        db, execution_id, "Failed to create task", trigger_type
                    )

                task = task_result.task
                task_id = task.id

                # Add flow labels to task
                _add_flow_labels_to_task(db, task, flow_id, execution_id)

                # Link task to execution
                _link_task_to_execution(db, ctx.execution, task_id)

                logger.info(
                    f"[flow_tasks] Created task {task_id} for flow {flow_id} execution {execution_id}"
                )

                if supports_direct_chat:
                    # Chat Shell type - trigger AI response
                    if not task_result.assistant_subtask:
                        return _handle_execution_failure(
                            db, execution_id, "No assistant subtask found", trigger_type
                        )

                    logger.debug(
                        f"[flow_tasks] Chat Shell type, triggering AI response for task {task_id}"
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
                        f"[flow_tasks] AI response completed for task {task_id}"
                    )
                else:
                    # Executor type - subtask picked up by executor_manager
                    logger.debug(
                        f"[flow_tasks] Executor type, task {task_id} dispatched to executor_manager"
                    )

            finally:
                loop.close()

            duration = time.time() - start_time
            FLOW_EXECUTION_DURATION.observe(duration)
            FLOW_EXECUTIONS_TOTAL.labels(
                status="success", trigger_type=trigger_type
            ).inc()

            return {
                "status": "success",
                "flow_id": flow_id,
                "execution_id": execution_id,
                "task_id": task_id,
                "duration": duration,
            }

        except SoftTimeLimitExceeded:
            logger.error(
                f"[flow_tasks] Execution timeout for flow {flow_id}, execution {execution_id}"
            )
            _handle_timeout_failure(db, execution_id, timeout_seconds, trigger_type)
            raise

        except Exception as e:
            logger.error(
                f"[flow_tasks] Error executing flow {flow_id}: {str(e)}",
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
        from app.schemas.flow import FlowExecutionStatus
        from app.services.flow import flow_service

        effective_timeout = timeout_seconds or settings.FLOW_DEFAULT_TIMEOUT_SECONDS
        flow_service.update_execution_status(
            db,
            execution_id=execution_id,
            status=FlowExecutionStatus.FAILED,
            error_message=f"Execution timeout after {effective_timeout}s",
        )
    except Exception as update_error:
        logger.error(f"[flow_tasks] Failed to update timeout status: {update_error}")

    FLOW_EXECUTIONS_TOTAL.labels(status="timeout", trigger_type=trigger_type).inc()


def _handle_exception_failure(
    db: Session,
    execution_id: int,
    error_message: str,
    trigger_type: str,
) -> None:
    """Handle general exception failure."""
    try:
        from app.schemas.flow import FlowExecutionStatus
        from app.services.flow import flow_service

        flow_service.update_execution_status(
            db,
            execution_id=execution_id,
            status=FlowExecutionStatus.FAILED,
            error_message=error_message,
        )
    except Exception as update_error:
        logger.error(f"[flow_tasks] Failed to update error status: {update_error}")

    FLOW_EXECUTIONS_TOTAL.labels(status="failed", trigger_type=trigger_type).inc()


# ========== Sync Functions for Non-Celery Backends ==========


def check_due_flows_sync():
    """
    Synchronous version of check_due_flows for non-Celery backends.

    This function performs the same logic as the Celery task but:
    - Executes synchronously (not as a Celery task)
    - Used by APScheduler and XXL-JOB backends
    - Calls execute_flow_task_sync instead of dispatching Celery tasks
    """
    from app.db.session import get_db_session
    from app.models.flow import FlowResource
    from app.schemas.flow import Flow, FlowTriggerType
    from app.services.flow import flow_service

    logger.info("[flow_tasks] Starting check_due_flows_sync cycle")

    with get_db_session() as db:
        try:
            # Use UTC for comparison since next_execution_time is stored in UTC
            now_utc = datetime.now(timezone.utc).replace(tzinfo=None)

            # Query for due flows
            due_flows = (
                db.query(FlowResource)
                .filter(
                    FlowResource.is_active == True,
                    FlowResource.enabled == True,
                    FlowResource.next_execution_time != None,
                    FlowResource.next_execution_time <= now_utc,
                    FlowResource.trigger_type.in_(
                        [
                            FlowTriggerType.CRON.value,
                            FlowTriggerType.INTERVAL.value,
                            FlowTriggerType.ONE_TIME.value,
                        ]
                    ),
                )
                .all()
            )

            if not due_flows:
                logger.debug("[flow_tasks] No flows due for execution (sync)")
                return {"due_flows": 0, "dispatched": 0}

            logger.info(
                f"[flow_tasks] Found {len(due_flows)} flow(s) due for execution (sync)"
            )

            dispatched = 0
            for flow in due_flows:
                try:
                    flow_crd = Flow.model_validate(flow.json)
                    trigger_type = flow.trigger_type

                    # Determine trigger reason
                    trigger_reason = _get_trigger_reason(flow_crd, trigger_type)

                    # Create execution record
                    execution = flow_service.create_execution(
                        db,
                        flow=flow,
                        user_id=flow.user_id,
                        trigger_type=trigger_type,
                        trigger_reason=trigger_reason,
                    )

                    # Get timeout from flow config or use default
                    timeout_seconds = getattr(
                        flow_crd.spec,
                        "timeout_seconds",
                        settings.FLOW_DEFAULT_TIMEOUT_SECONDS,
                    )

                    # Execute synchronously (in a thread to avoid blocking)
                    import threading

                    thread = threading.Thread(
                        target=execute_flow_task_sync,
                        args=(flow.id, execution.id, timeout_seconds),
                        daemon=True,
                    )
                    thread.start()

                    FLOW_QUEUE_SIZE.inc()
                    dispatched += 1

                    logger.info(
                        f"[flow_tasks] Started execution {execution.id} for flow {flow.id} ({flow.name}) (sync)"
                    )

                    # Update next execution time
                    _update_next_execution_time(db, flow, flow_crd, trigger_type)

                except Exception as e:
                    logger.error(
                        f"[flow_tasks] Error processing flow {flow.id} (sync): {str(e)}",
                        exc_info=True,
                    )
                    db.rollback()
                    continue

            logger.info(
                f"[flow_tasks] check_due_flows_sync completed: {dispatched}/{len(due_flows)} flows dispatched"
            )
            return {"due_flows": len(due_flows), "dispatched": dispatched}

        except Exception as e:
            logger.error(
                f"[flow_tasks] Error in check_due_flows_sync: {str(e)}", exc_info=True
            )
            raise


def execute_flow_task_sync(
    flow_id: int,
    execution_id: int,
    timeout_seconds: Optional[int] = None,
):
    """
    Synchronous version of execute_flow_task for non-Celery backends.

    This function performs the same logic as the Celery task but:
    - Executes synchronously (not as a Celery task)
    - Used by APScheduler and XXL-JOB backends
    - Does not have Celery retry mechanisms (implements its own)

    Args:
        flow_id: The Flow ID to execute
        execution_id: The FlowExecution ID to update
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
            ctx = _load_flow_execution_context(db, flow_id, execution_id)
            if not ctx:
                return {
                    "status": "error",
                    "message": "Failed to load flow execution context",
                }

            trigger_type = ctx.trigger_type

            # Check if team supports direct chat
            supports_direct_chat = should_use_direct_chat(
                db, ctx.team, ctx.flow.user_id
            )
            logger.debug(
                f"[flow_tasks] supports_direct_chat={supports_direct_chat} for flow {flow_id} (sync)"
            )

            # Generate task title
            task_title = _generate_task_title(
                ctx.flow_crd, ctx.flow.name, ctx.execution.prompt
            )

            # Create event loop for async operations
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                # Create task and subtasks
                task_result = loop.run_until_complete(
                    _create_flow_task(db, ctx, task_title)
                )

                if not task_result:
                    return _handle_execution_failure(
                        db, execution_id, "Failed to create task", trigger_type
                    )

                task = task_result.task
                task_id = task.id

                # Add flow labels to task
                _add_flow_labels_to_task(db, task, flow_id, execution_id)

                # Link task to execution
                _link_task_to_execution(db, ctx.execution, task_id)

                logger.info(
                    f"[flow_tasks] Created task {task_id} for flow {flow_id} execution {execution_id} (sync)"
                )

                # For Chat Shell type: trigger AI response
                if supports_direct_chat:
                    logger.info(
                        f"[flow_tasks] Triggering Chat Shell response for task {task_id} (sync)"
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
                from app.services.flow import flow_service

                if supports_direct_chat:
                    # For Chat Shell, mark as completed after AI response is triggered
                    flow_service.update_execution_status(
                        db,
                        execution_id,
                        "COMPLETED",
                        result_summary=f"Task {task_id} created and AI response triggered",
                    )
                else:
                    # For Executor type, keep as RUNNING until executor completes
                    flow_service.update_execution_status(
                        db,
                        execution_id,
                        "RUNNING",
                        result_summary=f"Task {task_id} created, waiting for executor",
                    )

                duration = time.time() - start_time
                FLOW_EXECUTION_DURATION.observe(duration)
                FLOW_EXECUTIONS_TOTAL.labels(
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
                f"[flow_tasks] Error in execute_flow_task_sync: {error_message}",
                exc_info=True,
            )

            # Update execution status with error
            try:
                from app.services.flow import flow_service

                flow_service.update_execution_status(
                    db,
                    execution_id,
                    "FAILED",
                    error_message=error_message,
                )
            except Exception as update_error:
                logger.error(
                    f"[flow_tasks] Failed to update error status (sync): {update_error}"
                )

            FLOW_EXECUTIONS_TOTAL.labels(
                status="failed", trigger_type=trigger_type
            ).inc()

            # Add to DLQ for non-Celery backends
            try:
                from app.core.dead_letter_queue import add_to_dlq

                add_to_dlq(
                    task_id=f"flow-sync-{flow_id}-{execution_id}",
                    task_name="execute_flow_task_sync",
                    args=(flow_id, execution_id),
                    kwargs={"timeout_seconds": timeout_seconds},
                    exception=e,
                )
            except Exception as dlq_error:
                logger.warning(f"[flow_tasks] Failed to add to DLQ: {dlq_error}")

            return {"status": "error", "message": error_message}
