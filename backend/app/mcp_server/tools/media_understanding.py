# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for media understanding."""

import time
from typing import Any, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.media_understanding import media_understanding_service


@mcp_tool(
    name="understand_media",
    description=(
        "Understand media using a fixed multimodal model. Current backend input support is video URL or video attachment."
    ),
    server="media",
    exclude_params=["token_info"],
    param_descriptions={
        "context_id": "Alias of attachment_id. It is the metadata header ID parsed as SubtaskContext.id, not fid.",
        "attachment_id": "Preferred for video attachments. Use the ID shown in the video attachment metadata header; do not pass fid.",
        "media_url": "HTTP(S) video URL when no attachment context is available.",
        "media_type": "Media type. Only 'video' is supported.",
        "question": "The user's original question about the media.",
        "instruction": "Optional analysis instruction for the media understanding model.",
        "context": "Optional background context such as title, description, transcript, metadata, and related texts.",
    },
)
def understand_media(
    token_info: TaskTokenInfo,
    context_id: Optional[int] = None,
    attachment_id: Optional[int] = None,
    media_url: Optional[str] = None,
    media_type: str = "video",
    question: Optional[str] = None,
    instruction: Optional[str] = None,
    context: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Understand media content."""
    started_at = time.monotonic()
    db = SessionLocal()
    try:
        prepared = media_understanding_service.prepare_understand_media(
            db,
            token_info=token_info,
            context_id=context_id,
            attachment_id=attachment_id,
            media_url=media_url,
            media_type=media_type,
            question=question,
            instruction=instruction,
            context=context,
        )
    except Exception as exc:
        return media_understanding_service.handle_exception(
            exc,
            token_info=token_info,
            started_at=started_at,
        )
    finally:
        db.close()

    return media_understanding_service.understand_prepared_media(
        prepared,
        token_info=token_info,
        started_at=started_at,
    )
