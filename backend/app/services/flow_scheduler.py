# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Flow scheduler for triggering scheduled Flow executions.

This module integrates with the existing background job system to periodically
check for flows that need to be executed and trigger them.
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
from app.schemas.flow import Flow, FlowExecutionStatus, FlowTriggerType
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

    This creates a Task resource and links it to the flow execution.
    The task will be executed by the existing task execution system.
    """
    try:
        from app.models.task import TaskResource
        from app.models.kind import Kind

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

        # Get workspace if specified
        workspace = None
        git_url = ""
        git_repo = ""
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
                git_url = ws_json.get("spec", {}).get("repository", {}).get("url", "")
                git_repo = ws_json.get("spec", {}).get("repository", {}).get("name", "")
                git_domain = ws_json.get("spec", {}).get("repository", {}).get("domain", "")
                branch_name = ws_json.get("spec", {}).get("repository", {}).get("branch", "")

        # Create task resource
        import uuid
        from sqlalchemy.orm.attributes import flag_modified

        task_name = f"flow-{flow.id}-exec-{execution.id}-{uuid.uuid4().hex[:8]}"

        task_json = {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": task_name,
                "namespace": flow.namespace,
            },
            "spec": {
                "teamRef": {
                    "name": team.name,
                    "namespace": team.namespace,
                },
                "workspaceRef": (
                    {
                        "name": workspace.name if workspace else "",
                        "namespace": workspace.namespace if workspace else "",
                    }
                    if workspace
                    else None
                ),
                "prompt": execution.prompt,
            },
            "status": {
                "phase": "PENDING",
                "progress": 0,
            },
        }

        task = TaskResource(
            user_id=flow.user_id,
            kind="Task",
            name=task_name,
            namespace=flow.namespace,
            json=task_json,
            is_active=True,
        )

        db.add(task)
        db.commit()
        db.refresh(task)

        # Link task to execution
        execution.task_id = task.id
        execution.status = FlowExecutionStatus.PENDING.value
        db.commit()

        logger.info(
            f"[flow_scheduler] Created task {task.id} for flow execution {execution.id}"
        )

        # Update execution status to running
        flow_service.update_execution_status(
            db,
            execution_id=execution.id,
            status=FlowExecutionStatus.RUNNING,
        )

    except Exception as e:
        logger.error(
            f"[flow_scheduler] Error triggering task for flow {flow.id}: {str(e)}"
        )
        flow_service.update_execution_status(
            db,
            execution_id=execution.id,
            status=FlowExecutionStatus.FAILED,
            error_message=str(e),
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
                        now = datetime.utcnow()
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
