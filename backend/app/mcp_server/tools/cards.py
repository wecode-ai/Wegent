# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Generic MCP tools for asynchronous chat cards."""

import logging
import uuid
from typing import Any

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.async_cards import AsyncCardService
from shared.telemetry.decorators import trace_sync
from wecode.video.api.cards import create_pending_card_block
from wecode.video.api.client import validate_task_url
from wecode.video.api.polling import (
    create_poll_token,
    prepare_poll_context,
)
from wecode.video.api.tasks import dispatch_aigc_card_poll

logger = logging.getLogger(__name__)

VIDEO_CARD_TYPES = {"video_director_generation", "video_short_generation"}


@mcp_tool(
    name="create_async_video_card",
    description=(
        "Create a video workflow card immediately and update it asynchronously "
        "from an AIGC task status URL."
    ),
    server="cards",
    param_descriptions={
        "task_url": "AIGC task status URL returned by a video skill tool",
        "preview_title": "Title shown while the task is running",
        "progress_text": "Short progress description",
        "card_type": "video_director_generation or video_short_generation",
    },
)
@trace_sync(
    span_name="aigc_video.create_async_card",
    tracer_name="backend.aigc_video",
    extract_attributes=lambda token_info, *args, **kwargs: {
        "task.id": str(token_info.task_id),
        "subtask.id": str(token_info.subtask_id),
        "card.type": kwargs.get("card_type", "video_short_generation"),
    },
)
def create_async_video_card(
    token_info: TaskTokenInfo,
    task_url: str,
    preview_title: str = "视频生成中...",
    progress_text: str = "正在生成，请稍候",
    card_type: str = "video_short_generation",
) -> dict[str, Any]:
    """Create a pending video card and begin durable background polling."""
    if card_type not in VIDEO_CARD_TYPES:
        return {"error": f"Unsupported video card type: {card_type}"}
    try:
        validate_task_url(task_url)
    except ValueError as exc:
        return {"error": str(exc)}

    card_id = uuid.uuid4().hex
    block = create_pending_card_block(
        card_id=card_id,
        card_type=card_type,
        preview_title=preview_title,
        progress_text=progress_text,
    )
    scheduled_token = create_poll_token()
    db = SessionLocal()
    try:
        prepare_poll_context(
            db,
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            task_url=task_url,
            block=block,
            poll_count=0,
            scheduled_token=scheduled_token,
        )
        AsyncCardService.create(
            db,
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            block=block,
        )
    except Exception as exc:
        logger.exception("Failed to create asynchronous card")
        return {"error": str(exc)}
    finally:
        db.close()

    dispatch_aigc_card_poll(
        task_id=token_info.task_id,
        subtask_id=token_info.subtask_id,
        task_url=task_url,
        block=block,
        countdown=3,
        scheduled_token=scheduled_token,
        persist_context=False,
    )
    return {
        "id": card_id,
        "card_type": card_type,
        "status": "pending",
        "data": {},
        "preview_data": block["card_preview_data"],
    }
