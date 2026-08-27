# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Public MCP tools for creating durable CardBlocks."""

import logging
from typing import Any

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.execution.agents.video.async_card import (
    VIDEO_DIRECTOR_CARD_TYPE,
    async_video_card_service,
)

logger = logging.getLogger(__name__)


@mcp_tool(
    name="create_async_video_card",
    description=(
        "Create a pending CardBlock for an external video workflow and poll the "
        "returned task URL until completion."
    ),
    server="cards",
    param_descriptions={
        "task_url": "HTTP(S) task status URL returned by the external workflow",
        "preview_title": "Title shown while the workflow is running",
        "progress_text": "Progress text shown while the workflow is running",
        "card_type": "Card Registry identifier",
    },
)
async def create_async_video_card(
    token_info: TaskTokenInfo,
    task_url: str,
    preview_title: str = "",
    progress_text: str = "",
    card_type: str = VIDEO_DIRECTOR_CARD_TYPE,
) -> dict[str, Any]:
    """Persist a CardBlock and start durable polling."""
    try:
        return await async_video_card_service.create(
            token_info=token_info,
            task_url=task_url,
            card_type=card_type,
            preview_title=preview_title,
            progress_text=progress_text,
        )
    except ValueError as exc:
        logger.warning("[MCP:Cards] create_async_video_card failed: %s", exc)
        return {"error": str(exc)}
    except Exception as exc:
        logger.exception("[MCP:Cards] create_async_video_card failed")
        return {"error": str(exc)}
