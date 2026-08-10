# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tool for image generation."""

import logging
from typing import Any, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.execution.agents.image.generation_service import (
    image_generation_service,
)

logger = logging.getLogger(__name__)


@mcp_tool(
    name="generate_image",
    description=(
        "Generate images with the current task model, or automatically use an "
        "available image model. Generated images are saved as task attachments."
    ),
    server="image",
    param_descriptions={
        "prompt": "Image generation prompt",
        "size": "Optional exact output size, for example 1024x1024",
        "max_images": "Number of images to generate, from 1 to 15",
        "reference_images": (
            "Optional image attachment IDs, HTTP/HTTPS URLs, or base64 data URLs"
        ),
    },
)
async def generate_image(
    token_info: TaskTokenInfo,
    prompt: str,
    size: Optional[str] = None,
    max_images: int = 1,
    reference_images: Optional[list[str | int]] = None,
) -> dict[str, Any]:
    """Generate and persist images."""
    db = SessionLocal()
    try:
        return await image_generation_service.generate(
            db=db,
            token_info=token_info,
            prompt=prompt,
            size=size,
            max_images=max_images,
            reference_images=reference_images,
        )
    except (ValueError, TimeoutError) as exc:
        logger.warning("[MCP:Image] generate_image failed: %s", exc)
        return {"error": str(exc)}
    except Exception as exc:
        logger.exception("[MCP:Image] generate_image failed")
        return {"error": str(exc)}
    finally:
        db.close()
