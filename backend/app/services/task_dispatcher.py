# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for pushing tasks to executor_manager.

This module provides task dispatch functionality with support for:
- JWT authentication for secure communication
- Retry mechanism with configurable max retries
- Online/offline queue routing
"""

import asyncio
import logging
import os
from abc import ABC, abstractmethod
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Dict, List, Optional

import httpx

from app.core.security import create_access_token

logger = logging.getLogger(__name__)


def _generate_auth_token_from_task(task: Dict[str, Any]) -> Optional[str]:
    """Generate auth token from task's user info.

    Extracts user information from task data and generates a JWT token
    that includes user_id for proper gateway routing (e.g., grayscale).

    Args:
        task: Task dictionary containing user info

    Returns:
        JWT token string, or None if generation fails
    """
    try:
        user_info = task.get("user", {})
        user_id = user_info.get("id")
        user_name = user_info.get("name") or "backend-dispatch"

        token_data = {"sub": user_name}
        if user_id:
            token_data["user_id"] = user_id

        return create_access_token(data=token_data)
    except Exception as e:
        logger.error(f"Failed to generate auth token from task: {e}")
        return None


class TaskDispatcher:
    """Push tasks to executor_manager.

    This service is used in push mode to actively dispatch tasks
    to executor_manager instead of waiting for it to poll.
    Includes retry mechanism with configurable max retries.
    """

    def __init__(self):
        """Initialize the task dispatcher."""
        # Use localhost by default for local development
        # Override with docker hostname in production via EXECUTOR_MANAGER_URL
        self.base_url = os.getenv("EXECUTOR_MANAGER_URL", "http://localhost:8001")
        self.enabled = os.getenv("TASK_DISPATCH_MODE", "push") == "push"
        self.timeout = float(os.getenv("TASK_DISPATCH_TIMEOUT", "10.0"))
        self.max_retries = int(os.getenv("TASK_DISPATCH_MAX_RETRIES", "3"))
        self.retry_delay = float(os.getenv("TASK_DISPATCH_RETRY_DELAY", "1.0"))

        if self.enabled:
            logger.info(
                f"TaskDispatcher enabled (push mode, url={self.base_url}, "
                f"max_retries={self.max_retries})"
            )
        else:
            # DEPRECATED: Pull mode is deprecated and will be removed in a future version.
            logger.warning(
                "TaskDispatcher disabled (pull mode) - pull mode is deprecated, "
                "please switch to push mode (TASK_DISPATCH_MODE=push)"
            )

    async def dispatch_pending_tasks(
        self,
        db,
        task_ids: Optional[List[int]] = None,
        limit: int = 10,
        task_type: str = "online",
    ) -> bool:
        """Format and push pending tasks to executor_manager.

        This method:
        1. Calls executor_kinds_service.dispatch_tasks to format and mark tasks as RUNNING
        2. Pushes the formatted tasks to executor_manager

        Args:
            db: Database session
            task_ids: Optional list of specific task IDs to dispatch
            limit: Maximum number of tasks to dispatch
            task_type: Task type ('online' or 'offline'), determines which
                       queue the tasks will be routed to

        Returns:
            True if successful, False otherwise
        """
        if not self.enabled:
            logger.debug("Push mode disabled, skipping dispatch_pending_tasks")
            return True

        try:
            from app.services.adapters.executor_kinds import executor_kinds_service

            # Format tasks using existing service (this also updates status to RUNNING)
            result = await executor_kinds_service.dispatch_tasks(
                db=db,
                status="PENDING",
                limit=limit,
                task_ids=task_ids,
                type=task_type,
            )

            formatted_tasks = result.get("tasks", [])
            if not formatted_tasks:
                logger.debug(f"No pending {task_type} tasks to dispatch")
                return True

            # Push to executor_manager with appropriate queue_type
            return await self.dispatch_tasks(formatted_tasks, queue_type=task_type)

        except Exception as e:
            logger.error(f"Error in dispatch_pending_tasks: {e}")
            return False

    async def dispatch_tasks(
        self, tasks: List[Dict[str, Any]], queue_type: str = "online"
    ) -> bool:
        """Push formatted tasks to executor_manager.

        Includes retry mechanism. On final failure, marks tasks as FAILED.

        Args:
            tasks: List of formatted task dictionaries
            queue_type: Queue type ('online' or 'offline'), determines which
                        queue the tasks will be routed to on executor_manager side

        Returns:
            True if dispatch succeeded, False otherwise
        """
        if not self.enabled:
            logger.debug("Push mode disabled, skipping dispatch")
            return True

        if not tasks:
            return True

        if not self.base_url:
            logger.error("No EXECUTOR_MANAGER_URL configured")
            await self._mark_tasks_failed(tasks, "No EXECUTOR_MANAGER_URL configured")
            return False

        # Include queue_type parameter for routing to online/offline queue
        url = f"{self.base_url}/executor-manager/tasks/receive?queue_type={queue_type}"

        # Use the first task's auth_token for authentication
        # This token is already generated for task execution
        auth_token = tasks[0].get("auth_token")
        if not auth_token:
            logger.warning(
                "[TaskDispatcher] No auth_token in task, generating new one for dispatch"
            )
            auth_token = _generate_auth_token_from_task(tasks[0])

        headers = {"Content-Type": "application/json"}
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"
            logger.info("[TaskDispatcher] Using auth_token for authentication")

        # Propagate request_id for distributed tracing
        try:
            from shared.telemetry.context import get_request_id

            request_id = get_request_id()
            if request_id:
                headers["X-Request-ID"] = request_id
        except Exception:
            pass  # Ignore if telemetry module not available

        # Retry loop
        last_error = None
        for attempt in range(1, self.max_retries + 1):
            try:
                async with httpx.AsyncClient(timeout=self.timeout) as client:
                    response = await client.post(
                        url, json={"tasks": tasks}, headers=headers
                    )

                    if response.status_code == 200:
                        task_ids = [t.get("task_id") for t in tasks]
                        subtask_ids = [t.get("subtask_id") for t in tasks]
                        logger.info(
                            f"Push mode: dispatched {len(tasks)} tasks (queue={queue_type}): "
                            f"task_ids={task_ids}, subtask_ids={subtask_ids}"
                        )
                        return True
                    else:
                        last_error = (
                            f"HTTP {response.status_code}: {response.text[:200]}"
                        )
                        logger.warning(
                            f"Push mode: dispatch attempt {attempt}/{self.max_retries} "
                            f"failed to {url}: {last_error}"
                        )

            except httpx.TimeoutException:
                last_error = "Request timeout"
                logger.warning(
                    f"Push mode: dispatch attempt {attempt}/{self.max_retries} "
                    f"timed out to {url}"
                )
            except Exception as e:
                last_error = str(e)
                logger.warning(
                    f"Push mode: dispatch attempt {attempt}/{self.max_retries} "
                    f"error to {url}: {e}"
                )

            # Wait before retry (except on last attempt)
            if attempt < self.max_retries:
                await asyncio.sleep(self.retry_delay)

        # All retries exhausted - mark tasks as FAILED
        error_msg = f"Failed to dispatch after {self.max_retries} retries: {last_error}"
        logger.error(f"Push mode: {error_msg}")
        await self._mark_tasks_failed(tasks, error_msg)
        return False

    async def _mark_tasks_failed(
        self, tasks: List[Dict[str, Any]], error_message: str
    ) -> None:
        """Mark tasks as FAILED when dispatch fails after all retries.

        Args:
            tasks: List of task dictionaries that failed to dispatch
            error_message: Error message describing the failure
        """
        from sqlalchemy.orm.attributes import flag_modified

        from app.api.dependencies import get_db
        from app.models.subtask import Subtask, SubtaskStatus
        from app.models.task import TaskResource
        from app.schemas.kind import Task

        # Collect task info for WebSocket notifications
        ws_notifications: List[Dict[str, Any]] = []

        try:
            db = next(get_db())
            try:
                for task_data in tasks:
                    task_id = task_data.get("task_id")
                    subtask_id = task_data.get("subtask_id")
                    user_id = task_data.get("user", {}).get("id")

                    if not task_id or not subtask_id:
                        continue

                    # Update subtask status to FAILED
                    subtask = db.query(Subtask).filter(Subtask.id == subtask_id).first()
                    if subtask:
                        subtask.status = SubtaskStatus.FAILED
                        subtask.error_message = error_message
                        logger.info(f"Push mode: marked subtask {subtask_id} as FAILED")

                    # Update task status to FAILED
                    task = (
                        db.query(TaskResource)
                        .filter(
                            TaskResource.id == task_id,
                            TaskResource.kind == "Task",
                        )
                        .first()
                    )
                    if task:
                        task_crd = Task.model_validate(task.json)
                        if task_crd.status:
                            task_crd.status.status = "FAILED"
                            task_crd.status.errorMessage = error_message
                        task.json = task_crd.model_dump(mode="json", exclude_none=True)
                        # Mark JSON field as modified so SQLAlchemy detects the change
                        flag_modified(task, "json")
                        logger.info(f"Push mode: marked task {task_id} as FAILED")

                        # Collect for WebSocket notification
                        if user_id:
                            ws_notifications.append(
                                {
                                    "user_id": user_id,
                                    "task_id": task_id,
                                    "subtask_id": subtask_id,
                                }
                            )

                db.commit()

                # Send WebSocket notifications after commit
                for notification in ws_notifications:
                    await self._emit_task_failed_ws_event(
                        user_id=notification["user_id"],
                        task_id=notification["task_id"],
                        subtask_id=notification["subtask_id"],
                        error_message=error_message,
                    )

            finally:
                db.close()

        except Exception as e:
            logger.error(f"Push mode: failed to mark tasks as FAILED: {e}")

    async def _dispatch_task_async(self, task_id: int) -> None:
        """Async dispatch a single task to executor_manager.

        Args:
            task_id: Task ID to dispatch
        """
        try:
            from app.api.dependencies import get_db
            from app.services.adapters.executor_kinds import executor_kinds_service

            # Create a new db session for async context
            db = next(get_db())
            try:
                result = await executor_kinds_service.dispatch_tasks(
                    db=db,
                    status="PENDING",
                    limit=10,
                    task_ids=[task_id],
                    type="online",
                )
                formatted_tasks = result.get("tasks", [])
                if formatted_tasks:
                    # Push formatted tasks to executor_manager
                    await self.dispatch_tasks(formatted_tasks, queue_type="online")
                    logger.info(
                        f"Push mode: dispatched {len(formatted_tasks)} subtasks "
                        f"for task {task_id}"
                    )
                else:
                    logger.debug(
                        f"Push mode: no PENDING subtasks found for task {task_id}"
                    )
            finally:
                db.close()
        except Exception as e:
            logger.error(
                f"Push mode: failed to dispatch task {task_id}: {e}",
                exc_info=True,
            )

    def schedule_dispatch(self, task_id: int) -> None:
        """Schedule async dispatch of a task from sync context.

        This method is designed to be called from synchronous code (e.g., after
        creating/updating a task). It handles finding an event loop and scheduling
        the async dispatch operation.

        Args:
            task_id: Task ID to dispatch
        """
        if not self.enabled:
            return

        for strategy in self._get_dispatch_strategies():
            if strategy.can_handle():
                strategy.execute(task_id)
                return

        logger.error(f"No suitable dispatch strategy found for task {task_id}")

    def _get_dispatch_strategies(self) -> List["_DispatchStrategy"]:
        """Get ordered list of dispatch strategies to try.

        Returns:
            List of dispatch strategies in priority order
        """
        return [
            _RunningLoopStrategy(self),
            _MainLoopStrategy(self),
            _NewLoopStrategy(self),
        ]

    def _run_in_new_loop(self, coro) -> Any:
        """Run coroutine in a new event loop.

        Helper method to avoid code duplication when creating new event loops.

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
                loop.run_until_complete(
                    asyncio.gather(*pending, return_exceptions=True)
                )
            return result
        finally:
            loop.close()

    async def _emit_task_failed_ws_event(
        self,
        user_id: int,
        task_id: int,
        subtask_id: int,
        error_message: str,
    ) -> None:
        """Emit WebSocket events to notify frontend of task failure.

        Args:
            user_id: User ID who owns the task
            task_id: Task ID
            subtask_id: Subtask ID
            error_message: Error message describing the failure
        """
        try:
            from app.services.chat.ws_emitter import get_ws_emitter

            ws_emitter = get_ws_emitter()
            if ws_emitter:
                # Emit task:status event to user room
                await ws_emitter.emit_task_status(
                    user_id=user_id,
                    task_id=task_id,
                    status="FAILED",
                    progress=0,
                )
                logger.info(
                    f"Push mode: emitted task:status FAILED for task={task_id} user={user_id}"
                )

                # Emit chat:error event to task room
                await ws_emitter.emit_chat_error(
                    task_id=task_id,
                    subtask_id=subtask_id,
                    error=error_message,
                    error_type="dispatch_failed",
                )
                logger.info(
                    f"Push mode: emitted chat:error for task={task_id} subtask={subtask_id}"
                )
            else:
                logger.warning(
                    f"Push mode: ws_emitter is None, cannot emit WebSocket events for task={task_id}"
                )
        except Exception as e:
            logger.error(
                f"Push mode: failed to emit WebSocket events for task={task_id}: {e}"
            )


