# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Context processing module.

Handles processing of subtask contexts including:
- Attachments (text documents and images for vision models)
- Knowledge bases (RAG retrieval)

Replaces the original attachments.py with unified context support.

This module provides unified context processing based on user_subtask_id,
eliminating the need to pass separate attachment_ids and knowledge_base_ids.
"""

import logging
from typing import Any, List, Optional, Tuple

from langchain_core.tools import BaseTool
from sqlalchemy.orm import Session

from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.context import context_service

logger = logging.getLogger(__name__)


async def process_contexts(
    db: Session,
    context_ids: List[int],
    message: str,
) -> str | dict[str, Any]:
    """
    Process multiple contexts and build message with all context contents.

    Args:
        db: Database session (SQLAlchemy Session)
        context_ids: List of context IDs
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
                logger.debug(
                    f"Knowledge base context {context_id} will be used via RAG"
                )

        except (ValueError, KeyError) as e:
            logger.exception(f"Error processing context {context_id}")
            continue
        except Exception as e:
            logger.exception(f"Unexpected error processing context {context_id}")
            continue

    # Build vision structure if images present
    if image_contents:
        return _build_vision_structure(text_contents, image_contents, message)

    # Combine text contents if present
    if text_contents:
        return _combine_text_contents(text_contents, message)

    return message


def _build_vision_structure(
    text_contents: List[str],
    image_contents: List[dict],
    message: str,
) -> dict[str, Any]:
    """
    Build multi-vision structure for image contexts.

    Args:
        text_contents: List of text content strings
        image_contents: List of image content dictionaries
        message: Original user message

    Returns:
        Vision structure dictionary
    """
    combined_text = ""
    if text_contents:
        combined_text = "\n".join(text_contents) + "\n\n"
    combined_text += f"[User Question]:\n{message}"

    return {
        "type": "multi_vision",
        "text": combined_text,
        "images": image_contents,
    }


