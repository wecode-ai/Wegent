# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database handler for Chat Shell.

Note: This module is responsible ONLY for database operations.
WebSocket notifications should be handled by the emitter chain (WebSocketResultEmitter),
not by database operations. This follows the Single Responsibility Principle.

This module also provides:
- Thread pool executor for running sync DB operations without blocking event loop
- Context manager for database sessions with auto-rollback
- Utility function for running sync functions in executor

Other modules can use run_sync_in_executor() to wrap their sync DB functions.
"""

import asyncio
import json
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, Generator, Optional, TypeVar

from sqlalchemy.orm import Session

import app.stores.tasks as task_stores
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole
from app.models.task import TaskResource
from app.schemas.kind import TaskStatus
from app.services.adapters.collaboration_strategy import CollaborationStrategy

logger = logging.getLogger(__name__)

# Thread pool for database operations
# Increased max_workers to handle concurrent DB operations across the application
_db_executor = ThreadPoolExecutor(max_workers=20)

# Terminal statuses that mark completion
_TERMINAL_STATUSES = frozenset(["COMPLETED", "FAILED", "CANCELLED"])
PIPELINE_RECOVERY_KIND = "PipelineRecovery"
PIPELINE_RECOVERY_NAMESPACE = "internal"


T = TypeVar("T")


class TerminalPersistenceError(RuntimeError):
    """A terminal database transition could not be confirmed."""


@dataclass
class PipelineAutoAdvanceIntent:
    """Intent to continue a pipeline through the shared chat send path."""

    task_id: int
    user_id: int
    completed_subtask_id: int
    advance_info: dict[str, Any]
    next_pair: tuple[int, int] | None = None
    dispatch_acknowledged: bool = False

    @property
    def label(self) -> str:
        return f"pipelineAutoAdvance:{self.completed_subtask_id}"

    def write(self, payload: dict[str, Any]) -> None:
        metadata = payload.setdefault("metadata", {})
        labels = metadata.get("labels") or {}
        labels[self.label] = json.dumps(
            {
                "advance_info": self.advance_info,
                "next_pair": self.next_pair,
                "dispatch_acknowledged": self.dispatch_acknowledged,
            }
        )
        metadata["labels"] = labels

    @classmethod
    def read(
        cls, task: TaskResource, completed_subtask_id: int
    ) -> Optional["PipelineAutoAdvanceIntent"]:
        labels = task.json.get("metadata", {}).get("labels") or {}
        saved = labels.get(f"pipelineAutoAdvance:{completed_subtask_id}")
        if saved is None:
            return None
        data = json.loads(saved)
        pair = data["next_pair"]
        return cls(
            task.id,
            task.user_id,
            completed_subtask_id,
            data["advance_info"],
            (pair[0], pair[1]) if pair is not None else None,
            data.get("dispatch_acknowledged", False),
        )


def pipeline_recovery_key(task_id: int, subtask_id: int) -> str:
    return f"{task_id}:{subtask_id}"


def add_pipeline_recovery(db: Session, intent: PipelineAutoAdvanceIntent) -> None:
    db.add(
        Kind(
            kind=PIPELINE_RECOVERY_KIND,
            namespace=PIPELINE_RECOVERY_NAMESPACE,
            name=pipeline_recovery_key(intent.task_id, intent.completed_subtask_id),
            user_id=intent.user_id,
            json={},
            is_active=True,
        )
    )


def settle_pipeline_handoff(payload: dict[str, Any], subtask_id: int) -> None:
    """Retire a handoff only when its assistant's terminal write can commit."""
    labels = payload.get("metadata", {}).get("labels") or {}
    rust_marker = labels.get("pipelinePendingHandoff", "")
    if rust_marker.rsplit(":", 1)[-1] == str(subtask_id):
        labels.pop("pipelinePendingHandoff")
    for key in list(labels):
        if key.startswith("pipelineAutoAdvance:"):
            pair = json.loads(labels[key]).get("next_pair")
            if pair is not None and pair[1] == subtask_id:
                labels.pop(key)


