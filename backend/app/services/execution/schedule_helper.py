# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schedule helper for dispatching tasks from sync context.

This module provides utilities for scheduling task dispatch from synchronous code,
handling the async-to-sync context switching and database queries.
"""

import asyncio
import logging
from typing import Any

from sqlalchemy.orm import Session

from app.core.bounded_executor import BoundedExecutor
from app.utils.prompt_utils import extract_display_prompt
from shared.telemetry.decorators import add_span_event, trace_async

logger = logging.getLogger(__name__)

_RECOVERY_IO_EXECUTOR = BoundedExecutor(
    max_workers=5,
    max_in_flight=10,
    thread_name_prefix="wegent-recovery-io",
)
_DISPATCH_EXECUTOR = BoundedExecutor(
    max_workers=5,
    max_in_flight=20,
    thread_name_prefix="wegent-schedule-dispatch",
)


class ScheduleDispatchOverloaded(RuntimeError):
    """Raised instead of placing task dispatch in an unbounded queue."""


def _extract_device_id_from_executor_name(executor_name: str | None) -> str | None:
    """Extract a device ID from a device-mode executor name."""
    if not executor_name or not executor_name.startswith("device-"):
        return None
    device_id = executor_name[len("device-") :].strip()
    return device_id or None


def schedule_dispatch(task_id: int) -> None:
    """Submit dispatch outside the caller loop with finite admission capacity."""
    future = _DISPATCH_EXECUTOR.submit_nowait(_dispatch_task_in_worker, task_id)
    if future is None:
        raise ScheduleDispatchOverloaded(
            "Task dispatch capacity is exhausted; refusing unbounded queueing"
        )

    def log_result(completed) -> None:
        try:
            completed.result()
            logger.info(
                "[schedule_dispatch] Background dispatch completed task_id=%s",
                task_id,
            )
        except Exception:
            logger.exception(
                "[schedule_dispatch] Background dispatch failed task_id=%s",
                task_id,
            )

    future.add_done_callback(log_result)


def _run_in_new_loop(coro) -> Any:
    """Run coroutine in a new event loop.

    Helper function to avoid code duplication when creating new event loops.

    Args:
        coro: Coroutine to execute

    Returns:
        Result of the coroutine execution
    """
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        result = loop.run_until_complete(coro)
        # Wait for pending tasks (e.g., WebSocket emissions)
        pending = asyncio.all_tasks(loop)
        current_task = asyncio.current_task(loop)
        pending = {t for t in pending if t is not current_task}
        if pending:
            logger.debug(f"Waiting for {len(pending)} pending tasks")
            loop.run_until_complete(asyncio.gather(*pending, return_exceptions=True))
        return result
    finally:
        loop.close()


def _resolve_dispatch_message(db: Session, subtask: "Subtask") -> str:
    """Resolve the user message that triggered a pending assistant subtask."""
    from app.stores.tasks import subtask_store

    assistant_prompt = extract_display_prompt(subtask.prompt) or ""
    if assistant_prompt:
        return assistant_prompt

    if not subtask.parent_id:
        return ""

    user_subtask = subtask_store.get_user_by_task_message_id(
        db,
        task_id=subtask.task_id,
        message_id=subtask.parent_id,
    )
    if not user_subtask:
        return ""

    return extract_display_prompt(user_subtask.prompt) or ""


async def _dispatch_task_async(task_id: int) -> None:
    """Async dispatch a single task using HTTP+Callback mode.

    This function:
    1. Queries database for task, subtask, user, team info
    2. Builds ExecutionRequest using TaskRequestBuilder
    3. Dispatches through execution_dispatcher

    Args:
        task_id: Task ID to dispatch
    """
    from app.api.dependencies import get_db
    from app.models.subtask import SubtaskStatus
    from app.schemas.kind import Task as TaskCRD
    from app.services.readers.kinds import KindType, kindReader
    from app.stores.tasks import subtask_store, task_store
    from shared.models.db import User

    from .dispatcher import execution_dispatcher
    from .request_builder import TaskRequestBuilder

    db = next(get_db())
    try:
        # Query task
        task = task_store.get_by_id(db, task_id=task_id)

        if not task or task.kind != "Task":
            logger.error(f"[schedule_dispatch] Task {task_id} not found")
            return

        # Query PENDING subtasks for this task
        subtasks = subtask_store.list_by_task_status(
            db,
            task_id=task_id,
            status=SubtaskStatus.PENDING,
        )
        if not subtasks:
            logger.debug(
                f"[schedule_dispatch] No PENDING subtasks found for task {task_id}"
            )
            return

        # Parse task CRD to get team reference
        task_crd = TaskCRD.model_validate(task.json)
        team_ref = task_crd.spec.teamRef

        if not team_ref:
            logger.error(f"[schedule_dispatch] Task {task_id} has no teamRef")
            return

        # Query team using kindReader which supports:
        # - Personal teams (owned by user)
        # - Shared teams (via ResourceMember table)
        # - Public teams (user_id=0)
        # - Group teams (namespace != 'default')
        team = kindReader.get_by_name_and_namespace(
            db, task.user_id, KindType.TEAM, team_ref.namespace, team_ref.name
        )

        if not team:
            logger.error(
                f"[schedule_dispatch] Team not found: {team_ref.namespace}/{team_ref.name}"
            )
            return

        # Query user
        user = db.query(User).filter(User.id == task.user_id).first()

        if not user:
            logger.error(f"[schedule_dispatch] User {task.user_id} not found")
            return

        # Build and dispatch each subtask
        builder = TaskRequestBuilder(db)
        task_labels = (task.json or {}).get("metadata", {}).get("labels", {})
        if not isinstance(task_labels, dict):
            task_labels = {}
        model_id = task_labels.get("modelId")
        override_model_name = model_id.strip() if isinstance(model_id, str) else None
        force_override = task_labels.get("forceOverrideBotModel") == "true" and bool(
            override_model_name
        )

        if force_override:
            logger.info(
                "[schedule_dispatch] Applying task model override: "
                "task_id=%s, model_id=%s",
                task_id,
                override_model_name,
            )

        for subtask in subtasks:
            try:
                # Extract original user text from stored prompt to prevent
                # double-wrapping of already-formatted content arrays.
                message = _resolve_dispatch_message(db, subtask)

                # Build ExecutionRequest
                request = builder.build(
                    subtask=subtask,
                    task=task,
                    user=user,
                    team=team,
                    message=message,
                    override_model_name=override_model_name,
                    force_override=force_override,
                )

                # Check if executor needs recovery (deleted after previous completion)
                if subtask.executor_deleted_at:
                    logger.info(
                        f"[schedule_dispatch] Executor deleted for subtask {subtask.id}, "
                        f"attempting recovery"
                    )
                    recovery_success = await _recover_executor(
                        subtask=subtask,
                        task=task,
                        request=request,
                    )
                    if not recovery_success:
                        logger.error(
                            f"[schedule_dispatch] Failed to recover executor for subtask {subtask.id}"
                        )
                        subtask_store.update_fields(
                            db,
                            subtask=subtask,
                            status=SubtaskStatus.FAILED,
                            error_message="Failed to recover executor after Pod deletion",
                        )
                        db.commit()
                        continue

                # Soft-verify pod existence when DB still thinks it's alive.
                # A pod can disappear outside the cleanup path (OOM, eviction,
                # manual delete); without this check dispatch would fail and
                # the workspace archive would never be restored.
                elif (
                    subtask.executor_name
                    and not _extract_device_id_from_executor_name(subtask.executor_name)
                    and await _executor_pod_missing(
                        subtask.executor_name,
                        subtask.executor_namespace,
                    )
                ):
                    logger.info(
                        "[schedule_dispatch] Executor pod missing, marking deleted "
                        "task_id=%s subtask_id=%s executor=%s/%s",
                        task_id,
                        subtask.id,
                        subtask.executor_namespace,
                        subtask.executor_name,
                    )
                    subtask_store.update_fields(
                        db,
                        subtask=subtask,
                        executor_deleted_at=True,
                    )
                    db.commit()
                    recovery_success = await _recover_executor(
                        subtask=subtask,
                        task=task,
                        request=request,
                    )
                    if not recovery_success:
                        logger.error(
                            f"[schedule_dispatch] Failed to recover executor for subtask {subtask.id}"
                        )
                        subtask_store.update_fields(
                            db,
                            subtask=subtask,
                            status=SubtaskStatus.FAILED,
                            error_message="Failed to recover executor after Pod deletion",
                        )
                        db.commit()
                        continue

                # Update subtask status to RUNNING
                subtask_store.update_status(
                    db,
                    subtask=subtask,
                    status=SubtaskStatus.RUNNING,
                )
                db.commit()

                device_id = _extract_device_id_from_executor_name(subtask.executor_name)
                logger.info(
                    "[schedule_dispatch] Dispatching pending subtask: "
                    "task_id=%s, subtask_id=%s, device_id=%s, executor=%s/%s",
                    task_id,
                    subtask.id,
                    device_id,
                    subtask.executor_namespace,
                    subtask.executor_name,
                )

                await execution_dispatcher.dispatch(request, device_id=device_id)

                logger.info(
                    f"[schedule_dispatch] Dispatched subtask {subtask.id} "
                    f"for task {task_id}"
                )

            except Exception as e:
                logger.error(
                    f"[schedule_dispatch] Failed to dispatch subtask {subtask.id}: {e}",
                    exc_info=True,
                )
                # Mark subtask as FAILED
                subtask_store.update_fields(
                    db,
                    subtask=subtask,
                    status=SubtaskStatus.FAILED,
                    error_message=str(e),
                )
                db.commit()

    except Exception as e:
        logger.error(
            f"[schedule_dispatch] Failed to dispatch task {task_id}: {e}",
            exc_info=True,
        )
    finally:
        db.close()


@trace_async("execution.executor_pod_missing", "execution.schedule")
async def _executor_pod_missing(
    executor_name: str,
    executor_namespace: str | None,
) -> bool:
    """Return True only when executor_manager confirms the pod is gone.

    Wraps ``remote_workspace_service.executor_alive`` in a thread because the
    underlying httpx call is synchronous. Any transport/decoding failure is
    treated as "pod still alive" so dispatch surfaces the real error instead
    of triggering a spurious recovery.
    """
    from app.services.remote_workspace_service import remote_workspace_service

    try:
        alive = await _RECOVERY_IO_EXECUTOR.run(
            remote_workspace_service.executor_alive,
            executor_name,
            executor_namespace,
        )
    except Exception as exc:
        logger.warning(
            "[schedule_dispatch] executor_alive check failed executor=%s/%s error=%s",
            executor_namespace,
            executor_name,
            exc,
        )
        add_span_event(
            "execution.executor_pod_missing.check_failed",
            {
                "executor_name": executor_name,
                "executor_namespace": executor_namespace or "",
                "error": str(exc),
            },
        )
        return False
    return not alive


async def _recover_executor(
    subtask: "Subtask",
    task: "TaskResource",
    request,
) -> bool:
    """Recover executor Pod for a subtask after it was deleted.

    Called when executor_deleted_at=True, indicating the Pod was cleaned up
    after task completion. This function recreates the Pod and optionally
    restores the workspace from archive.

    Args:
        subtask: Subtask with deleted executor
        task: Parent task
        request: ExecutionRequest with the normal executor config

    Returns:
        True if recovery successful, False otherwise
    """
    from .recovery_service import recovery_service

    try:
        outcome = await recovery_service.recover_from_store(
            task_id=task.id,
            subtask_id=subtask.id,
            request=request,
        )
        if outcome.recovered:
            subtask.executor_name = outcome.executor_name
            subtask.executor_namespace = outcome.executor_namespace
            subtask.executor_deleted_at = False
            return True
        return False
    except RuntimeError:
        raise
    except Exception as e:
        logger.error(
            f"[schedule_dispatch] Error recovering executor for subtask {subtask.id}: {e}",
            exc_info=True,
        )
        return False


def _dispatch_task_in_worker(task_id: int) -> None:
    """Own all dispatch SQL and async I/O inside a dedicated worker thread."""
    _run_in_new_loop(_dispatch_task_async(task_id))
