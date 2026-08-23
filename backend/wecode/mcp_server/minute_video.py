# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Internal QIA one-minute creative-video MCP tool."""

import logging
from typing import Any, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.execution.agents.video.workflow_service import (
    video_workflow_service,
)
from wecode.service.qia_minute_video import (
    QIA_MINUTE_VIDEO_WORKFLOW,
    QiaWorkflowError,
)

logger = logging.getLogger(__name__)


@mcp_tool(
    name="create_minute_video",
    description=(
        "Create a one-minute creative video through the QIA multi-stage workflow. "
        "The selected video model comes from the current Wegent task settings."
    ),
    server="video",
    param_descriptions={
        "prompt": "Complete creative brief for the one-minute video",
        "reference_images": "Optional user-provided image attachment IDs or URLs",
        "reference_videos": "Optional user-provided video attachment IDs or URLs",
    },
)
async def create_minute_video(
    token_info: TaskTokenInfo,
    prompt: str,
    reference_images: Optional[list[str | int]] = None,
    reference_videos: Optional[list[str | int]] = None,
) -> dict[str, Any]:
    """Start the internal QIA workflow."""
    db = SessionLocal()
    try:
        return await video_workflow_service.create_video_workflow(
            db=db,
            token_info=token_info,
            workflow_type=QIA_MINUTE_VIDEO_WORKFLOW,
            prompt=prompt,
            reference_images=reference_images,
            reference_videos=reference_videos,
        )
    except (ValueError, QiaWorkflowError) as exc:
        logger.warning("[MCP:Video] create_minute_video failed: %s", exc)
        return {"status": "error", "error": str(exc)}
    except Exception as exc:
        logger.exception("[MCP:Video] create_minute_video failed")
        return {"status": "error", "error": str(exc)}
    finally:
        db.close()
