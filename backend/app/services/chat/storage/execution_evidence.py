# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Read existing stream activity without inspecting response content."""

import asyncio
import json
import logging
from datetime import datetime, timezone

from app.core.cache import cache_manager
from app.services.chat.storage.session import session_manager
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)

EVIDENCE_TIMEOUT_SECONDS = 1.0


def _has_stream_activity(
    raw: bytes | str | None, *, subtask_id: int, since: datetime
) -> bool | None:
    """Check activity after START against the candidate's persisted timestamp."""
    if raw is None:
        return False
    status = json.loads(raw)
    if not isinstance(status, dict) or type(status.get("subtask_id")) is not int:
        return None
    if status["subtask_id"] != subtask_id:
        return None
    started_at = datetime.fromisoformat(status["started_at"])
    last_activity_at = datetime.fromisoformat(status["last_activity_at"])
    if (
        started_at.tzinfo is None
        or last_activity_at.tzinfo is None
        or last_activity_at < started_at
    ):
        return None
    return last_activity_at > started_at and last_activity_at >= since


async def _probe(task_id: int, subtask_id: int, *, since: datetime) -> bool | None:
    if since.tzinfo is None:
        # RUNNING writes use Python datetime.now() / Rust Local::now(),
        # so naive values follow the process clock rather than the DB session.
        since = since.astimezone(timezone.utc)
    key = session_manager._get_task_streaming_key(task_id)
    async with cache_manager._client_context() as client:
        snapshot = await client.get(key)
        result = _has_stream_activity(snapshot, subtask_id=subtask_id, since=since)
        if result is False and await client.get(key) != snapshot:
            return None
        return result


@trace_async("chat.streaming_execution_evidence", "backend.execution")
async def has_execution_evidence(
    task_id: int, subtask_id: int, *, since: datetime
) -> bool | None:
    """Return True for later stream activity, False for none, None if uncertain.

    This guards the "executor not started" decision; it is not a heartbeat or
    success check. The existing marker does not fence late producers after retry.
    """
    try:
        return await asyncio.wait_for(
            _probe(task_id, subtask_id, since=since),
            timeout=EVIDENCE_TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning(
            "[StalledTasks] Redis evidence unavailable task_id=%s subtask_id=%s "
            "error_type=%s",
            task_id,
            subtask_id,
            type(exc).__name__,
        )
        return None