# Dispatch strategy pattern for handling different event loop contexts
class _DispatchStrategy(ABC):
    """Abstract base class for task dispatch strategies."""

    def __init__(self, dispatcher: TaskDispatcher):
        self.dispatcher = dispatcher

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
            f"[TaskDispatcher] Using running loop strategy for task_id={task_id}"
        )

        # Use shared thread pool to avoid creating new executor each time
        if not hasattr(self.dispatcher, "_thread_pool"):
            self.dispatcher._thread_pool = ThreadPoolExecutor(max_workers=5)

        def run_in_thread():
            return self.dispatcher._run_in_new_loop(
                self.dispatcher._dispatch_task_async(task_id)
            )

        # Submit to thread pool without blocking
        future = self.dispatcher._thread_pool.submit(run_in_thread)

        # Add callback for logging
        def log_result(f):
            try:
                f.result(timeout=30)
                logger.info(
                    f"[TaskDispatcher] Task completed in thread for task_id={task_id}"
                )
            except Exception as e:
                logger.error(
                    f"[TaskDispatcher] Task failed in thread for task_id={task_id}: {e}",
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
            from app.services.chat.ws_emitter import get_main_event_loop

            main_loop = get_main_event_loop()
            return main_loop is not None and main_loop.is_running()
        except Exception:
            return False

    def execute(self, task_id: int) -> None:
        try:
            from app.services.chat.ws_emitter import get_main_event_loop

            main_loop = get_main_event_loop()
            asyncio.run_coroutine_threadsafe(
                self.dispatcher._dispatch_task_async(task_id), main_loop
            )
            logger.debug(
                f"Push mode: scheduled dispatch on main loop for task {task_id}"
            )
        except Exception as e:
            logger.error(
                f"Push mode: failed to schedule on main loop for task {task_id}: {e}",
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
            self.dispatcher._run_in_new_loop(
                self.dispatcher._dispatch_task_async(task_id)
            )
            logger.info(f"Push mode: dispatched task {task_id} via new event loop")
        except Exception as e:
            logger.error(
                f"Push mode: failed to dispatch task {task_id}: {e}",
                exc_info=True,
            )


# Global instance
task_dispatcher = TaskDispatcher()
