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

# Knowledge base prompt constants
# These are duplicated from chat_shell/prompts/knowledge_base.py for backend use
# Strict mode prompt: User explicitly selected KB for this message
KB_PROMPT_STRICT = """

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

# Relaxed mode prompt: KB inherited from task, AI can use general knowledge as fallback
KB_PROMPT_RELAXED = """

# Knowledge Base Available

You have access to knowledge bases from previous conversations in this task. You can use the `knowledge_base_search` tool to retrieve information from these knowledge bases.

## Recommended Workflow:
1. When the user's question might be related to the knowledge base content, consider calling `knowledge_base_search` with relevant keywords
2. If relevant information is found, prioritize using it in your answer and cite the sources
3. If the search returns no results or irrelevant information, you may use your general knowledge to answer the question
4. Be transparent about whether your answer is based on knowledge base content or general knowledge

## Guidelines:
- Search the knowledge base when the question seems related to its content
- If the knowledge base doesn't contain relevant information, feel free to answer using your general knowledge
- Clearly indicate when your answer is based on knowledge base content vs. general knowledge
- The knowledge base is a helpful resource, but you are not limited to it when it doesn't have relevant information"""

# Table context prompt template - will be dynamically generated with table info
TABLE_PROMPT_TEMPLATE = """

# IMPORTANT: Data Table Context - HIGHEST PRIORITY

The user has selected data table(s) for this conversation. This indicates that the user's request is related to these tables.

## Available Tables:
{tables_info}

## Critical Rules - READ CAREFULLY:
1. **ALWAYS assume the user's request is about the selected table(s)** unless they explicitly mention otherwise
2. When the user says "分析" (analyze), "查看" (view), "统计" (statistics), or similar words, they mean to analyze/view the selected table(s)
3. **DO NOT** use other analysis tools (like PaaS analysis) when a table is selected - use the table tool instead
4. **You MUST pass `provider`, `base_id`, and `sheet_id_or_name` parameters** when calling the table tool

## Available Table Tool:
- `data_table_query`: Query table data including both schema (field definitions) and records (data rows)

## Workflow:
1. Call `data_table_query` with the correct `provider`, `base_id`, and `sheet_id_or_name` to get table schema and data
2. Analyze the returned data based on user's request
3. Present the results

The user explicitly selected these table(s) - prioritize table operations over any other tools."""


def build_table_prompt(table_contexts: List[dict]) -> str:
    """
    Build dynamic TABLE_PROMPT with actual table information.

    Args:
        table_contexts: List of table context dicts with name, provider, baseId, sheetIdOrName

    Returns:
        Formatted prompt string with table info
    """
    if not table_contexts:
        return ""

    tables_info_lines = []
    for i, ctx in enumerate(table_contexts, 1):
        name = ctx.get("name", f"Table {i}")
        provider = ctx.get("provider", "")
        base_id = ctx.get("baseId", "")
        sheet_id = ctx.get("sheetIdOrName", "")
        tables_info_lines.append(
            f"{i}. **{name}**\n"
            f"   - provider: `{provider}`\n"
            f"   - base_id: `{base_id}`\n"
            f"   - sheet_id_or_name: `{sheet_id}`"
        )

    tables_info = "\n".join(tables_info_lines)
    return TABLE_PROMPT_TEMPLATE.format(tables_info=tables_info)


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
    task: Optional["TaskResource"] = None,
    user_name: Optional[str] = None,
) -> List[int]:
    """
    Link attachments and create knowledge base/table contexts for a subtask.

    This function handles three types of contexts in a single database transaction:
    1. Attachments: Pre-uploaded files with existing context IDs, batch update subtask_id
    2. Knowledge bases: Selected at send time, batch create SubtaskContext records
       (without extracted_text - RAG retrieval is done later via tools/Service)
    3. Tables: Selected at send time, batch create SubtaskContext records
       (table context is used for MCP tool injection)

    When knowledge bases are created, they are automatically synced to the task-level
    knowledgeBaseRefs for future use across all subtasks.

    Args:
        db: Database session
        subtask_id: Subtask ID to link contexts to
        user_id: User ID
        attachment_ids: List of pre-uploaded attachment context IDs to link
        contexts: List of ContextItem objects from payload (for knowledge bases and tables)
        task: Optional pre-queried TaskResource object for syncing KB to task level
        user_name: Optional pre-queried user name for KB sync boundBy field

    Returns:
        List of all linked/created context IDs
    """
    # Import TaskResource for type hint
    from app.models.task import TaskResource

    linked_context_ids = []

    # Collect attachment IDs to link
    if attachment_ids:
        linked_context_ids.extend(attachment_ids)

    # Prepare knowledge base and table contexts for batch creation
    kb_contexts_to_create, table_contexts_to_create = _prepare_contexts_for_creation(
        contexts, subtask_id, user_id
    )

    # Combine all contexts to create
    all_contexts_to_create = kb_contexts_to_create + table_contexts_to_create

    # Execute all database operations in a single transaction
    try:
        created_context_ids = _batch_update_and_insert_contexts(
            db, attachment_ids, all_contexts_to_create, subtask_id
        )
        linked_context_ids.extend(created_context_ids)

        # Sync subtask-level knowledge bases to task level
        if task and kb_contexts_to_create and user_name:
            _sync_kb_contexts_to_task(
                db, kb_contexts_to_create, task, user_id, user_name
            )

    except Exception as e:
        db.rollback()
        logger.exception(f"Failed to link contexts to subtask {subtask_id}: {e}")
        raise

    return linked_context_ids


