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

logger = logging.getLogger(__name__)


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
    from app.db.session import SessionLocal
    from app.services.context import context_service

    # Determine if it's a data URL or regular URL
    is_data_url = image_url.startswith("data:")

    if is_data_url:
        # Parse data URL
        # Format: data:image/jpeg;base64,<base64_data>
        header, b64_data = image_url.split(",", 1)
        mime_type = header.split(":")[1].split(";")[0]
        image_data = base64.b64decode(b64_data)
        file_extension = mime_type.split("/")[1]
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

    db = SessionLocal()
    try:
        # Use context_service to properly upload the attachment
        # This ensures storage_key and storage_backend are set correctly
        context, _ = context_service.upload_attachment(
            db=db,
            user_id=user_id,
            filename=filename,
            binary_data=image_data,
            subtask_id=subtask_id,
        )

        # Update type_data with image metadata
        current_type_data = context.type_data or {}
        context.type_data = {
            **current_type_data,
            "image_metadata": {
                "image_url": image_url if not is_data_url else None,
                "image_size": image_size,
            },
        }
        db.commit()
        db.refresh(context)

        logger.info(
            f"[ImageUploader] Created: id={context.id}, size={len(image_data)}, "
            f"storage_backend={context.storage_backend}, storage_key={context.storage_key}"
        )
        return context.id

    finally:
        db.close()