@dataclass
class TaskStatusUpdateResult:
    """Post-commit work discovered while updating task status."""

    auto_advance: Optional[PipelineAutoAdvanceIntent] = None
    replay_result: dict[str, Any] | None = None


@contextmanager
def _db_session() -> Generator[Session, None, None]:
    """Context manager for database session with auto-rollback on error."""
    from app.db.session import SessionLocal

    db = SessionLocal()
    try:
        yield db
        db.commit()
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


class DatabaseHandler:
    """Handles database operations for chat service."""

    async def _run_in_executor(self, func: Callable[..., T], *args: Any) -> T:
        """Run a synchronous function in the thread pool executor."""
        return await asyncio.get_event_loop().run_in_executor(_db_executor, func, *args)

    async def update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        executor_name: str | None = None,
        executor_namespace: str | None = None,
        expected_status: str | None = None,
        expected_device: tuple[int, str] | None = None,
    ) -> bool:
        """Update subtask status asynchronously.

        Returns False when the subtask is missing or the transition is stale.
        Terminal database failures propagate to the caller.
        """
        update_result = await self._run_in_executor(
            self._update_subtask_sync,
            subtask_id,
            status,
            result,
            error,
            executor_name,
            executor_namespace,
            expected_status,
            expected_device,
        )
        if update_result is None:
            return False
        if update_result.auto_advance:
            from app.services.chat.pipeline_advance import (
                advance_pipeline_stage_from_auto_completion,
            )

            if not await advance_pipeline_stage_from_auto_completion(
                update_result.auto_advance
            ):
                return False
            if result is not None and update_result.replay_result is not None:
                result.clear()
                result.update(update_result.replay_result)
        return True

    def _update_subtask_sync(
        self,
        subtask_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
        executor_name: str | None = None,
        executor_namespace: str | None = None,
        expected_status: str | None = None,
        expected_device: tuple[int, str] | None = None,
    ) -> Optional[TaskStatusUpdateResult]:
        """Synchronous subtask update (runs in thread pool)."""
        from app.models.subtask import SubtaskStatus
        from app.utils.thinking_sanitizer import sanitize_result_for_storage

        try:
            with _db_session() as db:
                subtask = task_stores.subtask_store.get_basic_by_id(
                    db, subtask_id=subtask_id
                )
                if not subtask:
                    return None
                task_id = subtask.task_id
                terminal = status in _TERMINAL_STATUSES
                if terminal:
                    task = task_stores.task_store.get_by_id_for_update(
                        db, task_id=task_id
                    )
                    if (
                        task is None
                        or task.kind != "Task"
                        or task.is_active not in TaskResource.is_active_query()
                    ):
                        return None
                    db.expire(subtask)
                    subtask = task_stores.subtask_store.get_basic_by_id_for_update(
                        db, subtask_id=subtask_id
                    )
                    if (
                        subtask is None
                        or subtask.task_id != task_id
                        or subtask.status == SubtaskStatus.DELETE
                    ):
                        return None

                    if expected_device is not None:
                        owner, device_id = expected_device
                        if (
                            task.user_id != owner
                            or subtask.user_id != owner
                            or subtask.executor_name != f"device-{device_id}"
                            or subtask.executor_namespace != f"user-{owner}"
                        ):
                            return None

                    if subtask.status.value in _TERMINAL_STATUSES:
                        if status == subtask.status.value == "COMPLETED":
                            pending = PipelineAutoAdvanceIntent.read(task, subtask_id)
                            if pending is not None:
                                return TaskStatusUpdateResult(
                                    auto_advance=pending,
                                    replay_result=subtask.result or {},
                                )
                        return None

                fields: dict[str, Any] = {"status": SubtaskStatus(status)}

                if result is not None:
                    # Preserve silent_exit fields if they were set by MCP tool
                    # MCP silent_exit tool directly updates subtask.result before this
                    if subtask.result and isinstance(subtask.result, dict):
                        existing_silent_exit = subtask.result.get("silent_exit")
                        existing_silent_exit_reason = subtask.result.get(
                            "silent_exit_reason"
                        )
                        if existing_silent_exit:
                            result["silent_exit"] = existing_silent_exit
                            if existing_silent_exit_reason:
                                result["silent_exit_reason"] = (
                                    existing_silent_exit_reason
                                )
                            logger.info(
                                "[DB] Preserved silent_exit flag from MCP tool for subtask %s",
                                subtask_id,
                            )

                    # Log loaded_skills before sanitization for debugging
                    loaded_skills = result.get("loaded_skills", [])
                    if loaded_skills:
                        logger.info(
                            "[DB_HANDLER] Saving loaded_skills to database: "
                            "subtask_id=%d, status=%s, loaded_skills=%s",
                            subtask_id,
                            status,
                            loaded_skills,
                        )

                    # Sanitize thinking data before storing to database
                    sanitized_result = sanitize_result_for_storage(result)

                    # Log loaded_skills after sanitization to verify it's preserved
                    sanitized_loaded_skills = sanitized_result.get("loaded_skills", [])
                    if loaded_skills:
                        logger.info(
                            "[DB_HANDLER] After sanitization: subtask_id=%d, "
                            "loaded_skills_preserved=%s, sanitized_loaded_skills=%s",
                            subtask_id,
                            sanitized_loaded_skills == loaded_skills,
                            sanitized_loaded_skills,
                        )

                    fields["result"] = sanitized_result
                if error is not None:
                    fields["error_message"] = error
                if status in _TERMINAL_STATUSES:
                    fields["completed_at"] = datetime.now()

                # Save executor info for container reuse in follow-up tasks
                # Only update if provided and subtask doesn't already have executor_name
                if executor_name and not subtask.executor_name:
                    fields["executor_name"] = executor_name
                    fields["executor_namespace"] = executor_namespace or ""
                    logger.info(
                        "[DB] Saved executor info for subtask %s: "
                        "executor_name=%s, executor_namespace=%s",
                        subtask_id,
                        executor_name,
                        executor_namespace,
                    )

                if expected_status is not None:
                    changed = task_stores.subtask_store.update_fields_if_status(
                        db,
                        subtask=subtask,
                        from_status=SubtaskStatus(expected_status),
                        **fields,
                    )
                    if not changed:
                        logger.info(
                            "[DB] Skipped %s transition for subtask %s: "
                            "current status is no longer %s",
                            status,
                            subtask_id,
                            expected_status,
                        )
                        return None
                else:
                    task_stores.subtask_store.update_fields(
                        db, subtask=subtask, **fields
                    )
                if terminal:
                    db.flush()
                    if expected_status is not None:
                        db.expire(subtask)
                    update = self._update_task_status_in_session(
                        db, task, subtask_id, terminal=True
                    )
                    if update is None:
                        raise LookupError(
                            "No assistant subtask for terminal task status"
                        )
                    return update
            return self._update_task_status_sync(task_id, changed_subtask_id=subtask_id)
        except Exception as exc:
            logger.exception("Error updating subtask %s status", subtask_id)
            if status in _TERMINAL_STATUSES:
                raise TerminalPersistenceError(
                    f"Could not save terminal status for subtask {subtask_id}"
                ) from exc
            return None

    def _update_task_status_sync(
        self, task_id: int, changed_subtask_id: int | None = None
    ) -> TaskStatusUpdateResult:
        """Update task status based on subtask status using collaboration strategy."""
        try:
            with _db_session() as db:
                task = task_stores.task_store.get_task_by_states(
                    db,
                    task_id=task_id,
                    states=TaskResource.is_active_query(),
                )
                if task is not None:
                    return (
                        self._update_task_status_in_session(
                            db, task, changed_subtask_id
                        )
                        or TaskStatusUpdateResult()
                    )
        except Exception:
            logger.exception("Error updating task %s status", task_id)
        return TaskStatusUpdateResult()

    def _update_task_status_in_session(
        self,
        db: Session,
        task: TaskResource,
        changed_subtask_id: int | None,
        *,
        terminal: bool = False,
    ) -> Optional[TaskStatusUpdateResult]:
        from app.schemas.kind import Task
        from app.services.adapters.collaboration_strategy import (
            CollaborationStrategyFactory,
        )

        task_id = task.id
        update_result = TaskStatusUpdateResult()
        if getattr(task, "is_active", None) == TaskResource.STATE_SUBSCRIPTION:
            subtasks = task_stores.subtask_store.list_by_task_ordered(
                db,
                task_id=task_id,
                owner_user_id=task.user_id,
                roles=[SubtaskRole.ASSISTANT],
                recent_limit=1,
            )
        else:
            subtasks = task_stores.subtask_store.list_assistant_by_task(
                db,
                task_id=task_id,
                owner_user_id=task.user_id,
                include_contexts=False,
            )
        if not subtasks:
            return None

        task_crd = Task.model_validate(task.json)
        last_subtask = subtasks[-1]
        changed_subtask = None
        if changed_subtask_id is not None:
            changed_subtask = next(
                (subtask for subtask in subtasks if subtask.id == changed_subtask_id),
                None,
            )
            if changed_subtask is None:
                changed_subtask = task_stores.subtask_store.get_by_id(
                    db, subtask_id=changed_subtask_id
                )

        if task_crd.status:
            # Use collaboration strategy to determine task status
            strategy: CollaborationStrategy = (
                CollaborationStrategyFactory.get_strategy_for_task(db, task_id)
            )
            self._apply_status_update(
                db, task_id, task_crd.status, last_subtask, strategy
            )
            task_crd.status.updatedAt = datetime.now()

            # Check if pipeline should auto-advance to next stage
            advance_subtask = changed_subtask or last_subtask
            advance_info = strategy.get_auto_advance_info(
                db,
                task_id,
                advance_subtask.id,
                advance_subtask.status.value,
            )
            if advance_info and advance_subtask.id == last_subtask.id:
                task_crd.status.status = "PENDING"
                task_crd.status.progress = 0
                update_result.auto_advance = PipelineAutoAdvanceIntent(
                    task_id=task.id,
                    user_id=task.user_id,
                    completed_subtask_id=advance_subtask.id,
                    advance_info=advance_info,
                )

        payload = task_crd.model_dump(mode="json")
        if terminal and changed_subtask_id is not None:
            settle_pipeline_handoff(payload, changed_subtask_id)
        if update_result.auto_advance is not None:
            update_result.auto_advance.write(payload)
            if terminal:
                add_pipeline_recovery(db, update_result.auto_advance)
        task_stores.task_store.update_json(db, task=task, payload=payload)

        return update_result

    def _apply_status_update(
        self,
        db: Session,
        task_id: int,
        status_obj: TaskStatus,
        last_subtask: Subtask,
        strategy: CollaborationStrategy,
    ) -> None:
        """Apply status update based on last subtask using collaboration strategy.

        Args:
            db: Database session
            task_id: Task ID
            status_obj: Task status object to update
            last_subtask: The last assistant subtask
            strategy: Collaboration strategy to use for status determination
        """
        from app.models.subtask import SubtaskStatus

        # Get the status string from subtask status enum
        subtask_status_str = last_subtask.status.value

        # Use strategy to determine task status
        new_status, progress = strategy.get_task_status_on_subtask_complete(
            db, task_id, last_subtask.id, subtask_status_str
        )

        status_obj.status = new_status
        status_obj.result = last_subtask.result

        if progress is not None:
            status_obj.progress = progress

        # Set completedAt for terminal statuses
        if new_status in ("COMPLETED", "CANCELLED", "PENDING_CONFIRMATION"):
            status_obj.completedAt = datetime.now()

        if last_subtask.status == SubtaskStatus.FAILED:
            status_obj.errorMessage = last_subtask.error_message

    async def save_partial_response(
        self, subtask_id: int, content: str, is_streaming: bool = True
    ) -> None:
        """Save partial response during streaming."""
        await self._run_in_executor(
            self._save_partial_sync, subtask_id, content, is_streaming
        )

    def _save_partial_sync(
        self, subtask_id: int, content: str, is_streaming: bool
    ) -> None:
        """Synchronous partial response save."""
        try:
            with _db_session() as db:
                if subtask := task_stores.subtask_store.get_by_id(
                    db, subtask_id=subtask_id
                ):
                    task_stores.subtask_store.update_result(
                        db,
                        subtask=subtask,
                        result={"value": content, "streaming": is_streaming},
                    )
        except Exception:
            logger.exception("Error saving partial response for subtask %s", subtask_id)

    async def get_subtask_message_id(self, subtask_id: int) -> int | None:
        """Get the message_id for a subtask.

        Args:
            subtask_id: The subtask ID

        Returns:
            The message_id if found, None otherwise
        """
        return await self._run_in_executor(
            self._get_subtask_message_id_sync, subtask_id
        )

    def _get_subtask_message_id_sync(self, subtask_id: int) -> int | None:
        """Synchronous get subtask message_id."""
        try:
            with _db_session() as db:
                if subtask := task_stores.subtask_store.get_by_id(
                    db, subtask_id=subtask_id
                ):
                    return subtask.message_id
        except Exception:
            logger.exception("Error getting message_id for subtask %s", subtask_id)
        return None


