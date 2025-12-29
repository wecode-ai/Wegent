# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Context processing module.

Handles processing of subtask contexts including:
- Attachments (text documents and images for vision models)
- Knowledge bases (RAG retrieval)

Replaces the original attachments.py with unified context support.
"""

import logging
from typing import Any, List, Tuple

from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.context import context_service

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

    # Collect all contexts
    text_contents = []
    image_contents = []

    for idx, context_id in enumerate(context_ids, start=1):
        try:
            context = context_service.get_context_optional(
                db=db,
                context_id=context_id,
            )

            if context is None:
                logger.warning(f"Context {context_id} not found")
                continue

            if context.status != ContextStatus.READY.value:
                logger.warning(f"Context {context_id} is not ready: {context.status}")
                continue

            # Process based on context type
            if context.context_type == ContextType.ATTACHMENT.value:
                _process_attachment_context(context, idx, text_contents, image_contents)
            elif context.context_type == ContextType.KNOWLEDGE_BASE.value:
                # Knowledge base contexts are handled via RAG tools, not here
                # But we can add a reference note to the message
                logger.debug(
                    f"Knowledge base context {context_id} will be used via RAG"
                )

        except Exception as e:
            logger.error(f"Error processing context {context_id}: {e}")
            continue

    # If we have images, return a multi-vision structure
    if image_contents:
        combined_text = ""
        if text_contents:
            combined_text = "\n".join(text_contents) + "\n\n"
        combined_text += f"[User Question]:\n{message}"

        return {
            "type": "multi_vision",
            "text": combined_text,
            "images": image_contents,
        }

    # If only text contents, combine them
    if text_contents:
        combined_contents = "\n".join(text_contents)
        return f"{combined_contents}[User Question]:\n{message}"

    return message


def _process_attachment_context(
    context: SubtaskContext,
    idx: int,
    text_contents: List[str],
    image_contents: List[dict],
) -> None:
    """
    Process an attachment context and add to appropriate list.

    Args:
        context: The SubtaskContext record
        idx: Attachment index (for labeling)
        text_contents: List to append text content to
        image_contents: List to append image content to
    """
    # Check if it's an image attachment
    if context_service.is_image_context(context) and context.image_base64:
        image_contents.append(
            {
                "image_base64": context.image_base64,
                "mime_type": context.mime_type,
                "filename": context.original_filename,
            }
        )
    else:
        # Text document - get formatted content
        doc_prefix = context_service.build_document_text_prefix(context)
        if doc_prefix:
            text_contents.append(f"[Attachment {idx}]\n{doc_prefix}")


async def process_attachments(
    db: Any,
    attachment_ids: List[int],
    user_id: int,
    message: str,
) -> str | dict[str, Any]:
    """
    Process multiple attachments and build message with all attachment contents.

    This is a backward-compatible wrapper around process_contexts.

    Args:
        db: Database session (SQLAlchemy Session)
        attachment_ids: List of attachment IDs (now context IDs)
        user_id: User ID
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    return await process_contexts(db, attachment_ids, user_id, message)


def extract_knowledge_base_ids(
    db: Session,
    context_ids: List[int],
) -> List[int]:
    """
    Extract knowledge base IDs from context list.

    Args:
        db: Database session
        context_ids: List of context IDs

    Returns:
        List of knowledge_id values from knowledge_base type contexts
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


def get_context_ids_for_attachment_ids(
    context_ids: List[int],
) -> Tuple[List[int], List[int]]:
    """
    Separate context IDs into attachment and knowledge base IDs.

    This is a pass-through function since context_ids are used directly now.

    Args:
        context_ids: List of context IDs

    Returns:
        Tuple of (attachment_context_ids, knowledge_base_context_ids)
        Note: Currently returns (context_ids, []) as knowledge base IDs
        need to be extracted via extract_knowledge_base_ids
    """
    return context_ids, []
