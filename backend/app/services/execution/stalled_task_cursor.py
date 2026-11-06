# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persist bounded stalled-task scan progress across Backend workers."""

import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime

from app.core.cache import cache_manager

logger = logging.getLogger(__name__)
STALLED_TASK_CURSOR_KEY = "stalled_task_sweep_cursor"
STALLED_TASK_CURSOR_TIMEOUT_SECONDS = 1.0


@dataclass(frozen=True)
class StalledTaskCursor:
    scan_cutoff: datetime
    updated_at: datetime
    subtask_id: int


async def load_stalled_task_cursor() -> StalledTaskCursor | None:
    """Read the last inspected position; a lost cursor restarts the scan."""
    try:
        payload = await asyncio.wait_for(
            cache_manager.get_or_raise(STALLED_TASK_CURSOR_KEY),
            timeout=STALLED_TASK_CURSOR_TIMEOUT_SECONDS,
        )
        if payload is None:
            return None
        if not isinstance(payload, dict):
            raise ValueError("Invalid stalled-task cursor")
        updated_at = datetime.fromisoformat(payload["updated_at"])
        scan_cutoff = datetime.fromisoformat(payload["scan_cutoff"])
        subtask_id = payload["subtask_id"]
        if (
            updated_at.tzinfo is not None
            or scan_cutoff.tzinfo is not None
            or updated_at > scan_cutoff
            or type(subtask_id) is not int
        ):
            raise ValueError("Invalid stalled-task cursor position")
        return StalledTaskCursor(
            scan_cutoff=scan_cutoff,
            updated_at=updated_at,
            subtask_id=subtask_id,
        )
    except Exception as exc:
        logger.warning(
            "[StalledTasks] Could not load scan cursor error_type=%s",
            type(exc).__name__,
        )
        return None


async def save_stalled_task_cursor(cursor: StalledTaskCursor) -> None:
    """Save scan progress without changing task timestamps or expiring it."""
    try:
        await asyncio.wait_for(
            cache_manager.set_or_raise(
                STALLED_TASK_CURSOR_KEY,
                {
                    "scan_cutoff": cursor.scan_cutoff.isoformat(),
                    "updated_at": cursor.updated_at.isoformat(),
                    "subtask_id": cursor.subtask_id,
                },
                expire=None,
            ),
            timeout=STALLED_TASK_CURSOR_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning(
            "[StalledTasks] Could not save scan cursor error_type=%s",
            type(exc).__name__,
        )
