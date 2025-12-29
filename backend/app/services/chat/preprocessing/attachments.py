# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Attachment processing module.

Handles processing of user-uploaded attachments including:
- Text documents (PDF, DOCX, TXT, etc.)
- Images (for vision models)
"""

import logging
from typing import Any

logger = logging.getLogger(__name__)


async def process_attachments(
    db: Any,
    attachment_ids: list[int],
    user_id: int,
    message: str,
) -> str | dict[str, Any]:
    """
    Process multiple attachments and build message with all attachment contents.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs
        user_id: User ID
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    from app.models.subtask_attachment import AttachmentStatus
    from app.services.attachment import attachment_service

    if not attachment_ids:
        return message

    # Collect all attachments
    text_attachments = []
    image_attachments = []

    for idx, attachment_id in enumerate(attachment_ids, start=1):
        attachment = attachment_service.get_attachment(
            db=db,
            attachment_id=attachment_id,
            user_id=user_id,
        )

        if attachment and attachment.status == AttachmentStatus.READY:
            # Separate images and text documents
            if (
                attachment_service.is_image_attachment(attachment)
                and attachment.image_base64
            ):
                image_attachments.append(
                    {
                        "image_base64": attachment.image_base64,
                        "mime_type": attachment.mime_type,
                        "filename": attachment.original_filename,
                    }
                )
            else:
                # For text documents, get the formatted content
                doc_prefix = attachment_service.build_document_text_prefix(attachment)
                if doc_prefix:
                    text_attachments.append(f"[Attachment {idx}]\n{doc_prefix}")

    # If we have images, return a multi-vision structure
    if image_attachments:
        # Build text content from text attachments
        combined_text = ""
        if text_attachments:
            combined_text = "\n".join(text_attachments) + "\n\n"
        combined_text += f"[User Question]:\n{message}"

        return {
            "type": "multi_vision",
            "text": combined_text,
            "images": image_attachments,
        }

    # If only text attachments, combine them
    if text_attachments:
        combined_attachments = "\n".join(text_attachments)
        return f"{combined_attachments}[User Question]:\n{message}"

    return message