def _sync_kb_contexts_to_task(
    db: Session,
    kb_contexts: List[SubtaskContext],
    task: "TaskResource",
    user_id: int,
    user_name: str,
) -> None:
    """
    Sync subtask-level knowledge base contexts to task-level knowledgeBaseRefs.

    This function syncs each KB selected in the subtask to the task level using
    append mode with deduplication. Failures are logged but do not raise exceptions.

    Args:
        db: Database session
        kb_contexts: List of KB SubtaskContext objects that were just created
        task: Pre-queried TaskResource object to sync KBs to
        user_id: User ID who selected the KBs
        user_name: Pre-queried user name for boundBy field
    """
    from app.services.knowledge import TaskKnowledgeBaseService

    task_kb_service = TaskKnowledgeBaseService()
    for kb_context in kb_contexts:
        knowledge_id = (
            kb_context.type_data.get("knowledge_id") if kb_context.type_data else None
        )
        if not knowledge_id:
            continue

        try:
            synced = task_kb_service.sync_subtask_kb_to_task(
                db=db,
                task=task,
                knowledge_id=knowledge_id,
                user_id=user_id,
                user_name=user_name,
            )
            if synced:
                logger.info(
                    f"[_sync_kb_contexts_to_task] Synced KB {knowledge_id} "
                    f"from subtask to task {task.id}"
                )
        except Exception as e:
            # Log but don't fail - syncing to task level is best-effort
            logger.warning(
                f"[_sync_kb_contexts_to_task] Failed to sync KB {knowledge_id} "
                f"to task {task.id}: {e}"
            )


