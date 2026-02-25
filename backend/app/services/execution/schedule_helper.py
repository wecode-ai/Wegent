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
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any

from sqlalchemy.orm import Session

logger = logging.getLogger(__name__)


def schedule_dispatch(task_id: int) -> None:
    """Schedule async dispatch of a task from sync context.

    This function is designed to be called from synchronous code (e.g., after
    creating/updating a task). It handles finding an event loop and scheduling
    the async dispatch operation.

    This replaces the former task_dispatcher.schedule_dispatch() method,
    using HTTP+Callback mode via execution_dispatcher.

    Args:
        task_id: Task ID to dispatch
    """
    for strategy in _get_dispatch_strategies():
        if strategy.can_handle():
            strategy.execute(task_id)
            return

    logger.error(f"No suitable dispatch strategy found for task {task_id}")


def _get_dispatch_strategies() -> list:
    """Get ordered list of dispatch strategies to try.

    Returns:
        List of dispatch strategies in priority order
    """
    return [
        _RunningLoopStrategy(),
        _MainLoopStrategy(),
        _NewLoopStrategy(),
    ]


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


# Thread pool for running async dispatch in separate threads
_thread_pool: ThreadPoolExecutor | None = None


def _get_thread_pool() -> ThreadPoolExecutor:
    """Get or create the shared thread pool."""
    global _thread_pool
    if _thread_pool is None:
        _thread_pool = ThreadPoolExecutor(max_workers=5)
    return _thread_pool


async def _dispatch_task_async(task_id: int) -> None:
    """Async dispatch a single task using HTTP+Callback mode.

    This function:
    1. Queries database for task, subtask, user, team info
    2. Builds ExecutionRequest using TaskRequestBuilder
    3. Dispatches via HTTP+Callback mode

    Args:
        task_id: Task ID to dispatch
    """
    from app.api.dependencies import get_db
    from app.models.subtask import Subtask, SubtaskStatus
    from app.models.task import TaskResource
    from app.schemas.kind import Task as TaskCRD
    from app.services.readers.kinds import KindType, kindReader
    from shared.models.db import User

    from .dispatcher import execution_dispatcher
    from .request_builder import TaskRequestBuilder

    db = next(get_db())
    try:
        # Query task
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
            )
            .first()
        )

        if not task:
            logger.error(f"[schedule_dispatch] Task {task_id} not found")
            return

        # Query PENDING subtasks for this task
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.status == SubtaskStatus.PENDING,
            )
            .all()
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

        for subtask in subtasks:
            try:
                # Update subtask status to RUNNING
                subtask.status = SubtaskStatus.RUNNING
                db.commit()

                # Get message from subtask
                message = subtask.prompt or ""

                # Build ExecutionRequest
                request = builder.build(
                    subtask=subtask,
                    task=task,
                    user=user,
                    team=team,
                    message=message,
                )

                # Dispatch using HTTP+Callback mode
                await execution_dispatcher.dispatch(request)

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
                subtask.status = SubtaskStatus.FAILED
                subtask.error_message = str(e)
                db.commit()

    except Exception as e:
        logger.error(
            f"[schedule_dispatch] Failed to dispatch task {task_id}: {e}",
            exc_info=True,
        )
    finally:
        db.close()


# Dispatch strategy pattern for handling different event loop contexts
class _DispatchStrategy(ABC):
    """Abstract base class for task dispatch strategies."""

    @abstractmethod
    def can_handle(self) -> bool:
        """Check if this strategy can handle the current context.

        Returns:
            True if this strategy is applicable, False otherwise
        """
        pass

    @abstractmethod
    def execute(self, task_id: int) -> None:
        """Execute the dispatch using this strategy.

        Args:
            task_id: Task ID to dispatch
        """
        pass


class _RunningLoopStrategy(_DispatchStrategy):
    """Strategy for when there's already a running event loop.

    This happens in async contexts (e.g., FastAPI endpoints, Celery with async).
    We need to run in a separate thread to avoid blocking.
    """

    def can_handle(self) -> bool:
        try:
            asyncio.get_running_loop()
            return True
        except RuntimeError:
            return False

    def execute(self, task_id: int) -> None:
        logger.info(
            f"[schedule_dispatch] Using running loop strategy for task_id={task_id}"
        )

        def run_in_thread():
            return _run_in_new_loop(_dispatch_task_async(task_id))

        # Submit to thread pool without blocking
        future = _get_thread_pool().submit(run_in_thread)

        # Add callback for logging
        def log_result(f):
            try:
                f.result(timeout=30)
                logger.info(
                    f"[schedule_dispatch] Task completed in thread for task_id={task_id}"
                )
            except Exception as e:
                logger.error(
                    f"[schedule_dispatch] Task failed in thread for task_id={task_id}: {e}",
                    exc_info=True,
                )

        future.add_done_callback(log_result)


class _MainLoopStrategy(_DispatchStrategy):
    """Strategy for using the main event loop (FastAPI context).

    This is the preferred approach when no loop is running but the main
    loop is available and running.
    """

    def can_handle(self) -> bool:
        try:
            from app.services.chat.webpage_ws_chat_emitter import get_main_event_loop

            main_loop = get_main_event_loop()
            return main_loop is not None and main_loop.is_running()
        except Exception:
            return False

    def execute(self, task_id: int) -> None:
        try:
            from app.services.chat.webpage_ws_chat_emitter import get_main_event_loop

            main_loop = get_main_event_loop()
            asyncio.run_coroutine_threadsafe(_dispatch_task_async(task_id), main_loop)
            logger.debug(
                f"[schedule_dispatch] Scheduled dispatch on main loop for task {task_id}"
            )
        except Exception as e:
            logger.error(
                f"[schedule_dispatch] Failed to schedule on main loop for task {task_id}: {e}",
                exc_info=True,
            )
            raise


class _NewLoopStrategy(_DispatchStrategy):
    """Strategy for creating a new event loop (Celery worker context).

    This is the fallback when no event loop is available. It's synchronous
    but necessary in some contexts like Celery workers.
    """

    def can_handle(self) -> bool:
        # This strategy always works as a fallback
        return True

    def execute(self, task_id: int) -> None:
        try:
            _run_in_new_loop(_dispatch_task_async(task_id))
            logger.info(
                f"[schedule_dispatch] Dispatched task {task_id} via new event loop"
            )
        except Exception as e:
            logger.error(
                f"[schedule_dispatch] Failed to dispatch task {task_id}: {e}",
                exc_info=True,
            )
