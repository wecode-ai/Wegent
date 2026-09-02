# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Upload generated video as attachment.
"""

import logging
from typing import Optional

import httpx

from app.core.blocking_work import run_execution_io

logger = logging.getLogger(__name__)


def _persist_video_attachment(
    *,
    video_data: bytes,
    thumbnail: Optional[str],
    duration: Optional[float],
    user_id: int,
    task_id: int,
    subtask_id: int,
) -> int:
    from app.db.session import SessionLocal
    from app.services.context import context_service

    db = SessionLocal()
    try:
        context, _ = context_service.upload_attachment(
            db=db,
            user_id=user_id,
            filename=f"video_{task_id}_{subtask_id}.mp4",
            binary_data=video_data,
            subtask_id=subtask_id,
        )
        context.type_data = {
            **(context.type_data or {}),
            "video_metadata": {
                "thumbnail": thumbnail,
                "duration": duration,
            },
        }
        db.commit()
        db.refresh(context)
        logger.info(
            "[VideoUploader] Created: id=%s, size=%s",
            context.id,
            len(video_data),
        )
        return context.id
    finally:
        db.close()


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
    # Download video to get size
    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.get(video_url)
        response.raise_for_status()
        video_data = response.content

    return await run_execution_io(
        _persist_video_attachment,
        video_data=video_data,
        thumbnail=thumbnail,
        duration=duration,
        user_id=user_id,
        task_id=task_id,
        subtask_id=subtask_id,
    )
