# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Selected documents processing module for notebook mode.

This module handles the processing of selected documents from the DocumentPanel
in notebook mode. It implements intelligent context injection that:
1. Loads document content from the knowledge base
2. Estimates token count to determine if direct injection is feasible
3. Either injects content directly into the message or falls back to RAG retrieval

The injection strategy follows the same threshold as KnowledgeBaseTool:
- If estimated tokens <= 30% of context window, inject directly
- Otherwise, create KnowledgeBaseTool with document_ids filter for RAG retrieval
"""

import logging
from typing import Any, Dict, List, Optional, Tuple

from langchain_core.tools import BaseTool
from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext

logger = logging.getLogger(__name__)

# Default context window size (same as InjectionStrategy.DEFAULT_CONTEXT_WINDOW)
DEFAULT_CONTEXT_WINDOW = 128000

# Maximum ratio of context window that can be used for document injection
MAX_INJECTION_RATIO = 0.5

# Prompt template for selected documents context (direct injection mode)
SELECTED_DOCUMENTS_PROMPT_TEMPLATE = """
<selected_documents>
# Reference Documents

The following documents have been selected as context for this conversation.
Please use this information to answer the user's questions.

{documents_content}
</selected_documents>
"""

# Prompt template for selected documents RAG mode
SELECTED_DOCUMENTS_RAG_PROMPT = """

<selected_documents>
# Selected Documents Context

The user has selected specific documents from the knowledge base for this conversation.
You MUST use the `knowledge_base_search` tool to retrieve information from these documents.
The search will automatically filter to only the selected documents.

