# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Flow scheduler for triggering scheduled Flow executions.

This module integrates with the existing background job system to periodically
check for flows that need to be executed and trigger them.

For Chat Shell type tasks, this module:
1. Creates Task and Workspace resources
2. Creates User and Assistant Subtasks
3. Triggers AI response via the chat trigger system
4. Monitors task completion to update Flow execution status
"""
import asyncio
import logging
import threading
from datetime import datetime, timedelta
from typing import List, Optional

from app.core.cache import cache_manager
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.flow import FlowResource
from app.models.kind import Kind
from app.models.subtask import SenderType, Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.flow import Flow, FlowExecutionStatus, FlowTriggerType
from app.schemas.kind import Task, Team
from app.services.flow import flow_service

logger = logging.getLogger(__name__)

# Configuration
FLOW_SCHEDULER_INTERVAL_SECONDS = getattr(settings, "FLOW_SCHEDULER_INTERVAL_SECONDS", 60)
FLOW_SCHEDULER_LOCK_KEY = "flow_scheduler_lock"
# Set lock expiry to 2x the interval to account for processing time
FLOW_SCHEDULER_LOCK_EXPIRY = FLOW_SCHEDULER_INTERVAL_SECONDS * 2


async def acquire_flow_scheduler_lock() -> bool:
    """
    Try to acquire distributed lock to ensure only one instance executes the scheduler.
    """
    try:
        acquired = await cache_manager.setnx(
            FLOW_SCHEDULER_LOCK_KEY, True, expire=FLOW_SCHEDULER_LOCK_EXPIRY
        )
        if acquired:
            logger.debug(
                f"[flow_scheduler] Successfully acquired distributed lock: {FLOW_SCHEDULER_LOCK_KEY}"
            )
        else:
            logger.debug(
                f"[flow_scheduler] Lock is held by another instance: {FLOW_SCHEDULER_LOCK_KEY}"
            )
        return acquired
    except Exception as e:
        logger.error(f"[flow_scheduler] Error acquiring distributed lock: {str(e)}")
        return False


async def release_flow_scheduler_lock() -> bool:
    """Release distributed lock."""
    try:
        return await cache_manager.delete(FLOW_SCHEDULER_LOCK_KEY)
    except Exception as e:
        logger.error(f"[flow_scheduler] Error releasing lock: {str(e)}")
        return False


def get_due_flows(db, now: datetime) -> List[FlowResource]:
    """
    Get all enabled flows that are due for execution.

    Returns flows where:
    - is_active = True
    - enabled = True
    - next_execution_time <= now
    - trigger_type is cron, interval, or one_time (not event)
    """
    return (
        db.query(FlowResource)
        .filter(
            FlowResource.is_active == True,
            FlowResource.enabled == True,
            FlowResource.next_execution_time != None,
            FlowResource.next_execution_time <= now,
            FlowResource.trigger_type.in_([
                FlowTriggerType.CRON.value,
                FlowTriggerType.INTERVAL.value,
                FlowTriggerType.ONE_TIME.value,
            ]),
        )
        .all()
    )


def execute_flow(db, flow: FlowResource) -> None:
    """
    Execute a single flow by creating an execution record.

    The actual task execution is handled asynchronously by the task system.
    """
    try:
        flow_crd = Flow.model_validate(flow.json)
        trigger_type = flow.trigger_type

        # Determine trigger reason based on trigger type
        if trigger_type == FlowTriggerType.CRON.value:
            trigger_reason = f"Scheduled (cron: {flow_crd.spec.trigger.cron.expression})"
        elif trigger_type == FlowTriggerType.INTERVAL.value:
            interval = flow_crd.spec.trigger.interval
            trigger_reason = f"Scheduled (interval: {interval.value} {interval.unit})"
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

        logger.info(
            f"[flow_scheduler] Created execution {execution.id} for flow {flow.id} ({flow.name})"
        )

        # Update flow's next execution time
        flow_crd = Flow.model_validate(flow.json)
        trigger_config = flow_service._extract_trigger_config(flow_crd.spec.trigger)

        if trigger_type == FlowTriggerType.ONE_TIME.value:
            # One-time flows should be disabled after execution
            flow.enabled = False
            flow.next_execution_time = None
            flow_crd.spec.enabled = False
            flow.json = flow_crd.model_dump(mode="json")
            logger.info(
                f"[flow_scheduler] One-time flow {flow.id} disabled after execution"
            )
        else:
            # Calculate next execution time for recurring flows
            flow.next_execution_time = flow_service._calculate_next_execution_time(
                trigger_type, trigger_config
            )
            logger.info(
                f"[flow_scheduler] Next execution for flow {flow.id}: {flow.next_execution_time}"
            )

        db.commit()

        # TODO: Trigger actual task execution via the task system
        # This would involve calling the task creation API or directly
        # creating a task associated with this execution
        _trigger_task_execution(db, flow, execution)

    except Exception as e:
        logger.error(
            f"[flow_scheduler] Error executing flow {flow.id} ({flow.name}): {str(e)}"
        )
        db.rollback()


def _trigger_task_execution(db, flow: FlowResource, execution) -> None:
    """
    Trigger the actual task execution for a flow.

    This function:
    1. Uses task_kinds_service.create_task_or_append to create Task and Subtasks
    2. For Chat Shell type: triggers AI response via trigger_ai_response
    3. For Executor type: subtasks are picked up by executor_manager automatically

    The task completion status is monitored separately to update Flow execution status.
    """
    try:
        from app.schemas.task import TaskCreate
        from app.services.adapters.task_kinds import task_kinds_service
        from app.services.chat.config import should_use_direct_chat

        flow_crd = Flow.model_validate(flow.json)

        # Get team
        team = (
            db.query(Kind)
            .filter(Kind.id == flow.team_id, Kind.kind == "Team", Kind.is_active == True)
            .first()
        )

        if not team:
            logger.error(f"[flow_scheduler] Team {flow.team_id} not found for flow {flow.id}")
            flow_service.update_execution_status(
                db,
                execution_id=execution.id,
                status=FlowExecutionStatus.FAILED,
                error_message=f"Team {flow.team_id} not found",
            )
            return

        # Get user
        user = db.query(User).filter(User.id == flow.user_id).first()
        if not user:
            logger.error(f"[flow_scheduler] User {flow.user_id} not found for flow {flow.id}")
            flow_service.update_execution_status(
                db,
                execution_id=execution.id,
                status=FlowExecutionStatus.FAILED,
                error_message=f"User {flow.user_id} not found",
            )
            return

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

        # Use task_kinds_service to create task and subtasks
        # This handles both Task creation and Subtask creation
        task_dict = task_kinds_service.create_task_or_append(
            db=db,
            obj_in=task_create,
            user=user,
            task_id=None,  # Create new task
        )

        task_id = task_dict["id"]

        # Add flow-specific labels to the task
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
                task_crd.metadata.labels["executionId"] = str(execution.id)
                # Add flowExecutionId for executor_kinds to update Flow execution status
                task_crd.metadata.labels["flowExecutionId"] = str(execution.id)
            task.json = task_crd.model_dump(mode="json")
            db.commit()
        # Link task to execution
        execution.task_id = task_id
        execution.status = FlowExecutionStatus.RUNNING.value
        db.commit()

        logger.info(
            f"[flow_scheduler] Created task {task_id} for flow execution {execution.id}"
        )

        # Check if this is a Chat Shell type team
        supports_direct_chat = should_use_direct_chat(db, team, flow.user_id)

        if supports_direct_chat:
            # For Chat Shell type, we need to trigger AI response
            # This is done asynchronously in a background task
            logger.info(
                f"[flow_scheduler] Chat Shell type detected, triggering AI response for task {task_id}"
            )
            _trigger_chat_shell_response(
                db, task_id, team, user, execution.prompt or "", execution.id
            )
        else:
            # For Executor type (ClaudeCode, Agno, Dify, etc.)
            # The subtask is already in PENDING status
            # executor_manager will pick it up automatically
            logger.info(
                f"[flow_scheduler] Executor type detected, task {task_id} will be picked up by executor_manager"
            )

    except Exception as e:
        logger.error(
            f"[flow_scheduler] Error triggering task for flow {flow.id}: {str(e)}",
            exc_info=True,
        )
        flow_service.update_execution_status(
            db,
            execution_id=execution.id,
            status=FlowExecutionStatus.FAILED,
            error_message=str(e),
        )


def _trigger_chat_shell_response(
    db, task_id: int, team: Kind, user: User, message: str, execution_id: int
) -> None:
    """
    Trigger Chat Shell AI response for a flow task.

    This function creates the necessary context and triggers the AI response
    using the same mechanism as WebSocket chat:send.

    Note: Unlike WebSocket requests which run in FastAPI's main event loop,
    Flow Scheduler runs in a background thread with its own event loop.
    We must wait for the streaming task to complete before closing the loop.

    Args:
        db: Database session
        task_id: Task ID
        team: Team Kind object
        user: User object
        message: User message
        execution_id: FlowExecution ID for status updates
    """
    try:
        from app.services.chat.trigger.core import (
            StreamTaskData,
            _stream_chat_response,
        )
        from app.services.chat.trigger.emitter import FlowEventEmitter

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
                f"[flow_scheduler] No pending assistant subtask found for task {task_id}"
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
            logger.error(f"[flow_scheduler] Task {task_id} not found")
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
        # This prevents DetachedInstanceError when the session is closed
        stream_data = StreamTaskData.from_orm(task, team, user, assistant_subtask)

        # Run the streaming directly in a new event loop
        # Unlike trigger_ai_response which creates a background task,
        # we call _stream_chat_response directly and wait for it to complete
        #
        # Use FlowEventEmitter to update FlowExecution status when streaming
        # completes or fails. This ensures Flow execution status is properly
        # tracked even without WebSocket connections.
        flow_emitter = FlowEventEmitter(execution_id=execution_id)

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
                    event_emitter=flow_emitter,  # Update FlowExecution status
                )
            )
            logger.info(
                f"[flow_scheduler] Chat Shell AI response completed for task {task_id}"
            )
        finally:
            loop.close()

    except Exception as e:
        logger.error(
            f"[flow_scheduler] Error triggering Chat Shell response for task {task_id}: {str(e)}",
            exc_info=True,
        )


def flow_scheduler_worker(stop_event: threading.Event) -> None:
    """
    Background worker for the flow scheduler.

    Periodically checks for flows that need execution and triggers them.
    """
    logger.info("[flow_scheduler] Flow scheduler worker started")

    while not stop_event.is_set():
        try:
            # Create async runtime for distributed locking
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)

            # Try to acquire distributed lock
            lock_acquired = loop.run_until_complete(acquire_flow_scheduler_lock())

            if not lock_acquired:
                logger.debug(
                    "[flow_scheduler] Another instance is running the scheduler, skipping"
                )
            else:
                try:
                    logger.debug("[flow_scheduler] Starting scheduler cycle")

                    db = SessionLocal()
                    try:
                        now = datetime.now()
                        due_flows = get_due_flows(db, now)

                        if due_flows:
                            logger.info(
                                f"[flow_scheduler] Found {len(due_flows)} flow(s) due for execution"
                            )

                            for flow in due_flows:
                                execute_flow(db, flow)
                        else:
                            logger.debug("[flow_scheduler] No flows due for execution")

                    finally:
                        db.close()

                    logger.debug("[flow_scheduler] Scheduler cycle completed")

                except Exception as e:
                    logger.error(f"[flow_scheduler] Error in scheduler cycle: {str(e)}")

                finally:
                    # Release lock
                    try:
                        loop.run_until_complete(release_flow_scheduler_lock())
                    except Exception as e:
                        logger.error(f"[flow_scheduler] Error releasing lock: {str(e)}")

            loop.close()

        except Exception as e:
            logger.error(f"[flow_scheduler] Worker error: {str(e)}")

        # Wait for next cycle
        stop_event.wait(timeout=FLOW_SCHEDULER_INTERVAL_SECONDS)

    logger.info("[flow_scheduler] Flow scheduler worker stopped")


def start_flow_scheduler(app) -> None:
    """
    Start the flow scheduler background worker.

    Args:
        app: FastAPI application instance
    """
    app.state.flow_scheduler_stop_event = threading.Event()
    app.state.flow_scheduler_thread = threading.Thread(
        target=flow_scheduler_worker,
        args=(app.state.flow_scheduler_stop_event,),
        name="flow-scheduler-worker",
        daemon=True,
    )
    app.state.flow_scheduler_thread.start()
    logger.info("[flow_scheduler] Flow scheduler worker started")


def stop_flow_scheduler(app) -> None:
    """
    Stop the flow scheduler background worker.

    Args:
        app: FastAPI application instance
    """
    stop_event = getattr(app.state, "flow_scheduler_stop_event", None)
    thread = getattr(app.state, "flow_scheduler_thread", None)

    if stop_event:
        stop_event.set()

    if thread:
        thread.join(timeout=5.0)

    logger.info("[flow_scheduler] Flow scheduler worker stopped")
