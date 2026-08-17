# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool for video generation."""

import logging
from typing import Any, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.execution.agents.video.generation_service import (
    video_generation_service,
)

logger = logging.getLogger(__name__)


@mcp_tool(
    name="generate_video",
    description=(
        "Start video generation with the current task model, or automatically use "
        "an available video model. Completion is handled asynchronously and saved "
        "as a task attachment."
    ),
    server="video",
    param_descriptions={
        "prompt": "Video generation prompt",
        "ratio": "Optional aspect ratio, for example 16:9 or 9:16",
        "duration": "Optional duration in seconds, for example 5s or 10s",
        "reference_images": "Optional image attachment IDs or URLs",
        "reference_videos": "Optional video attachment IDs or URLs",
        "reference_audios": "Optional audio attachment IDs or URLs",
    },
)
async def generate_video(
    token_info: TaskTokenInfo,
    prompt: str,
    ratio: Optional[str] = None,
    duration: Optional[str] = None,
    reference_images: Optional[list[str | int]] = None,
    reference_videos: Optional[list[str | int]] = None,
    reference_audios: Optional[list[str | int]] = None,
) -> dict[str, Any]:
    """Start a durable video generation job."""
    db = SessionLocal()
    try:
        return await video_generation_service.create_job(
            db=db,
            token_info=token_info,
            prompt=prompt,
            ratio=ratio,
            duration=duration,
            reference_images=reference_images,
            reference_videos=reference_videos,
            reference_audios=reference_audios,
        )
    except (ValueError, TimeoutError) as exc:
        logger.warning("[MCP:Video] generate_video failed: %s", exc)
        return {"error": str(exc)}
    except Exception as exc:
        logger.exception("[MCP:Video] generate_video failed")
        return {"error": str(exc)}
    finally:
        db.close()
