# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery polling tasks for AIGC asynchronous card status."""

import logging
from typing import Any

import httpx

from app.core.celery_app import celery_app
from app.core.config import settings
from app.db.session import SessionLocal
from app.services.async_cards import AsyncCardService
from shared.telemetry.decorators import trace_sync
from wecode.video.api.cards import update_card_block
from wecode.video.api.client import fetch_card_status
from wecode.video.api.polling import (
    TERMINAL_CARD_STATUSES,
    claim_poll,
    create_poll_token,
    finish_poll,
    persist_poll_context,
)

logger = logging.getLogger(__name__)


def dispatch_aigc_card_poll(
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    poll_count: int = 0,
    countdown: int = 3,
    scheduled_token: str | None = None,
    persist_context: bool = True,
) -> str:
    token = scheduled_token or create_poll_token()
    if persist_context:
        persist_poll_context(
            task_id=task_id,
            subtask_id=subtask_id,
            task_url=task_url,
            block=block,
            poll_count=poll_count,
            scheduled_token=token,
        )
    result = poll_aigc_card_status.apply_async(
        kwargs={
            "task_id": task_id,
            "subtask_id": subtask_id,
            "task_url": task_url,
            "block": block,
            "poll_count": poll_count,
            "scheduled_token": token,
        },
        countdown=countdown,
    )
    return str(result.id)


def _schedule_next(
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    poll_count: int,
) -> None:
    dispatch_aigc_card_poll(
        task_id=task_id,
        subtask_id=subtask_id,
        task_url=task_url,
        block=block,
        poll_count=poll_count,
        countdown=settings.AIGC_CARD_POLL_INTERVAL_SECONDS,
    )


@celery_app.task(name="app.aigc_video.poll_card_status")
@trace_sync(
    span_name="aigc_video.poll_card_status",
    tracer_name="backend.aigc_video",
    extract_attributes=lambda *args, **kwargs: {
        "task.id": str(kwargs.get("task_id", "")),
        "subtask.id": str(kwargs.get("subtask_id", "")),
        "card.poll_count": kwargs.get("poll_count", 0),
    },
)
def poll_aigc_card_status(
    *,
    task_id: int,
    subtask_id: int,
    task_url: str,
    block: dict[str, Any],
    scheduled_token: str,
    poll_count: int = 0,
) -> dict[str, Any]:
    poll_count += 1
    card_id = str(block["card_id"])
    if not claim_poll(
        subtask_id=subtask_id,
        card_id=card_id,
        scheduled_token=scheduled_token,
        poll_count=poll_count,
    ):
        return {"status": "stale", "card_id": card_id}

    if block.get("card_status") in TERMINAL_CARD_STATUSES:
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status=str(block["card_status"]),
        )
        return {"status": "skipped", "card_id": card_id}

    if poll_count > settings.AIGC_CARD_MAX_POLL_COUNT:
        card = update_card_block(
            block,
            card_status="error",
            error="视频任务等待超时，请稍后重试",
        )
        result = _persist_card(task_id, subtask_id, card, "timeout")
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status="timeout",
            error="视频任务等待超时，请稍后重试",
        )
        return result

    try:
        status = fetch_card_status(task_url)
    except httpx.RequestError as exc:
        logger.warning("Temporary AIGC polling failure: %s", exc)
        _schedule_next(
            task_id=task_id,
            subtask_id=subtask_id,
            task_url=task_url,
            block=block,
            poll_count=poll_count,
        )
        return {"status": "retrying", "poll_count": poll_count}
    except httpx.HTTPStatusError as exc:
        if exc.response.status_code >= 500 or (
            exc.response.status_code == 404 and poll_count <= 10
        ):
            _schedule_next(
                task_id=task_id,
                subtask_id=subtask_id,
                task_url=task_url,
                block=block,
                poll_count=poll_count,
            )
            return {"status": "retrying", "poll_count": poll_count}
        status_error = f"AIGC 状态查询失败（HTTP {exc.response.status_code}）"
        card = update_card_block(block, card_status="error", error=status_error)
        result = _persist_card(task_id, subtask_id, card, "failed")
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status="failed",
            error=status_error,
        )
        return result
    except (ValueError, TypeError) as exc:
        card = update_card_block(block, card_status="error", error=str(exc))
        result = _persist_card(task_id, subtask_id, card, "failed")
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status="failed",
            error=str(exc),
        )
        return result

    if status.is_failed:
        card = update_card_block(
            block,
            card_status="error",
            card_data=status.card,
            progress=status.progress,
            progress_text=status.progress_text,
            error=status.error or "视频生成失败",
        )
        result = _persist_card(task_id, subtask_id, card, "failed")
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status="failed",
            error=status.error or "视频生成失败",
        )
        return result

    if status.is_completed:
        card = update_card_block(
            block,
            card_status="populated",
            card_data=status.card,
            progress=100,
            progress_text=status.progress_text,
        )
        result = _persist_card(task_id, subtask_id, card, "completed")
        finish_poll(
            subtask_id=subtask_id,
            card_id=card_id,
            scheduled_token=scheduled_token,
            status="completed",
        )
        return result

    next_status = "partial_ready" if status.is_partial_ready else "pending"
    card = update_card_block(
        block,
        card_status=next_status,
        card_data=status.card or None,
        progress=status.progress,
        progress_text=status.progress_text,
    )
    _persist_card(task_id, subtask_id, card, "processing")
    _schedule_next(
        task_id=task_id,
        subtask_id=subtask_id,
        task_url=task_url,
        block=card,
        poll_count=poll_count,
    )
    return {"status": "processing", "poll_count": poll_count}


def _persist_card(
    task_id: int,
    subtask_id: int,
    block: dict[str, Any],
    status: str,
) -> dict[str, Any]:
    db = SessionLocal()
    try:
        AsyncCardService.update(
            db,
            task_id=task_id,
            subtask_id=subtask_id,
            block=block,
        )
    finally:
        db.close()
    return {"status": status, "card_id": block["card_id"]}
