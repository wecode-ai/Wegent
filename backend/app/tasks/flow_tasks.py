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
from datetime import datetime, timezone
from typing import Optional

from celery import shared_task
from celery.exceptions import SoftTimeLimitExceeded
from prometheus_client import Counter, Histogram

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


@shared_task(bind=True, name="app.tasks.flow_tasks.check_due_flows")
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
    from app.db.session import SessionLocal
    from app.models.flow import FlowResource
    from app.schemas.flow import Flow, FlowExecutionStatus, FlowTriggerType
    from app.services.flow import flow_service

    logger.info("[flow_tasks] Starting check_due_flows cycle")

    db = SessionLocal()
    try:
        # Use UTC for comparison since next_execution_time is stored in UTC
        now_utc = datetime.utcnow()

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

        logger.info(f"[flow_tasks] Found {len(due_flows)} flow(s) due for execution")

        dispatched = 0
        for flow in due_flows:
            try:
                flow_crd = Flow.model_validate(flow.json)
                trigger_type = flow.trigger_type

                # Determine trigger reason
                if trigger_type == FlowTriggerType.CRON.value:
                    trigger_reason = (
                        f"Scheduled (cron: {flow_crd.spec.trigger.cron.expression})"
                    )
                elif trigger_type == FlowTriggerType.INTERVAL.value:
                    interval = flow_crd.spec.trigger.interval
                    trigger_reason = (
                        f"Scheduled (interval: {interval.value} {interval.unit})"
                    )
                elif trigger_type == FlowTriggerType.ONE_TIME.value:
                    trigger_reason = "One-time scheduled execution"
                else:
                    trigger_reason = "Scheduled execution"

                # Create execution record
                execution = flow_service._create_execution(
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
                trigger_config = flow_service._extract_trigger_config(
                    flow_crd.spec.trigger
                )

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
                    flow.next_execution_time = (
                        flow_service._calculate_next_execution_time(
                            trigger_type, trigger_config
                        )
                    )
                    logger.info(
                        f"[flow_tasks] Next execution for flow {flow.id}: {flow.next_execution_time}"
                    )

                db.commit()

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
        logger.error(f"[flow_tasks] Error in check_due_flows: {str(e)}", exc_info=True)
        raise
    finally:
        db.close()


@shared_task(
    bind=True,
    name="app.tasks.flow_tasks.execute_flow_task",
    max_retries=1,
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
    1. Creates Task and Subtasks via task_kinds_service
    2. For Chat Shell type: triggers AI response via _stream_chat_response
    3. For Executor type: subtasks are picked up by executor_manager
    4. Updates FlowExecution status on completion/failure

    Args:
        flow_id: The Flow ID to execute
        execution_id: The FlowExecution ID to update
        timeout_seconds: Optional timeout override
    """
    import time

    from app.db.session import SessionLocal
    from app.models.flow import FlowResource
    from app.models.kind import Kind
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.task import TaskResource
    from app.models.user import User
    from app.schemas.flow import Flow, FlowExecutionStatus
    from app.schemas.kind import Task, Team
    from app.schemas.task import TaskCreate
    from app.services.adapters.task_kinds import task_kinds_service
    from app.services.chat.config import should_use_direct_chat
    from app.services.flow import flow_service

    start_time = time.time()
    trigger_type = "unknown"

    db = SessionLocal()
    try:
        # Get flow
        flow = (
            db.query(FlowResource)
            .filter(FlowResource.id == flow_id, FlowResource.is_active == True)
            .first()
        )

        if not flow:
            logger.error(f"[flow_tasks] Flow {flow_id} not found")
            return {"status": "error", "message": f"Flow {flow_id} not found"}

        trigger_type = flow.trigger_type or "unknown"
        flow_crd = Flow.model_validate(flow.json)

        # Get execution record
        from app.models.flow import FlowExecution

        execution = (
            db.query(FlowExecution).filter(FlowExecution.id == execution_id).first()
        )

        if not execution:
            logger.error(f"[flow_tasks] Execution {execution_id} not found")
            return {"status": "error", "message": f"Execution {execution_id} not found"}

        # Get team
        team = (
            db.query(Kind)
            .filter(
                Kind.id == flow.team_id, Kind.kind == "Team", Kind.is_active == True
            )
            .first()
        )

        if not team:
            logger.error(
                f"[flow_tasks] Team {flow.team_id} not found for flow {flow.id}"
            )
            flow_service.update_execution_status(
                db,
                execution_id=execution_id,
                status=FlowExecutionStatus.FAILED,
                error_message=f"Team {flow.team_id} not found",
            )
            FLOW_EXECUTIONS_TOTAL.labels(
                status="failed", trigger_type=trigger_type
            ).inc()
            return {"status": "error", "message": f"Team {flow.team_id} not found"}

        # Get user
        user = db.query(User).filter(User.id == flow.user_id).first()
        if not user:
            logger.error(
                f"[flow_tasks] User {flow.user_id} not found for flow {flow.id}"
            )
            flow_service.update_execution_status(
                db,
                execution_id=execution_id,
                status=FlowExecutionStatus.FAILED,
                error_message=f"User {flow.user_id} not found",
            )
            FLOW_EXECUTIONS_TOTAL.labels(
                status="failed", trigger_type=trigger_type
            ).inc()
            return {"status": "error", "message": f"User {flow.user_id} not found"}

        # Get workspace info if specified
        git_url = ""
        git_repo = ""
        git_repo_id = 0
        git_domain = ""
        branch_name = ""

        if flow.workspace_id:
            workspace = (
                db.query(TaskResource)
                .filter(
                    TaskResource.id == flow.workspace_id,
                    TaskResource.kind == "Workspace",
                    TaskResource.is_active == True,
                )
                .first()
            )
            if workspace:
                ws_json = workspace.json
                repo = ws_json.get("spec", {}).get("repository", {})
                git_url = repo.get("gitUrl", "")
                git_repo = repo.get("gitRepo", "")
                git_repo_id = repo.get("gitRepoId", 0)
                git_domain = repo.get("gitDomain", "")
                branch_name = repo.get("branchName", "")

        # Generate title from flow display name or prompt
        flow_display_name = flow_crd.spec.displayName or flow.name
        task_title = f"[Flow] {flow_display_name}"
        if execution.prompt:
            prompt_preview = execution.prompt[:50]
            if len(execution.prompt) > 50:
                prompt_preview += "..."
            task_title = f"[Flow] {flow_display_name}: {prompt_preview}"

        # Create TaskCreate object
        task_create = TaskCreate(
            team_id=team.id,
            team_name=team.name,
            team_namespace=team.namespace,
            title=task_title,
            prompt=execution.prompt or "",
            git_url=git_url,
            git_repo=git_repo,
            git_repo_id=git_repo_id,
            git_domain=git_domain,
            branch_name=branch_name,
            type="online",
            task_type="chat",
            auto_delete_executor="false",
            source="flow",
        )

        # Create task and subtasks
        task_dict = task_kinds_service.create_task_or_append(
            db=db,
            obj_in=task_create,
            user=user,
            task_id=None,
        )

        task_id = task_dict["id"]

        # Add flow-specific labels to the task
        task = (
            db.query(TaskResource)
            .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
            .first()
        )
        if task:
            task_crd = Task.model_validate(task.json)
            if task_crd.metadata.labels:
                task_crd.metadata.labels["flowId"] = str(flow.id)
                task_crd.metadata.labels["executionId"] = str(execution_id)
                task_crd.metadata.labels["flowExecutionId"] = str(execution_id)
            task.json = task_crd.model_dump(mode="json")
            db.commit()

        # Link task to execution
        execution.task_id = task_id
        execution.status = FlowExecutionStatus.RUNNING.value
        execution.started_at = datetime.utcnow()
        db.commit()

        logger.info(
            f"[flow_tasks] Created task {task_id} for flow execution {execution_id}"
        )

        # Check if this is a Chat Shell type team
        supports_direct_chat = should_use_direct_chat(db, team, flow.user_id)

        if supports_direct_chat:
            # For Chat Shell type, trigger AI response
            logger.info(
                f"[flow_tasks] Chat Shell type detected, triggering AI response for task {task_id}"
            )
            _trigger_chat_shell_response(
                db, task_id, team, user, execution.prompt or "", execution_id
            )
        else:
            # For Executor type, subtask is picked up by executor_manager
            logger.info(
                f"[flow_tasks] Executor type detected, task {task_id} will be picked up by executor_manager"
            )
            # For executor type, we don't wait - executor_manager handles completion
            # The FlowExecution status will be updated by executor_kinds when subtask completes

        duration = time.time() - start_time
        FLOW_EXECUTION_DURATION.observe(duration)
        FLOW_EXECUTIONS_TOTAL.labels(status="success", trigger_type=trigger_type).inc()

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
        try:
            from app.schemas.flow import FlowExecutionStatus
            from app.services.flow import flow_service

            flow_service.update_execution_status(
                db,
                execution_id=execution_id,
                status=FlowExecutionStatus.FAILED,
                error_message=f"Execution timeout after {timeout_seconds or settings.FLOW_DEFAULT_TIMEOUT_SECONDS}s",
            )
        except Exception as update_error:
            logger.error(
                f"[flow_tasks] Failed to update timeout status: {update_error}"
            )

        FLOW_EXECUTIONS_TOTAL.labels(status="timeout", trigger_type=trigger_type).inc()
        raise

    except Exception as e:
        logger.error(
            f"[flow_tasks] Error executing flow {flow_id}: {str(e)}",
            exc_info=True,
        )
        try:
            from app.schemas.flow import FlowExecutionStatus
            from app.services.flow import flow_service

            flow_service.update_execution_status(
                db,
                execution_id=execution_id,
                status=FlowExecutionStatus.FAILED,
                error_message=str(e),
            )
        except Exception as update_error:
            logger.error(f"[flow_tasks] Failed to update error status: {update_error}")

        FLOW_EXECUTIONS_TOTAL.labels(status="failed", trigger_type=trigger_type).inc()

        # Re-raise for Celery retry mechanism
        raise self.retry(exc=e)

    finally:
        db.close()


def _trigger_chat_shell_response(
    db, task_id: int, team, user, message: str, execution_id: int
) -> None:
    """
    Trigger Chat Shell AI response for a flow task.

    This function creates the necessary context and triggers the AI response
    using the same mechanism as WebSocket chat:send.

    The function is protected by a circuit breaker to prevent cascading failures
    when the AI service is degraded or unavailable.

    Args:
        db: Database session
        task_id: Task ID
        team: Team Kind object
        user: User object
        message: User message
        execution_id: FlowExecution ID for status updates

    Raises:
        CircuitBreakerOpenError: When the circuit breaker is open
        Exception: When AI response fails
    """
    # Check circuit breaker state before proceeding
    import pybreaker

    from app.core.circuit_breaker import (
        CircuitBreakerOpenError,
        ai_service_breaker,
    )
    from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
    from app.models.task import TaskResource
    from app.services.chat.trigger.core import StreamTaskData, _stream_chat_response
    from app.services.chat.trigger.emitter import FlowEventEmitter

    if ai_service_breaker.current_state == pybreaker.STATE_OPEN:
        logger.error(
            f"[flow_tasks] Circuit breaker is OPEN, skipping AI call for task {task_id}"
        )
        raise CircuitBreakerOpenError(
            "ai_service",
            f"AI service circuit breaker is open. Will reset in {ai_service_breaker.reset_timeout}s",
        )

    # Get the assistant subtask that was created
    assistant_subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.user_id == user.id,
            Subtask.role == SubtaskRole.ASSISTANT,
            Subtask.status == SubtaskStatus.PENDING,
        )
        .order_by(Subtask.id.desc())
        .first()
    )

    if not assistant_subtask:
        logger.error(
            f"[flow_tasks] No pending assistant subtask found for task {task_id}"
        )
        return

    # Get the user subtask for context
    user_subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.user_id == user.id,
            Subtask.role == SubtaskRole.USER,
        )
        .order_by(Subtask.id.desc())
        .first()
    )

    # Get task resource
    task = (
        db.query(TaskResource)
        .filter(TaskResource.id == task_id, TaskResource.kind == "Task")
        .first()
    )

    if not task:
        logger.error(f"[flow_tasks] Task {task_id} not found")
        return

    # Create a minimal payload object for streaming
    class FlowPayload:
        def __init__(self):
            self.force_override_bot_model = None
            self.enable_clarification = False
            self.enable_deep_thinking = True
            self.is_group_chat = False
            self.enable_web_search = False
            self.search_engine = None

    payload = FlowPayload()
    task_room = f"task_{task_id}"

    # Extract data from ORM objects before starting the streaming task
    stream_data = StreamTaskData.from_orm(task, team, user, assistant_subtask)

    # Use FlowEventEmitter to update FlowExecution status when streaming
    # completes or fails
    flow_emitter = FlowEventEmitter(execution_id=execution_id)

    # Run the streaming in event loop with circuit breaker protection
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(
            _stream_chat_response(
                stream_data=stream_data,
                message=message,
                payload=payload,
                task_room=task_room,
                namespace=None,  # No WebSocket namespace for flow tasks
                trace_context=None,
                otel_context=None,
                user_subtask_id=user_subtask.id if user_subtask else None,
                event_emitter=flow_emitter,
            )
        )
        # Record success in circuit breaker
        ai_service_breaker._success()
        logger.info(f"[flow_tasks] Chat Shell AI response completed for task {task_id}")
    except Exception as e:
        # Record failure in circuit breaker
        ai_service_breaker._failure(e)
        logger.error(
            f"[flow_tasks] Error in Chat Shell response for task {task_id}: {str(e)}",
            exc_info=True,
        )
        raise
    finally:
        loop.close()