def _combine_text_contents(text_contents: List[str], message: str) -> str:
    """
    Combine text contents with user message.

    Args:
        text_contents: List of text content strings
        message: Original user message

    Returns:
        Combined message string
    """
    combined_contents = "\n".join(text_contents)
    return f"{combined_contents}[User Question]:\n{message}"


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
        user_id: User ID (unused, kept for backward compatibility with callers)
        message: Original message

    Returns:
        Message with all attachment contents prepended, or vision structure for images
    """
    return await process_contexts(db, attachment_ids, message)


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


def link_contexts_to_subtask(
    db: Session,
    subtask_id: int,
    user_id: int,
    attachment_ids: List[int] | None = None,
    contexts: List[Any] | None = None,
) -> List[int]:
    """
    Link attachments and create knowledge base contexts for a subtask.

    This function handles two types of contexts in a single database transaction:
    1. Attachments: Pre-uploaded files with existing context IDs, batch update subtask_id
    2. Knowledge bases: Selected at send time, batch create SubtaskContext records
       (without extracted_text - RAG retrieval is done later via tools/Service)

    Args:
        db: Database session
        subtask_id: Subtask ID to link contexts to
        user_id: User ID
        attachment_ids: List of pre-uploaded attachment context IDs to link
        contexts: List of ContextItem objects from payload (for knowledge bases)

    Returns:
        List of all linked/created context IDs
    """
    linked_context_ids = []

    # Collect attachment IDs to link
    if attachment_ids:
        linked_context_ids.extend(attachment_ids)

    # Prepare knowledge base contexts for batch creation
    kb_contexts_to_create = _prepare_kb_contexts_for_creation(
        contexts, subtask_id, user_id
    )

    # Execute all database operations in a single transaction
    try:
        created_kb_ids = _batch_update_and_insert_contexts(
            db, attachment_ids, kb_contexts_to_create, subtask_id
        )
        linked_context_ids.extend(created_kb_ids)
    except Exception as e:
        db.rollback()
        logger.exception(f"Failed to link contexts to subtask {subtask_id}: {e}")
        raise

    return linked_context_ids


def _prepare_kb_contexts_for_creation(
    contexts: List[Any] | None,
    subtask_id: int,
    user_id: int,
) -> List[SubtaskContext]:
    """
    Prepare knowledge base contexts for batch creation.

    Args:
        contexts: List of ContextItem objects from payload
        subtask_id: Subtask ID to link contexts to
        user_id: User ID

    Returns:
        List of SubtaskContext objects ready for insertion
    """
    kb_contexts_to_create: List[SubtaskContext] = []

    if not contexts:
        return kb_contexts_to_create

    for ctx in contexts:
        if ctx.type == "knowledge_base":
            try:
                kb_data = ctx.data
                knowledge_id = kb_data.get("knowledge_id")
                kb_name = kb_data.get("name", f"Knowledge Base {knowledge_id}")
                document_count = kb_data.get("document_count")

                # Create SubtaskContext object (not yet committed)
                kb_context = SubtaskContext(
                    subtask_id=subtask_id,
                    user_id=user_id,
                    context_type=ContextType.KNOWLEDGE_BASE.value,
                    name=kb_name,
                    status=ContextStatus.READY.value,
                    type_data={
                        "knowledge_id": int(knowledge_id) if knowledge_id else 0,
                        "document_count": document_count,
                    },
                )
                kb_contexts_to_create.append(kb_context)
            except Exception as e:
                logger.warning(f"Failed to prepare knowledge base context: {e}")
                continue

    return kb_contexts_to_create


def _batch_update_and_insert_contexts(
    db: Session,
    attachment_ids: List[int] | None,
    kb_contexts_to_create: List[SubtaskContext],
    subtask_id: int,
) -> List[int]:
    """
    Execute batch update and insert operations for contexts.

    Args:
        db: Database session
        attachment_ids: List of attachment context IDs to update
        kb_contexts_to_create: List of KB contexts to insert
        subtask_id: Subtask ID for logging

    Returns:
        List of created knowledge base context IDs
    """
    created_kb_ids = []

    # Batch update existing attachments' subtask_id
    if attachment_ids:
        db.query(SubtaskContext).filter(SubtaskContext.id.in_(attachment_ids)).update(
            {"subtask_id": subtask_id},
            synchronize_session=False,
        )

    # Batch add new knowledge base contexts
    if kb_contexts_to_create:
        db.add_all(kb_contexts_to_create)

    # Single commit for all operations
    db.commit()

    # Refresh KB contexts to get their IDs
    for kb_context in kb_contexts_to_create:
        db.refresh(kb_context)
        created_kb_ids.append(kb_context.id)
        logger.debug(
            f"Created knowledge base context: id={kb_context.id}, "
            f"knowledge_id={kb_context.type_data.get('knowledge_id')}, "
            f"name={kb_context.name}, subtask_id={subtask_id}"
        )

    # Log summary
    if attachment_ids:
        logger.info(
            f"Linked {len(attachment_ids)} attachment contexts to subtask {subtask_id}"
        )
    if kb_contexts_to_create:
        logger.info(
            f"Created {len(kb_contexts_to_create)} knowledge base contexts "
            f"for subtask {subtask_id}"
        )

    return created_kb_ids


# ==================== Unified Context Processing ====================


async def prepare_contexts_for_chat(
    db: Session,
    user_subtask_id: int,
    user_id: int,
    message: str,
    base_system_prompt: str,
    task_id: Optional[int] = None,
) -> Tuple[str, str, List[BaseTool]]:
    """
    Unified context processing based on user_subtask_id.

    This function retrieves all contexts associated with a user subtask and:
    1. Processes attachment contexts - injects content into the message
    2. Processes knowledge base contexts - creates KnowledgeBaseTool for RAG

    This eliminates the need to pass separate attachment_ids and knowledge_base_ids
    through the call chain.

    Args:
        db: Database session
        user_subtask_id: User subtask ID to get contexts from
        user_id: User ID for access control
        message: Original user message
        base_system_prompt: Base system prompt to enhance
        task_id: Optional task ID for fetching historical KB meta

    Returns:
        Tuple of (final_message, enhanced_system_prompt, extra_tools)
    """
    # Get all contexts for this subtask
    contexts = context_service.get_by_subtask(db, user_subtask_id)

    if not contexts:
        logger.info(
            f"[prepare_contexts_for_chat] No subtask contexts for subtask={user_subtask_id}, "
            f"checking task-level bound KBs for task_id={task_id}"
        )
        # Even without subtask contexts, check for task-level bound knowledge bases
        # This is important for group chat where KBs are bound to the task, not subtask
        extra_tools, enhanced_prompt = _prepare_kb_tools_from_contexts(
            kb_contexts=[],  # No subtask-level KB contexts
            user_id=user_id,
            db=db,
            base_system_prompt=base_system_prompt,
            task_id=task_id,
            user_subtask_id=user_subtask_id,
        )
        return message, enhanced_prompt, extra_tools

    # Separate contexts by type
    attachment_contexts = [
        c
        for c in contexts
        if c.context_type == ContextType.ATTACHMENT.value
        and c.status == ContextStatus.READY.value
    ]
    kb_contexts = [
        c
        for c in contexts
        if c.context_type == ContextType.KNOWLEDGE_BASE.value
        and c.status == ContextStatus.READY.value
    ]

    logger.info(
        f"[prepare_contexts_for_chat] subtask={user_subtask_id}: "
        f"{len(attachment_contexts)} attachments, {len(kb_contexts)} knowledge bases"
    )

    # 1. Process attachment contexts - inject into message
    final_message = await _process_attachment_contexts_for_message(
        attachment_contexts, message
    )

    # 2. Process knowledge base contexts - create tools
    extra_tools, enhanced_system_prompt = _prepare_kb_tools_from_contexts(
        kb_contexts=kb_contexts,
        user_id=user_id,
        db=db,
        base_system_prompt=base_system_prompt,
        task_id=task_id,
        user_subtask_id=user_subtask_id,
    )

    return final_message, enhanced_system_prompt, extra_tools


async def _process_attachment_contexts_for_message(
    attachment_contexts: List[SubtaskContext],
    message: str,
) -> str | dict[str, Any]:
    """
    Process attachment contexts and build message with content.

    Args:
        attachment_contexts: List of attachment SubtaskContext records
        message: Original user message

    Returns:
        Message with attachment contents prepended, or vision structure for images
    """
    if not attachment_contexts:
        return message

    text_contents = []
    image_contents = []

    for idx, context in enumerate(attachment_contexts, start=1):
        try:
            _process_attachment_context(context, idx, text_contents, image_contents)
        except Exception as e:
            logger.exception(f"Error processing attachment context {context.id}: {e}")
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


def _prepare_kb_tools_from_contexts(
    kb_contexts: List[SubtaskContext],
    user_id: int,
    db: Session,
    base_system_prompt: str,
    task_id: Optional[int] = None,
    user_subtask_id: Optional[int] = None,
) -> Tuple[List[BaseTool], str]:
    """
    Prepare knowledge base tools from context records.

    For group chat tasks, this function also includes knowledge bases
    bound to the group chat via knowledgeBaseRefs in the task spec.

    Args:
        kb_contexts: List of knowledge base SubtaskContext records
        user_id: User ID for access control
        db: Database session
        base_system_prompt: Base system prompt to enhance
        task_id: Optional task ID for historical KB meta and group chat KB refs
        user_subtask_id: User subtask ID for RAG persistence

    Returns:
        Tuple of (extra_tools list, enhanced_system_prompt string)
    """
    extra_tools: List[BaseTool] = []
    enhanced_system_prompt = base_system_prompt

    # Extract knowledge_id values from user-selected contexts
    knowledge_base_ids = [
        c.knowledge_id for c in kb_contexts if c.knowledge_id is not None
    ]

    # For group chat tasks, also include bound knowledge bases
    if task_id:
        bound_kb_ids = _get_bound_knowledge_base_ids(db, task_id)
        if bound_kb_ids:
            logger.info(
                f"[_prepare_kb_tools_from_contexts] Adding {len(bound_kb_ids)} "
                f"group chat bound knowledge bases: {bound_kb_ids}"
            )
            # Merge and deduplicate
            knowledge_base_ids = list(set(knowledge_base_ids + bound_kb_ids))

    if not knowledge_base_ids:
        # Even without current knowledge bases, check for historical KB meta
        if task_id:
            kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
            if kb_meta_prompt:
                enhanced_system_prompt = f"{base_system_prompt}{kb_meta_prompt}"
        return extra_tools, enhanced_system_prompt

    logger.info(
        f"[_prepare_kb_tools_from_contexts] Creating KnowledgeBaseTool for "
        f"{len(knowledge_base_ids)} knowledge bases: {knowledge_base_ids}"
    )

    # Import KnowledgeBaseTool
    from app.chat_shell.tools.builtin import KnowledgeBaseTool

    # Create KnowledgeBaseTool with the specified knowledge bases
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        user_id=user_id,
        db_session=db,
        user_subtask_id=user_subtask_id,
    )
    extra_tools.append(kb_tool)

    # Enhance system prompt to REQUIRE AI to use the knowledge base tool
    kb_instruction = """