## Required Workflow:
1. Call `knowledge_base_search` with the user's query
2. Base your answer on the retrieved information
3. If no relevant information is found, clearly state that the selected documents don't contain relevant information
</selected_documents>
"""


def process_selected_documents_contexts(
    db: Session,
    selected_docs_contexts: List[SubtaskContext],
    user_id: int,
    message: str | dict[str, Any],
    base_system_prompt: str,
    extra_tools: List[BaseTool],
    user_subtask_id: Optional[int] = None,
    context_window: int = DEFAULT_CONTEXT_WINDOW,
) -> Tuple[str | dict[str, Any], str, List[BaseTool]]:
    """
    Process selected_documents contexts for notebook mode.

    This function implements the intelligent injection strategy:
    1. Load document content from knowledge base documents
    2. Estimate total token count
    3. If within threshold (30% of context window), inject directly into message
    4. If exceeds threshold, create KnowledgeBaseTool with document_ids filter

    Args:
        db: Database session
        selected_docs_contexts: List of selected_documents SubtaskContext records
        user_id: User ID for access control
        message: Original user message (string or vision structure)
        base_system_prompt: Current system prompt (may already be enhanced)
        extra_tools: Current list of extra tools (may already contain KB tool)
        user_subtask_id: User subtask ID for RAG persistence
        context_window: Model context window size

    Returns:
        Tuple of (final_message, enhanced_system_prompt, extra_tools)
    """
    if not selected_docs_contexts:
        return message, base_system_prompt, extra_tools

    # Collect all document IDs and knowledge base IDs from contexts
    all_document_ids: List[int] = []
    knowledge_base_ids: set[int] = set()

    for ctx in selected_docs_contexts:
        if ctx.type_data:
            kb_id = ctx.type_data.get("knowledge_base_id")
            doc_ids = ctx.type_data.get("document_ids", [])
            if kb_id:
                knowledge_base_ids.add(kb_id)
            if doc_ids:
                all_document_ids.extend(doc_ids)

    if not all_document_ids:
        logger.info(
            "[process_selected_documents_contexts] No document IDs found in contexts"
        )
        return message, base_system_prompt, extra_tools

    logger.info(
        f"[process_selected_documents_contexts] Processing {len(all_document_ids)} documents "
        f"from {len(knowledge_base_ids)} knowledge base(s)"
    )

    # Load document content
    documents_content = _load_documents_content(db, all_document_ids)

    if not documents_content:
        logger.warning(
            "[process_selected_documents_contexts] No document content loaded, "
            "falling back to RAG"
        )
        return _create_rag_fallback(
            db=db,
            knowledge_base_ids=list(knowledge_base_ids),
            document_ids=all_document_ids,
            user_id=user_id,
            message=message,
            base_system_prompt=base_system_prompt,
            extra_tools=extra_tools,
            user_subtask_id=user_subtask_id,
        )

    # Estimate token count
    total_chars = sum(len(doc["content"]) for doc in documents_content)
    # Estimate tokens: approximately 4 characters per token
    estimated_tokens = total_chars // 4

    # Calculate threshold
    max_tokens_for_injection = int(context_window * MAX_INJECTION_RATIO)

    logger.info(
        f"[process_selected_documents_contexts] Token estimation: "
        f"total_chars={total_chars}, estimated_tokens={estimated_tokens}, "
        f"threshold={max_tokens_for_injection}, context_window={context_window}"
    )

    if estimated_tokens <= max_tokens_for_injection:
        # Direct injection
        logger.info(
            f"[process_selected_documents_contexts] Using direct injection: "
            f"{len(documents_content)} documents, {estimated_tokens} estimated tokens"
        )
        return _inject_documents_directly(
            documents_content=documents_content,
            message=message,
            base_system_prompt=base_system_prompt,
            extra_tools=extra_tools,
        )
    else:
        # Fall back to RAG
        logger.info(
            f"[process_selected_documents_contexts] Falling back to RAG: "
            f"estimated_tokens={estimated_tokens} exceeds threshold={max_tokens_for_injection}"
        )
        return _create_rag_fallback(
            db=db,
            knowledge_base_ids=list(knowledge_base_ids),
            document_ids=all_document_ids,
            user_id=user_id,
            message=message,
            base_system_prompt=base_system_prompt,
            extra_tools=extra_tools,
            user_subtask_id=user_subtask_id,
        )


def _load_documents_content(
    db: Session,
    document_ids: List[int],
) -> List[Dict[str, Any]]:
    """
    Load document content from knowledge base documents.

    Document content is stored in SubtaskContext.extracted_text,
    linked via KnowledgeDocument.attachment_id.

    Args:
        db: Database session
        document_ids: List of document IDs to load

    Returns:
        List of dicts with document name and content
    """
    documents_content = []

    # Query documents with their attachment IDs (no is_active filter for notebook mode)
    documents = (
        db.query(KnowledgeDocument).filter(KnowledgeDocument.id.in_(document_ids)).all()
    )

    logger.info(
        f"[_load_documents_content] Found {len(documents)} documents "
        f"out of {len(document_ids)} requested"
    )

    # Collect attachment IDs
    attachment_ids = [doc.attachment_id for doc in documents if doc.attachment_id]

    if not attachment_ids:
        logger.warning("[_load_documents_content] No attachment IDs found")
        return documents_content

    # Query attachment contexts to get extracted_text
    attachment_contexts = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id.in_(attachment_ids),
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .all()
    )

    # Build attachment_id -> extracted_text mapping
    attachment_text_map = {
        ctx.id: ctx.extracted_text for ctx in attachment_contexts if ctx.extracted_text
    }

    logger.info(
        f"[_load_documents_content] Found {len(attachment_text_map)} attachments "
        f"with extracted text"
    )

    # Build result
    for doc in documents:
        if doc.attachment_id and doc.attachment_id in attachment_text_map:
            content = attachment_text_map[doc.attachment_id]
            documents_content.append(
                {
                    "id": doc.id,
                    "name": doc.name,
                    "content": content,
                    "file_extension": doc.file_extension,
                }
            )

    logger.info(
        f"[_load_documents_content] Loaded content for {len(documents_content)} documents"
    )

    return documents_content


def _inject_documents_directly(
    documents_content: List[Dict[str, Any]],
    message: str | dict[str, Any],
    base_system_prompt: str,
    extra_tools: List[BaseTool],
) -> Tuple[str | dict[str, Any], str, List[BaseTool]]:
    """
    Inject document content directly into the message.

    Args:
        documents_content: List of document content dicts
        message: Original user message
        base_system_prompt: Current system prompt
        extra_tools: Current list of extra tools

    Returns:
        Tuple of (final_message, enhanced_system_prompt, extra_tools)
    """
    # Build document content string
    doc_parts = []
    for idx, doc in enumerate(documents_content, start=1):
        doc_header = f"## Document {idx}: {doc['name']}"
        if doc.get("file_extension"):
            doc_header += f" ({doc['file_extension']})"
        doc_parts.append(f"{doc_header}\n\n{doc['content']}")

    documents_text = SELECTED_DOCUMENTS_PROMPT_TEMPLATE.format(
        documents_content="\n\n".join(doc_parts)
    )

    # Inject into message
    if isinstance(message, dict) and message.get("type") == "multi_vision":
        # Vision structure - prepend to text
        message["text"] = documents_text + "\n\n" + message["text"]
        final_message = message
    else:
        # String message - prepend documents
        final_message = documents_text + f"\n\n[User Question]:\n{message}"

    logger.info(
        f"[_inject_documents_directly] Injected {len(documents_content)} documents "
        f"({len(documents_text)} chars) into message"
    )

    return final_message, base_system_prompt, extra_tools


def _create_rag_fallback(
    db: Session,
    knowledge_base_ids: List[int],
    document_ids: List[int],
    user_id: int,
    message: str | dict[str, Any],
    base_system_prompt: str,
    extra_tools: List[BaseTool],
    user_subtask_id: Optional[int] = None,
) -> Tuple[str | dict[str, Any], str, List[BaseTool]]:
    """
    Create KnowledgeBaseTool with document_ids filter for RAG fallback.

    Args:
        db: Database session
        knowledge_base_ids: List of knowledge base IDs
        document_ids: List of document IDs to filter
        user_id: User ID for access control
        message: Original user message
        base_system_prompt: Current system prompt
        extra_tools: Current list of extra tools
        user_subtask_id: User subtask ID for RAG persistence

    Returns:
        Tuple of (final_message, enhanced_system_prompt, extra_tools)
    """
    from chat_shell.tools.builtin import KnowledgeBaseTool

    # Check if there's already a KnowledgeBaseTool in extra_tools
    existing_kb_tool = None
    for tool in extra_tools:
        if isinstance(tool, KnowledgeBaseTool):
            existing_kb_tool = tool
            break

    if existing_kb_tool:
        # Update existing tool with document_ids filter
        existing_kb_tool.document_ids = document_ids
        logger.info(
            f"[_create_rag_fallback] Updated existing KnowledgeBaseTool with "
            f"{len(document_ids)} document_ids filter"
        )
    else:
        # Create new KnowledgeBaseTool with document_ids filter
        kb_tool = KnowledgeBaseTool(
            knowledge_base_ids=knowledge_base_ids,
            document_ids=document_ids,
            user_id=user_id,
            db_session=db,
            user_subtask_id=user_subtask_id,
        )
        extra_tools.append(kb_tool)
        logger.info(
            f"[_create_rag_fallback] Created KnowledgeBaseTool for "
            f"{len(knowledge_base_ids)} KBs with {len(document_ids)} document_ids filter"
        )

    enhanced_prompt = base_system_prompt + SELECTED_DOCUMENTS_RAG_PROMPT

    return message, enhanced_prompt, extra_tools
