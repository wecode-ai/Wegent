# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Database handler for Chat Shell."""

import asyncio
import logging
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from datetime import datetime
from typing import Any, Callable, Generator, TypeVar

from sqlalchemy.orm import Session
from sqlalchemy.orm.attributes import flag_modified

logger = logging.getLogger(__name__)

# Thread pool for database operations
_db_executor = ThreadPoolExecutor(max_workers=10)

# Terminal statuses that mark completion
_TERMINAL_STATUSES = frozenset(["COMPLETED", "FAILED", "CANCELLED"])

T = TypeVar("T")


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
    ) -> None:
        """Update subtask status asynchronously."""
        await self._run_in_executor(
            self._update_subtask_sync, subtask_id, status, result, error
        )

    def _update_subtask_sync(
        self,
        subtask_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """Synchronous subtask update (runs in thread pool)."""
        from app.models.subtask import Subtask, SubtaskStatus

        try:
            with _db_session() as db:
                subtask = db.get(Subtask, subtask_id)
                if not subtask:
                    return

                subtask.status = SubtaskStatus(status)
                subtask.updated_at = datetime.now()

                if result is not None:
                    subtask.result = result
                if error is not None:
                    subtask.error_message = error
                if status in _TERMINAL_STATUSES:
                    subtask.completed_at = datetime.now()

                task_id = subtask.task_id
            # Context manager commits here, then update task status
            self._update_task_status_sync(task_id)
        except Exception:
            logger.exception("Error updating subtask %s status", subtask_id)

    def _update_task_status_sync(self, task_id: int) -> None:
        """Update task status based on subtask status."""
        from app.models.kind import Kind
        from app.models.subtask import Subtask, SubtaskRole
        from app.schemas.kind import Task

        try:
            with _db_session() as db:
                task = (
                    db.query(Kind)
                    .filter(Kind.id == task_id, Kind.kind == "Task", Kind.is_active)
                    .first()
                )
                if not task:
                    return

                subtasks = (
                    db.query(Subtask)
                    .filter(
                        Subtask.task_id == task_id,
                        Subtask.role == SubtaskRole.ASSISTANT,
                    )
                    .order_by(Subtask.message_id.asc())
                    .all()
                )
                if not subtasks:
                    return

                task_crd = Task.model_validate(task.json)
                last_subtask = subtasks[-1]

                if task_crd.status:
                    self._apply_status_update(task_crd.status, last_subtask)
                    task_crd.status.updatedAt = datetime.now()

                task.json = task_crd.model_dump(mode="json")
                task.updated_at = datetime.now()
                flag_modified(task, "json")
        except Exception:
            logger.exception("Error updating task %s status", task_id)

    def _apply_status_update(self, status_obj, last_subtask) -> None:
        """Apply status update based on last subtask."""
        from app.models.subtask import SubtaskStatus

        status_map = {
            SubtaskStatus.COMPLETED: ("COMPLETED", 100, True),
            SubtaskStatus.FAILED: ("FAILED", None, False),
            SubtaskStatus.RUNNING: ("RUNNING", None, False),
        }

        if last_subtask.status in status_map:
            new_status, progress, is_completed = status_map[last_subtask.status]
            status_obj.status = new_status
            status_obj.result = last_subtask.result

            if progress is not None:
                status_obj.progress = progress
            if is_completed:
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
        from app.models.subtask import Subtask

        try:
            with _db_session() as db:
                if subtask := db.get(Subtask, subtask_id):
                    subtask.result = {"value": content, "streaming": is_streaming}
                    subtask.updated_at = datetime.now()
        except Exception:
            logger.exception("Error saving partial response for subtask %s", subtask_id)


# Global database handler instance
db_handler = DatabaseHandler()
