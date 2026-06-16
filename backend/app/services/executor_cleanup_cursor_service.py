# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persisted scan cursor support for scheduled executor cleanup."""

from dataclasses import dataclass
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.cache import cache_manager
from app.stores import tasks as task_stores

EXECUTOR_CLEANUP_CURSOR_KEY = "executor_cleanup_cursor"
INITIAL_CURSOR_LOOKBACK_DAYS = 7


@dataclass
class ExecutorCleanupCursor:
    """Persisted progress for scheduled executor cleanup scans."""

    last_scanned_subtask_id: int = 0


class ExecutorCleanupCursorService:
    """Read and update the scheduled executor cleanup cursor."""

    async def get_cursor(self, db: AsyncSession) -> ExecutorCleanupCursor:
        """Load the persisted cleanup cursor, or return the default state."""
        redis_cursor = await self._get_cursor_from_redis()
        if redis_cursor is not None:
            return redis_cursor

        cursor = await self._build_default_cursor(db)
        await self._write_cursor_to_redis(cursor.last_scanned_subtask_id)
        return cursor

    async def _build_default_cursor(self, db: AsyncSession) -> ExecutorCleanupCursor:
        """Build the first cleanup cursor from the recent one-week subtask window."""
        recent_threshold = datetime.now() - timedelta(days=INITIAL_CURSOR_LOOKBACK_DAYS)
        recent_subtask = await db.run_sync(
            lambda sync_db: (
                task_stores.subtask_store.get_cleanup_cursor_recent_start_reference(
                    sync_db,
                    recent_threshold=recent_threshold,
                )
            )
        )
        recent_subtask_id = getattr(recent_subtask, "id", None)
        if isinstance(recent_subtask_id, int):
            return ExecutorCleanupCursor(
                last_scanned_subtask_id=max(recent_subtask_id - 1, 0),
            )

        latest_subtask = await db.run_sync(
            lambda sync_db: (
                task_stores.subtask_store.get_cleanup_cursor_latest_reference(sync_db)
            )
        )
        latest_subtask_id = getattr(latest_subtask, "id", None)
        if isinstance(latest_subtask_id, int):
            return ExecutorCleanupCursor(
                last_scanned_subtask_id=max(latest_subtask_id, 0),
            )

        return ExecutorCleanupCursor()

    async def advance_cursor(
        self, db: AsyncSession, *, last_scanned_subtask_id: int
    ) -> None:
        """Persist the latest scanned subtask id for cleanup progress."""
        del db
        await self._write_cursor_to_redis(max(last_scanned_subtask_id, 0))

    async def _get_cursor_from_redis(self) -> ExecutorCleanupCursor | None:
        """Load the cleanup cursor from Redis when available."""
        payload = await cache_manager.get(EXECUTOR_CLEANUP_CURSOR_KEY)
        if not isinstance(payload, dict):
            return None

        last_scanned_subtask_id = payload.get("last_scanned_subtask_id")
        if not isinstance(last_scanned_subtask_id, int):
            return None

        return ExecutorCleanupCursor(
            last_scanned_subtask_id=max(last_scanned_subtask_id, 0),
        )

    async def _write_cursor_to_redis(self, last_scanned_subtask_id: int) -> None:
        """Persist the cleanup cursor to Redis without expiration."""
        await cache_manager.set(
            EXECUTOR_CLEANUP_CURSOR_KEY,
            {
                "last_scanned_subtask_id": max(last_scanned_subtask_id, 0),
                "updated_at": datetime.now().isoformat(),
            },
            expire=None,
        )


executor_cleanup_cursor_service = ExecutorCleanupCursorService()
