# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Context processing module.

Handles processing of subtask contexts including:
- Attachments: Text documents (PDF, DOCX, TXT, etc.) and images (for vision models)
- Knowledge bases: RAG context retrieval
"""

import logging
from typing import Any, List, Tuple

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.context.context_service import context_service

logger = logging.getLogger(__name__)


async def process_contexts(
    db: Session,
    context_ids: List[int],
    user_id: int,
    message: str,
) -> str | dict[str, Any]:
    """
    Process multiple contexts and build message with all context contents.

    Args:
        db: Database session (SQLAlchemy Session)
        context_ids: List of context IDs
        user_id: User ID
        message: Original message

    Returns:
        Message with all context contents prepended, or vision structure for images
    """
    if not context_ids:
        return message

    # Collect all contexts by type
    text_attachments = []
    image_attachments = []

    for idx, context_id in enumerate(context_ids, start=1):
        context = context_service.get_context_optional(
            db=db,
            context_id=context_id,
            user_id=user_id,
        )

        if context and context.status == ContextStatus.READY.value:
            if context.context_type == ContextType.ATTACHMENT.value:
                # Handle attachment contexts
                if context_service.is_image_context(context) and context.image_base64:
                    image_attachments.append(
                        {
                            "image_base64": context.image_base64,
                            "mime_type": context.mime_type,
                            "filename": context.original_filename,
                        }
                    )
                else:
                    # For text documents, get the formatted content
                    doc_prefix = context_service.build_document_text_prefix(context)
                    if doc_prefix:
                        text_attachments.append(f"[Attachment {idx}]\n{doc_prefix}")

            # knowledge_base type: RAG is handled separately via tools
            # No preprocessing needed here

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


# Backward compatible alias
async def process_attachments(
    db: Any,
    attachment_ids: list[int],
    user_id: int,
    message: str,
) -> str | dict[str, Any]:
    """
    Process multiple attachments and build message with all attachment contents.

    This function is a backward-compatible wrapper for process_contexts.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs (now context IDs)
        user_id: User ID
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    return await process_contexts(db, attachment_ids, user_id, message)


def extract_attachment_context_ids(context_ids: List[int], db: Session) -> List[int]:
    """
    Extract only attachment type context IDs from a list of context IDs.

    Args:
        context_ids: List of context IDs
        db: Database session

    Returns:
        List of context IDs that are attachment type
    """
    if not context_ids:
        return []

    contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(context_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .all()
    )
    return [c.id for c in contexts]


def extract_knowledge_base_ids(context_ids: List[int], db: Session) -> List[int]:
    """
    Extract knowledge_id from knowledge_base type contexts.

    Args:
        context_ids: List of context IDs
        db: Database session

    Returns:
        List of knowledge IDs from knowledge_base type contexts
    """
    if not context_ids:
        return []

    contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(context_ids),
            SubtaskContext.context_type == ContextType.KNOWLEDGE_BASE.value,
        )
        .all()
    )
    return [c.knowledge_id for c in contexts if c.knowledge_id]


def get_contexts_for_subtask(
    db: Session,
    subtask_id: int,
) -> Tuple[str, List[dict]]:
    """
    Get processed context content for a subtask.

    Args:
        db: Database session
        subtask_id: Subtask ID

    Returns:
        Tuple of (combined_text, image_list)
        - combined_text: Document text content combined
        - image_list: List of image content blocks for vision models
    """
    contexts = context_service.get_by_subtask(db, subtask_id)

    text_parts = []
    images = []

    for context in contexts:
        if context.status != ContextStatus.READY.value:
            continue

        if context.context_type == ContextType.ATTACHMENT.value:
            if context_service.is_image_context(context) and context.image_base64:
                images.append(
                    {
                        "type": "image",
                        "image_base64": context.image_base64,
                        "media_type": context.mime_type,
                    }
                )
            elif context.extracted_text:
                text_prefix = context_service.build_document_text_prefix(context)
                if text_prefix:
                    text_parts.append(text_prefix)

    return "\n".join(text_parts), images
