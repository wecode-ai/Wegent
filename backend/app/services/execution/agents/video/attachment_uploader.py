# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Upload generated video as attachment.
"""

import logging
from typing import Optional

import httpx

logger = logging.getLogger(__name__)


async def upload_video_attachment(
    video_url: str,
    thumbnail: Optional[str],
    duration: Optional[float],
    user_id: int,
    task_id: int,
    subtask_id: int,
) -> int:
    """
    Download video and create attachment record.

    Args:
        video_url: URL to download video from
        thumbnail: Optional base64 thumbnail
        duration: Optional video duration in seconds
        user_id: User ID
        task_id: Task ID
        subtask_id: Subtask ID

    Returns:
        Attachment ID (SubtaskContext ID)
    """
    from app.db.session import SessionLocal
    from app.services.context import context_service

    # Download video to get size
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(video_url)
        response.raise_for_status()
        video_size = len(response.content)

    db = SessionLocal()
    try:
        context, _ = context_service.upload_attachment(
            db=db,
            user_id=user_id,
            filename=f"video_{task_id}_{subtask_id}.mp4",
            binary_data=response.content,
            subtask_id=subtask_id,
        )
        context.type_data = {
            **(context.type_data or {}),
            "video_metadata": {
                "video_url": video_url,
                "thumbnail": thumbnail,
                "duration": duration,
            },
        }
        db.commit()
        db.refresh(context)

        logger.info(f"[VideoUploader] Created: id={context.id}, size={video_size}")
        return context.id

    finally:
        db.close()
