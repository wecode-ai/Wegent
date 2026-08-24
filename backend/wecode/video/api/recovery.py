# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Startup recovery for unfinished AIGC asynchronous cards."""

import asyncio
import logging
from collections.abc import Callable
from datetime import datetime, timedelta, timezone
from typing import Any

from app.core.config import settings
from wecode.video.api.polling import (
    TERMINAL_CARD_STATUSES,
    find_card_block,
    finish_poll,
    get_poll_contexts,
)

logger = logging.getLogger(__name__)

RECOVERY_LOCK_NAME = "aigc_card_recovery"
RECOVERY_LOCK_EXPIRE_SECONDS = 120
RECOVERY_LOOKBACK_HOURS = 24
STALE_THRESHOLD_SECONDS = max(10, settings.AIGC_CARD_POLL_INTERVAL_SECONDS * 2)


async def start_aigc_card_recovery(app: Any) -> None:
    """Start durable AIGC card recovery for the backend lifespan."""
    logger.info("Recovering in-progress AIGC cards...")
    try:
        recovered_count = await recover_aigc_card_polls()
        logger.info("Recovered %d in-progress AIGC card(s)", recovered_count)
        app.state.aigc_card_recovery_task = asyncio.create_task(
            recover_aigc_card_polls_after_stale_delay()
        )
    except Exception:
        logger.warning("Failed to recover AIGC cards", exc_info=True)


async def stop_aigc_card_recovery(app: Any) -> None:
    """Stop the delayed AIGC card recovery task during backend shutdown."""
    recovery_task = getattr(app.state, "aigc_card_recovery_task", None)
    if recovery_task is None or recovery_task.done():
        return
    recovery_task.cancel()
    try:
        await recovery_task
    except asyncio.CancelledError:
        pass


async def recover_aigc_card_polls() -> int:
    """Requeue stale AIGC card polls from durable subtask state."""
    from app.core.distributed_lock import distributed_lock

    with distributed_lock.acquire_context(
        RECOVERY_LOCK_NAME, RECOVERY_LOCK_EXPIRE_SECONDS
    ) as acquired:
        if not acquired:
            logger.info("Another instance is recovering AIGC cards, skipping")
            return 0
        return _recover_stale_polls()


async def recover_aigc_card_polls_after_stale_delay() -> int:
    """Repeat startup recovery after recently scheduled polls become stale."""
    await asyncio.sleep(STALE_THRESHOLD_SECONDS)
    return await recover_aigc_card_polls()


def _recover_stale_polls() -> int:
    from app.db.session import SessionLocal
    from app.models.subtask import Subtask, SubtaskStatus
    from wecode.video.api.tasks import dispatch_aigc_card_poll

    db = SessionLocal()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(hours=RECOVERY_LOOKBACK_HOURS)
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.created_at >= cutoff,
                Subtask.status != SubtaskStatus.DELETE,
            )
            .all()
        )
        recovered_count = 0
        now = datetime.now(timezone.utc)
        for subtask in subtasks:
            recovered_count += _recover_subtask_polls(
                subtask,
                now,
                dispatch_aigc_card_poll,
            )
        return recovered_count
    except Exception:
        logger.exception("Failed to recover AIGC card polls")
        return 0
    finally:
        db.close()


def _recover_subtask_polls(
    subtask: Any,
    now: datetime,
    dispatch: Callable[..., str],
) -> int:
    result = subtask.result if isinstance(subtask.result, dict) else {}
    recovered_count = 0
    for context in get_poll_contexts(result):
        if not _is_stale_poll(context, now):
            continue

        card_id = str(context["card_id"])
        block = find_card_block(result, card_id)
        if block is None:
            logger.warning(
                "Cannot recover AIGC card without its block: subtask_id=%d card_id=%s",
                subtask.id,
                card_id,
            )
            continue
        if block.get("card_status") in TERMINAL_CARD_STATUSES:
            finish_poll(
                subtask_id=subtask.id,
                card_id=card_id,
                scheduled_token=str(context["scheduled_token"]),
                status=str(block["card_status"]),
            )
            continue

        dispatch(
            task_id=int(context.get("task_id") or subtask.task_id),
            subtask_id=subtask.id,
            task_url=str(context["task_url"]),
            block=block,
            poll_count=int(context.get("poll_count") or 0),
            countdown=0,
        )
        recovered_count += 1
        logger.info(
            "Recovered AIGC card poll: task_id=%d subtask_id=%d card_id=%s",
            subtask.task_id,
            subtask.id,
            card_id,
        )
    return recovered_count


def _is_stale_poll(context: Any, now: datetime) -> bool:
    if not isinstance(context, dict) or context.get("status") != "polling":
        return False
    if not all(context.get(key) for key in ("card_id", "task_url", "scheduled_token")):
        return False

    last_poll_at = context.get("last_poll_at")
    if not isinstance(last_poll_at, str):
        return True
    try:
        parsed = datetime.fromisoformat(last_poll_at.replace("Z", "+00:00"))
    except ValueError:
        return True
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return (now - parsed).total_seconds() >= STALE_THRESHOLD_SECONDS