# Global database handler instance
db_handler = DatabaseHandler()


# ============================================================
# Public utility functions for other modules
# ============================================================


async def run_sync_in_executor(func: Callable[..., T], *args: Any) -> T:
    """
    Run a synchronous function in the shared thread pool executor.

    This utility allows other modules to run their sync database operations
    without blocking the async event loop. The function runs in a shared
    thread pool with other database operations.

    Usage:
        from app.services.chat.storage.db import run_sync_in_executor

        async def my_async_function():
            result = await run_sync_in_executor(my_sync_db_function, arg1, arg2)
            return result

    Args:
        func: Synchronous function to execute
        *args: Arguments to pass to the function

    Returns:
        The return value of the synchronous function
    """
    return await asyncio.get_event_loop().run_in_executor(_db_executor, func, *args)


def get_db_session() -> Generator[Session, None, None]:
    """
    Get a database session context manager.

    This is a public alias for _db_session() for use by other modules.

    Usage:
        from app.services.chat.storage.db import get_db_session

        def my_sync_function():
            with get_db_session() as db:
                # do database operations
                pass

    Returns:
        Context manager yielding a database session
    """
    return _db_session()


def with_session_in_executor(func: Callable[..., T]) -> Callable[..., T]:
    """
    Decorator that wraps a sync function (db: Session, ...) -> T into an async function.

    The decorated function will:
    1. Create a new database session
    2. Run the original function in a thread pool executor
    3. Handle commit/rollback automatically
    4. Close the session when done

    The original sync function MUST have `db: Session` as its first parameter.

    Usage:
        from app.services.chat.storage.db import with_session_in_executor

        @with_session_in_executor
        def can_access_task_sync(db: Session, user_id: int, task_id: int) -> bool:
            task = db.query(Task).filter(Task.id == task_id).first()
            return task is not None and task.user_id == user_id

        # Now can_access_task_sync can be called as an async function:
        result = await can_access_task_sync(user_id, task_id)

    Args:
        func: Synchronous function with signature (db: Session, *args, **kwargs) -> T

    Returns:
        Async function with signature (*args, **kwargs) -> T
    """
    import functools

    @functools.wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> T:
        def run_with_session() -> T:
            with _db_session() as db:
                return func(db, *args, **kwargs)

        return await asyncio.get_event_loop().run_in_executor(
            _db_executor, run_with_session
        )

    return wrapper
