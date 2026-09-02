# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Upload generated image as attachment.
"""

import base64
import logging
from typing import Optional

import httpx

from app.core.blocking_work import run_execution_io
from app.core.payload_codec import run_payload_codec

logger = logging.getLogger(__name__)


def _decode_image_data_url(image_url: str) -> tuple[bytes, str, str]:
    header, b64_data = image_url.split(",", 1)
    mime_type = header.split(":")[1].split(";")[0]
    image_data = base64.b64decode(b64_data)
    return image_data, mime_type, mime_type.split("/")[1]


def _persist_image_attachment(
    *,
    image_data: bytes,
    image_url: str,
    image_size: Optional[str],
    user_id: Optional[int],
    subtask_id: int,
    filename: str,
    is_data_url: bool,
) -> int:
    from app.db.session import SessionLocal
    from app.services.context import context_service

    db = SessionLocal()
    try:
        context, _ = context_service.upload_attachment(
            db=db,
            user_id=user_id,
            filename=filename,
            binary_data=image_data,
            subtask_id=subtask_id,
        )
        context.type_data = {
            **(context.type_data or {}),
            "image_metadata": {
                "image_url": image_url if not is_data_url else None,
                "image_size": image_size,
            },
        }
        db.commit()
        db.refresh(context)
        logger.info(
            "[ImageUploader] Created: id=%s, size=%s, "
            "storage_backend=%s, storage_key=%s",
            context.id,
            len(image_data),
            context.storage_backend,
            context.storage_key,
        )
        return context.id
    finally:
        db.close()


async def upload_image_attachment(
    image_url: str,
    image_size: Optional[str],
    user_id: Optional[int],
    task_id: int,
    subtask_id: int,
    index: int = 0,
) -> int:
    """
    Download image and create attachment record.

    Args:
        image_url: Image URL or base64 data URL
        image_size: Image dimensions (e.g., '2048x2048')
        user_id: User ID
        task_id: Task ID
        subtask_id: Subtask ID
        index: Image index (for multiple images)

    Returns:
        Attachment ID (SubtaskContext ID)
    """
    # Determine if it's a data URL or regular URL
    is_data_url = image_url.startswith("data:")

    if is_data_url:
        image_data, mime_type, file_extension = await run_payload_codec(
            _decode_image_data_url,
            image_url,
            payload_hint=image_url,
        )
    else:
        # Download from URL
        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.get(image_url)
            response.raise_for_status()
            image_data = response.content

            # Determine file extension from content type
            content_type = response.headers.get("content-type", "image/jpeg")
            mime_type = content_type.split(";")[0]
            file_extension = mime_type.split("/")[1]

    # Generate filename
    filename = f"image_{task_id}_{subtask_id}_{index}.{file_extension}"

    return await run_execution_io(
        _persist_image_attachment,
        image_data=image_data,
        image_url=image_url,
        image_size=image_size,
        user_id=user_id,
        subtask_id=subtask_id,
        filename=filename,
        is_data_url=is_data_url,
    )