# IMPORTANT: Knowledge Base Requirement

The user has selected specific knowledge bases for this conversation. You MUST use the `knowledge_base_search` tool to retrieve information from these knowledge bases before answering any questions.

## Required Workflow:
1. **ALWAYS** call `knowledge_base_search` first with the user's query
2. Wait for the search results
3. Base your answer **ONLY** on the retrieved information
4. If the search returns no results or irrelevant information, clearly state: "I cannot find relevant information in the selected knowledge base to answer this question."
5. **DO NOT** use your general knowledge or make assumptions beyond what's in the knowledge base

## Critical Rules:
- You MUST search the knowledge base for EVERY user question
- You MUST NOT answer without searching first
- You MUST NOT make up information if the knowledge base doesn't contain it
- If unsure, search again with different keywords

The user expects answers based on the selected knowledge base content only."""

    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction}"

    # Add historical knowledge base meta info if available
    if task_id:
        kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
        if kb_meta_prompt:
            enhanced_system_prompt = f"{enhanced_system_prompt}{kb_meta_prompt}"

    logger.info(
        "[_prepare_kb_tools_from_contexts] Enhanced system prompt with "
        "REQUIRED knowledge base usage instructions"
    )

    return extra_tools, enhanced_system_prompt


def _get_bound_knowledge_base_ids(db: Session, task_id: int) -> List[int]:
    """
    Get knowledge base IDs bound to a group chat task.

    This function checks if the task is a group chat and retrieves
    the knowledge base IDs from knowledgeBaseRefs in the task spec.

    Note: The knowledgeBaseRefs stores display names (spec.name), not Kind.name.
    We need to query by spec.name to find the correct knowledge base.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        List of knowledge base IDs bound to the group chat
    """
    from app.models.task import TaskResource

    logger.info(f"[_get_bound_knowledge_base_ids] START task_id={task_id}")

    try:
        task = (
            db.query(TaskResource)
            .filter(
                TaskResource.id == task_id,
                TaskResource.kind == "Task",
                TaskResource.is_active.is_(True),
            )
            .first()
        )

        if not task:
            logger.info(f"[_get_bound_knowledge_base_ids] Task not found: {task_id}")
            return []

        task_json = task.json if isinstance(task.json, dict) else {}
        spec = task_json.get("spec", {})
        is_group_chat = spec.get("is_group_chat", False)
        kb_refs = spec.get("knowledgeBaseRefs", []) or []

        logger.info(
            f"[_get_bound_knowledge_base_ids] task_id={task_id}, "
            f"is_group_chat={is_group_chat}, kb_refs_count={len(kb_refs)}, "
            f"kb_refs={kb_refs}"
        )

        # Only process for group chat tasks
        if not is_group_chat:
            return []

        if not kb_refs:
            return []

        from app.models.kind import Kind

        kb_ids = []
        for ref in kb_refs:
            kb_name = ref.get("name")
            kb_namespace = ref.get("namespace", "default")

            if not kb_name:
                continue

            # Find the knowledge base by display name (spec.name) and namespace
            # Note: knowledgeBaseRefs stores display names (spec.name), not Kind.name
            # Kind.name has format 'kb-{user_id}-{namespace}-{display_name}'
            # We need to query all KBs in the namespace and filter by spec.name
            knowledge_bases = (
                db.query(Kind)
                .filter(
                    Kind.kind == "KnowledgeBase",
                    Kind.namespace == kb_namespace,
                    Kind.is_active.is_(True),
                )
                .all()
            )

            # Find the one with matching display name in spec
            kb = None
            for candidate in knowledge_bases:
                kb_spec = candidate.json.get("spec", {}) if candidate.json else {}
                candidate_name = kb_spec.get("name")
                if candidate_name == kb_name:
                    kb = candidate
                    break

            if kb:
                kb_ids.append(kb.id)
                logger.info(
                    f"[_get_bound_knowledge_base_ids] FOUND KB: "
                    f"display_name={kb_name}, namespace={kb_namespace}, id={kb.id}"
                )
            else:
                logger.warning(
                    f"[_get_bound_knowledge_base_ids] NOT FOUND KB: "
                    f"display_name={kb_name}, namespace={kb_namespace}, "
                    f"candidates_count={len(knowledge_bases)}"
                )

        logger.info(
            f"[_get_bound_knowledge_base_ids] RESULT task_id={task_id}, kb_ids={kb_ids}"
        )
        return kb_ids

    except Exception as e:
        # Catch all exceptions to ensure robustness - this function should
        # never block chat functionality even if KB lookup fails
        logger.warning(f"Failed to get bound KB IDs for task {task_id}: {e}")
        return []


def _build_historical_kb_meta_prompt(
    db: Session,
    task_id: int,
) -> str:
    """
    Build knowledge base meta information from historical contexts.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        Formatted prompt string with KB meta info, or empty string
    """
    from app.chat_shell.history.loader import get_knowledge_base_meta_prompt

    try:
        return get_knowledge_base_meta_prompt(db, task_id)
    except Exception as e:
        logger.warning(f"Failed to get KB meta prompt for task {task_id}: {e}")
        return ""


def get_knowledge_base_ids_from_subtask(
    db: Session,
    subtask_id: int,
) -> List[int]:
    """
    Get knowledge base IDs from a subtask's contexts.

    This is a convenience function to extract KB IDs from subtask contexts
    without needing to pass them through the call chain.

    Args:
        db: Database session
        subtask_id: Subtask ID

    Returns:
        List of knowledge_id values from knowledge_base type contexts
    """
    kb_contexts = context_service.get_knowledge_base_contexts_by_subtask(db, subtask_id)
    return [c.knowledge_id for c in kb_contexts if c.knowledge_id is not None]


def get_attachment_context_ids_from_subtask(
    db: Session,
    subtask_id: int,
) -> List[int]:
    """
    Get attachment context IDs from a subtask.

    Args:
        db: Database session
        subtask_id: Subtask ID

    Returns:
        List of attachment context IDs
    """
    attachments = context_service.get_attachments_by_subtask(db, subtask_id)
    return [a.id for a in attachments]