def _prepare_contexts_for_creation(
    contexts: List[Any] | None,
    subtask_id: int,
    user_id: int,
) -> Tuple[List[SubtaskContext], List[SubtaskContext]]:
    """
    Prepare knowledge base and table contexts for batch creation.

    Args:
        contexts: List of ContextItem objects from payload
        subtask_id: Subtask ID to link contexts to
        user_id: User ID

    Returns:
        Tuple of (kb_contexts, table_contexts) ready for insertion
    """
    kb_contexts_to_create: List[SubtaskContext] = []
    table_contexts_to_create: List[SubtaskContext] = []

    if not contexts:
        return kb_contexts_to_create, table_contexts_to_create

    for ctx in contexts:
        if ctx.type == "knowledge_base":
            try:
                kb_data = ctx.data
                knowledge_id = kb_data.get("knowledge_id")
                kb_name = kb_data.get("name", f"Knowledge Base {knowledge_id}")
                document_count = kb_data.get("document_count")
                # Get document_ids if user referenced specific documents
                document_ids = kb_data.get("document_ids", [])

                # Build type_data
                type_data_dict = {
                    "knowledge_id": int(knowledge_id) if knowledge_id else 0,
                    "document_count": document_count,
                }
                # Only add document_ids if provided
                if document_ids:
                    type_data_dict["document_ids"] = document_ids

                # Create SubtaskContext object (not yet committed)
                kb_context = SubtaskContext(
                    subtask_id=subtask_id,
                    user_id=user_id,
                    context_type=ContextType.KNOWLEDGE_BASE.value,
                    name=kb_name,
                    status=ContextStatus.READY.value,
                    type_data=type_data_dict,
                )
                kb_contexts_to_create.append(kb_context)
            except Exception as e:
                logger.warning(f"Failed to prepare knowledge base context: {e}")
                continue

        elif ctx.type == "table":
            try:
                table_data = ctx.data
                document_id = table_data.get("document_id")
                table_name = table_data.get("name", f"Table {document_id}")
                # URL is in source_config.url from frontend TableContext
                source_config = table_data.get("source_config", {})
                table_url = source_config.get("url", "") if source_config else ""

                # Create SubtaskContext object for table (not yet committed)
                table_context = SubtaskContext(
                    subtask_id=subtask_id,
                    user_id=user_id,
                    context_type=ContextType.TABLE.value,
                    name=table_name,
                    status=ContextStatus.READY.value,
                    type_data={
                        "document_id": int(document_id) if document_id else 0,
                        "url": table_url,
                    },
                )
                table_contexts_to_create.append(table_context)
            except Exception as e:
                logger.warning(f"Failed to prepare table context: {e}")
                continue

    return kb_contexts_to_create, table_contexts_to_create


def _batch_update_and_insert_contexts(
    db: Session,
    attachment_ids: List[int] | None,
    contexts_to_create: List[SubtaskContext],
    subtask_id: int,
) -> List[int]:
    """
    Execute batch update and insert operations for contexts.

    Args:
        db: Database session
        attachment_ids: List of attachment context IDs to update
        contexts_to_create: List of contexts (KB or table) to insert
        subtask_id: Subtask ID for logging

    Returns:
        List of created context IDs
    """
    created_context_ids = []

    # Batch update existing attachments' subtask_id
    if attachment_ids:
        db.query(SubtaskContext).filter(SubtaskContext.id.in_(attachment_ids)).update(
            {"subtask_id": subtask_id},
            synchronize_session=False,
        )

    # Batch add new contexts (KB and table)
    if contexts_to_create:
        db.add_all(contexts_to_create)

    # Single commit for all operations
    db.commit()

    # Refresh contexts to get their IDs
    for ctx in contexts_to_create:
        db.refresh(ctx)
        created_context_ids.append(ctx.id)
        logger.debug(
            f"Created {ctx.context_type} context: id={ctx.id}, "
            f"name={ctx.name}, subtask_id={subtask_id}, "
            f"type_data={ctx.type_data}"
        )

    # Log summary
    if attachment_ids:
        logger.info(
            f"Linked {len(attachment_ids)} attachment contexts to subtask {subtask_id}"
        )
    if contexts_to_create:
        kb_count = sum(
            1
            for c in contexts_to_create
            if c.context_type == ContextType.KNOWLEDGE_BASE.value
        )
        table_count = sum(
            1 for c in contexts_to_create if c.context_type == ContextType.TABLE.value
        )
        logger.info(
            f"Created {kb_count} knowledge base contexts and {table_count} table contexts "
            f"for subtask {subtask_id}"
        )

    return created_context_ids


# ==================== Unified Context Processing ====================


async def prepare_contexts_for_chat(
    db: Session,
    user_subtask_id: int,
    user_id: int,
    message: str,
    base_system_prompt: str,
    task_id: Optional[int] = None,
) -> Tuple[str, str, List[BaseTool], bool, List[dict]]:
    """
    Unified context processing based on user_subtask_id.

    This function retrieves all contexts associated with a user subtask and:
    1. Processes attachment contexts - injects content into the message
    2. Processes knowledge base contexts - creates KnowledgeBaseTool for RAG
    3. Processes table contexts - injects table info into system prompt

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
        Tuple of (final_message, enhanced_system_prompt, extra_tools, has_table_context, table_contexts)
    """
    from .tables import parse_table_url

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
        return message, enhanced_prompt, extra_tools, False, []

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
    table_contexts = [
        c
        for c in contexts
        if c.context_type == ContextType.TABLE.value
        and c.status == ContextStatus.READY.value
    ]

    logger.info(
        f"[prepare_contexts_for_chat] subtask={user_subtask_id}: "
        f"{len(attachment_contexts)} attachments, {len(kb_contexts)} knowledge bases, "
        f"{len(table_contexts)} tables"
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

    # 3. Process table contexts - create DataTableTool and build dynamic prompt
    parsed_tables = []
    if table_contexts:
        for table_ctx in table_contexts:
            logger.info(
                f"[prepare_contexts_for_chat] Processing table context: "
                f"id={table_ctx.id}, name={table_ctx.name}, type_data={table_ctx.type_data}"
            )
            table_url = (
                table_ctx.type_data.get("url", "") if table_ctx.type_data else ""
            )

            if table_url:
                table_info = parse_table_url(table_url)
                if table_info:
                    # Add table name to the parsed info
                    table_info["name"] = table_ctx.name
                    parsed_tables.append(table_info)
                    logger.info(
                        f"[prepare_contexts_for_chat] Table parsed: name={table_ctx.name}, "
                        f"baseId={table_info.get('baseId')}, "
                        f"sheetIdOrName={table_info.get('sheetIdOrName')}"
                    )
                else:
                    logger.warning(
                        f"[prepare_contexts_for_chat] Failed to parse table URL: {table_url}"
                    )
            else:
                logger.warning(
                    f"[prepare_contexts_for_chat] Table context has no URL in type_data"
                )

        # Note: DataTableTool creation is handled by chat_shell service in HTTP mode.
        # In non-HTTP mode (deprecated), the tool would be created here, but since
        # we're standardizing on HTTP mode, we only return parsed_tables for chat_shell.
        # chat_shell will create the DataTableTool when it receives table_contexts.
        if parsed_tables:
            table_prompt = build_table_prompt(parsed_tables)
            enhanced_system_prompt = f"{enhanced_system_prompt}{table_prompt}"
            logger.info(
                f"[prepare_contexts_for_chat] Added {len(parsed_tables)} table(s) to system prompt. "
                f"Table contexts will be passed to chat_shell for DataTableTool creation."
            )

    has_table_context = len(table_contexts) > 0
    return (
        final_message,
        enhanced_system_prompt,
        extra_tools,
        has_table_context,
        parsed_tables,
    )


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

    Knowledge base priority rules:
    1. If subtask has selected knowledge bases (kb_contexts), use ONLY those (strict mode)
    2. If subtask has no KB selection, fall back to task-level knowledgeBaseRefs (relaxed mode)

    This ensures user's explicit KB selection in a message takes precedence
    over task-level bound knowledge bases.

    Prompt mode:
    - Strict mode: User explicitly selected KB for this message, AI must use KB only
    - Relaxed mode: KB inherited from task, AI can use general knowledge as fallback

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

    # Priority 1: Subtask-level knowledge bases (user-selected for this message)
    subtask_kb_ids = [c.knowledge_id for c in kb_contexts if c.knowledge_id is not None]

    # Track whether KB is user-selected (strict mode) or inherited from task (relaxed mode)
    is_user_selected_kb = bool(subtask_kb_ids)

    # Determine which knowledge bases to use based on priority
    if subtask_kb_ids:
        # Use subtask-level KBs only (user's explicit selection takes precedence)
        knowledge_base_ids = subtask_kb_ids
        logger.info(
            f"[_prepare_kb_tools_from_contexts] Using {len(knowledge_base_ids)} "
            f"subtask-level knowledge bases (priority 1, strict mode): {knowledge_base_ids}"
        )
    elif task_id:
        # Priority 2: Fall back to task-level bound knowledge bases
        knowledge_base_ids = _get_bound_knowledge_base_ids(db, task_id)
        if knowledge_base_ids:
            logger.info(
                f"[_prepare_kb_tools_from_contexts] Using {len(knowledge_base_ids)} "
                f"task-level bound knowledge bases (priority 2, relaxed mode): {knowledge_base_ids}"
            )
    else:
        knowledge_base_ids = []

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
    from chat_shell.tools.builtin import KnowledgeBaseTool

    # Create KnowledgeBaseTool with the specified knowledge bases
    kb_tool = KnowledgeBaseTool(
        knowledge_base_ids=knowledge_base_ids,
        user_id=user_id,
        db_session=db,
        user_subtask_id=user_subtask_id,
    )
    extra_tools.append(kb_tool)

    # Choose prompt based on whether KB is user-selected or inherited from task
    if is_user_selected_kb:
        # Strict mode: User explicitly selected KB for this message
        kb_instruction = KB_PROMPT_STRICT
        logger.info(
            "[_prepare_kb_tools_from_contexts] Using STRICT mode prompt "
            "(user explicitly selected KB)"
        )
    else:
        # Relaxed mode: KB inherited from task, AI can use general knowledge as fallback
        kb_instruction = KB_PROMPT_RELAXED
        logger.info(
            "[_prepare_kb_tools_from_contexts] Using RELAXED mode prompt "
            "(KB inherited from task)"
        )

    enhanced_system_prompt = f"{base_system_prompt}{kb_instruction}"

    # Add historical knowledge base meta info if available
    if task_id:
        kb_meta_prompt = _build_historical_kb_meta_prompt(db, task_id)
        if kb_meta_prompt:
            enhanced_system_prompt = f"{enhanced_system_prompt}{kb_meta_prompt}"

    return extra_tools, enhanced_system_prompt


def _get_bound_knowledge_base_ids(db: Session, task_id: int) -> List[int]:
    """
    Get knowledge base IDs bound to a task.

    This function delegates to task_knowledge_base_service.get_bound_knowledge_base_ids()
    for the actual lookup and migration logic. It wraps the call with additional
    error handling to ensure chat functionality is never blocked.

    The underlying service uses ID-priority lookup with name fallback for
    backward compatibility. Legacy refs (name-only) are automatically
    migrated to include the ID field.

    Args:
        db: Database session
        task_id: Task ID

    Returns:
        List of knowledge base IDs bound to the task
    """
    from app.services.knowledge.task_knowledge_base_service import (
        task_knowledge_base_service,
    )

    logger.info(f"[_get_bound_knowledge_base_ids] START task_id={task_id}")

    try:
        kb_ids = task_knowledge_base_service.get_bound_knowledge_base_ids(db, task_id)
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
    from chat_shell.history.loader import get_knowledge_base_meta_prompt

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


def get_document_ids_from_subtask(
    db: Session,
    subtask_id: int,
) -> List[int]:
    """
    Get document IDs from a subtask's knowledge base contexts.

    When a user references specific documents from a knowledge base,
    the document_ids are stored in the context's type_data field.
    This function extracts all document IDs from all KB contexts.

    Args:
        db: Database session
        subtask_id: Subtask ID

    Returns:
        List of document_id values from knowledge_base type contexts
    """
    kb_contexts = context_service.get_knowledge_base_contexts_by_subtask(db, subtask_id)
    document_ids = []
    for c in kb_contexts:
        if c.type_data and isinstance(c.type_data, dict):
            doc_ids = c.type_data.get("document_ids", [])
            if doc_ids:
                document_ids.extend(doc_ids)
    return document_ids


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


def get_table_context_ids_from_subtask(
    db: Session,
    subtask_id: int,
) -> List[int]:
    """
    Get table context IDs from a subtask.

    Args:
        db: Database session
        subtask_id: Subtask ID

    Returns:
        List of table context IDs
    """
    contexts = context_service.get_by_subtask(db, subtask_id)
    return [
        c.id
        for c in contexts
        if c.context_type == ContextType.TABLE.value
        and c.status == ContextStatus.READY.value
    ]
