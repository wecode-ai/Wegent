# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Backend-side direct injection routing and raw document reading.

This module owns the whole "direct injection" capability:

- deciding whether a knowledge request fits the model context window, and
- reading the original document bodies from MySQL for injection.

It intentionally has no dependency on the execution kernel (vector store,
embedding model, query executor) so routing rules can change without pulling
in the retrieval execution stack.
"""

import logging
from typing import Any, Dict, List, Literal, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.rag.runtime_specs import (
    DEFAULT_DIRECT_INJECTION_BUDGET,
    DirectInjectionBudget,
)
from shared.models import RetrievalScope
from shared.telemetry.decorators import add_span_event, set_span_attribute

logger = logging.getLogger(__name__)

RouteMode = Literal["auto", "direct_injection", "rag_retrieval"]

CHAT_SHELL_DIRECT_INJECTION_RATIO = 0.3
CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS = 500
CHAT_SHELL_DIRECT_INJECTION_FORMATTING_OVERHEAD = 50
CHAT_SHELL_DIRECT_INJECTION_CHARS_PER_TOKEN = 4


def estimate_total_tokens_for_knowledge_bases(
    db: Session,
    knowledge_base_ids: list[int],
    document_ids: Optional[list[int]] = None,
) -> int:
    """Estimate aggregate KB token usage using the existing text-length heuristic.

    This estimate is intentionally coarse. It is only used for the first-pass
    auto-routing decision, while the final direct-injection decision is still
    protected by `get_direct_injection_rejection_reason()` with runtime
    chunk-count and context-budget checks.

    We keep the long-standing `text_length * 1.5` heuristic here to stay
    aligned with `/kb-size` and avoid introducing a heavier tokenizer-based
    preflight path on every retrieve request.
    """
    from sqlalchemy import func

    from app.models.knowledge import DocumentStatus, KnowledgeDocument
    from app.models.subtask_context import SubtaskContext

    if not knowledge_base_ids or document_ids == []:
        return 0

    document_query = db.query(func.coalesce(func.sum(SubtaskContext.text_length), 0))
    document_query = document_query.select_from(KnowledgeDocument).join(
        SubtaskContext,
        KnowledgeDocument.attachment_id == SubtaskContext.id,
    )
    document_query = document_query.filter(
        KnowledgeDocument.kind_id.in_(knowledge_base_ids),
        KnowledgeDocument.is_active.is_(True),
        KnowledgeDocument.status == DocumentStatus.ENABLED,
    )
    if document_ids is not None:
        document_query = document_query.filter(KnowledgeDocument.id.in_(document_ids))

    total_text_length = document_query.scalar()
    normalized_text_length = int(total_text_length or 0)
    # Keep the same heuristic for both whole-KB and document-scoped
    # estimation so routing behavior stays stable and predictable.
    #
    # Aggregate functions may still return Decimal on some database/driver
    # combinations, so normalize to int before applying the heuristic.
    return int(normalized_text_length * 1.5)


def should_disable_auto_direct_injection() -> bool:
    """Return whether automatic direct injection routing is globally disabled."""
    return bool(settings.RAG_AUTO_DISABLE_DIRECT_INJECTION)


def should_use_direct_injection(
    available_injection_tokens: Optional[int],
    total_estimated_tokens: int,
    route_mode: RouteMode,
) -> bool:
    """Decide whether chat_shell should receive all chunks for direct injection."""
    if route_mode == "direct_injection":
        return True
    if route_mode == "rag_retrieval":
        return False
    available_for_kb = calculate_ratio_based_direct_injection_budget(
        available_injection_tokens
    )
    if available_for_kb is None:
        return False
    return total_estimated_tokens <= available_for_kb


def calculate_ratio_based_direct_injection_budget(
    available_injection_tokens: Optional[int],
) -> Optional[int]:
    """Calculate the direct-injection ratio threshold from live available budget."""
    if not available_injection_tokens or available_injection_tokens <= 0:
        return None
    return int(available_injection_tokens * CHAT_SHELL_DIRECT_INJECTION_RATIO)


def estimate_direct_injection_tokens(records: list[Dict[str, Any]]) -> int:
    """Estimate tokens for direct injection using a stable chars/token heuristic."""
    if not records:
        return 0

    total_tokens = 0
    for record in records:
        content = record.get("content", "") or ""
        total_tokens += int(len(content) / CHAT_SHELL_DIRECT_INJECTION_CHARS_PER_TOKEN)

    return total_tokens + (
        len(records) * CHAT_SHELL_DIRECT_INJECTION_FORMATTING_OVERHEAD
    )


def calculate_available_injection_tokens(
    context_window: Optional[int],
    used_context_tokens: int,
    reserved_output_tokens: int,
    context_buffer_ratio: float,
) -> Optional[int]:
    """Calculate runtime token budget available for direct injection."""
    if not context_window or context_window <= 0:
        return None

    total_available = context_window - used_context_tokens - reserved_output_tokens
    buffer_space = int(total_available * context_buffer_ratio)
    return max(0, total_available - buffer_space)


def get_direct_injection_rejection_reason(
    route_mode: RouteMode,
    direct_records: list[Dict[str, Any]],
    direct_injection_estimated_tokens: int,
    available_injection_tokens: Optional[int],
    max_direct_chunks: int,
) -> Optional[str]:
    """Return the reason direct injection cannot be finalized."""
    if route_mode == "rag_retrieval":
        return "route_mode_forced_rag"
    if len(direct_records) > max_direct_chunks:
        return "max_direct_chunks_exceeded"
    available_for_kb = calculate_ratio_based_direct_injection_budget(
        available_injection_tokens
    )
    if (
        available_for_kb is not None
        and direct_injection_estimated_tokens > available_for_kb
    ):
        return "context_ratio_exceeded"
    if available_injection_tokens is not None:
        if direct_injection_estimated_tokens > available_injection_tokens:
            return "runtime_budget_exceeded"
    return None


async def try_direct_injection(
    *,
    knowledge_base_ids: list[int],
    scope: RetrievalScope | None,
    db: Session,
    route_mode: RouteMode,
    available_injection_tokens: Optional[int],
    max_direct_chunks: int,
) -> Optional[Dict[str, Any]]:
    """Try direct injection, return None if retrieval should run instead.

    This function encapsulates the direct injection logic including:
    - Fetching original documents
    - Checking for truncated documents
    - Validating against token/chunk limits
    """
    # Fetch original documents - returns None if truncated, [] if no docs, [records] if success
    direct_records = await get_original_documents_from_knowledge_base(
        knowledge_base_ids=knowledge_base_ids,
        db=db,
        document_ids=scope.document_ids if scope else None,
    )

    # None means truncated documents detected, fallback to RAG
    if direct_records is None:
        return None

    # Validate against token/chunk limits
    direct_injection_estimated_tokens = estimate_direct_injection_tokens(direct_records)
    rejection_reason = get_direct_injection_rejection_reason(
        route_mode=route_mode,
        direct_records=direct_records,
        direct_injection_estimated_tokens=direct_injection_estimated_tokens,
        available_injection_tokens=available_injection_tokens,
        max_direct_chunks=max_direct_chunks,
    )

    if rejection_reason:
        logger.info(
            "[RAG] direct injection finalize: document_count=%d (original documents), "
            "estimated_tokens=%d, available_injection_tokens=%s, max_direct_chunks=%d, "
            "rejected=True",
            len(direct_records),
            direct_injection_estimated_tokens,
            available_injection_tokens,
            max_direct_chunks,
        )
        logger.info(
            "[RAG] Falling back to rag_retrieval after direct injection fit check: %s",
            rejection_reason,
        )
        add_span_event(
            "rag.routing.direct_injection_fallback",
            {
                "attempted_document_count": len(direct_records),
                "estimated_tokens": direct_injection_estimated_tokens,
                "fallback_reason": rejection_reason,
                "source": "original_documents",
            },
        )
        return None

    # Direct injection succeeded
    logger.info(
        "[RAG] direct injection finalize: document_count=%d (original documents), "
        "estimated_tokens=%d, available_injection_tokens=%s, max_direct_chunks=%d, "
        "accepted=True",
        len(direct_records),
        direct_injection_estimated_tokens,
        available_injection_tokens,
        max_direct_chunks,
    )
    set_span_attribute("rag.final_mode", "direct_injection")
    add_span_event(
        "rag.routing.direct_injection_selected",
        {
            "record_count": len(direct_records),
            "estimated_tokens": direct_injection_estimated_tokens,
            "source": "original_documents",
        },
    )
    return {
        "mode": "direct_injection",
        "records": direct_records,
        "total": len(direct_records),
        "total_estimated_tokens": direct_injection_estimated_tokens,
    }


async def try_direct_injection_with_budget(
    *,
    knowledge_base_ids: list[int],
    scope: RetrievalScope | None,
    db: Session,
    route_mode: RouteMode,
    budget: Optional[DirectInjectionBudget],
    metadata_condition: Optional[Dict[str, Any]] = None,
) -> Optional[Dict[str, Any]]:
    """Try direct injection using the runtime context budget of a request."""
    # A metadata filter can only be honoured by retrieval, so an explicitly
    # forced direct injection still falls back to retrieval in that case.
    if metadata_condition is not None:
        return None

    resolved_budget = budget or DEFAULT_DIRECT_INJECTION_BUDGET
    return await try_direct_injection(
        knowledge_base_ids=knowledge_base_ids,
        scope=scope,
        db=db,
        route_mode=route_mode,
        available_injection_tokens=calculate_available_injection_tokens(
            context_window=resolved_budget.context_window,
            used_context_tokens=resolved_budget.used_context_tokens,
            reserved_output_tokens=resolved_budget.reserved_output_tokens,
            context_buffer_ratio=resolved_budget.context_buffer_ratio,
        ),
        max_direct_chunks=resolved_budget.max_direct_chunks,
    )


def decide_route_mode_for_chat_shell(
    *,
    query: str,
    knowledge_base_ids: list[int],
    db: Session,
    route_mode: RouteMode = "auto",
    scope: RetrievalScope | None = None,
    metadata_condition: Optional[Dict[str, Any]] = None,
    context_window: Optional[int] = None,
    used_context_tokens: int = 0,
    reserved_output_tokens: int = 4096,
    context_buffer_ratio: float = 0.1,
    max_direct_chunks: int = CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS,
) -> Literal["direct_injection", "rag_retrieval"]:
    """Resolve the coarse query route while keeping final direct-fit local."""
    del query, max_direct_chunks
    if not knowledge_base_ids:
        return "rag_retrieval"
    if metadata_condition is not None:
        return "rag_retrieval"

    if route_mode == "auto" and should_disable_auto_direct_injection():
        logger.info(
            "[RAG] auto direct injection disabled by config; forcing rag_retrieval"
        )
        return "rag_retrieval"

    total_estimated_tokens = 0
    if route_mode == "auto":
        total_estimated_tokens = estimate_total_tokens_for_knowledge_bases(
            db=db,
            knowledge_base_ids=knowledge_base_ids,
            document_ids=scope.document_ids if scope else None,
        )

    available_injection_tokens = calculate_available_injection_tokens(
        context_window=context_window,
        used_context_tokens=used_context_tokens,
        reserved_output_tokens=reserved_output_tokens,
        context_buffer_ratio=context_buffer_ratio,
    )

    use_direct_injection = should_use_direct_injection(
        available_injection_tokens=available_injection_tokens,
        total_estimated_tokens=total_estimated_tokens,
        route_mode=route_mode,
    )
    if not use_direct_injection:
        return "rag_retrieval"
    if (
        route_mode == "auto"
        and available_injection_tokens is not None
        and total_estimated_tokens > available_injection_tokens
    ):
        return "rag_retrieval"

    return "direct_injection"


async def get_original_documents_from_knowledge_base(
    knowledge_base_ids: list[int],
    db: Session,
    document_ids: Optional[list[int]] = None,
) -> Optional[List[Dict[str, Any]]]:
    """Get original documents from knowledge bases for direct injection.

    Returns complete original document content from MySQL instead of
    chunked content from Elasticsearch. This preserves document structure
    (especially tables) and reduces network overhead.

    IMPORTANT: This function implements truncation detection to prevent
    injecting incomplete content. If any document's text_length is >=
    MAX_EXTRACTED_TEXT_LENGTH, the function returns None to trigger fallback
    to RAG retrieval.

    Args:
        knowledge_base_ids: List of knowledge base IDs to search.
        db: Database session
        document_ids: Optional list of document IDs to filter. If provided,
            queries directly by document IDs within the knowledge_base_ids scope.

    Returns:
        - None: Documents are truncated, should fallback to RAG
        - []: No documents found
        - [records]: List of document dicts with content, score, title, metadata
    """
    from app.models.knowledge import DocumentStatus, KnowledgeDocument
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge.document_read_service import document_read_service

    if not knowledge_base_ids:
        logger.warning("[RAG] get_original_documents: no knowledge base IDs provided")
        return []

    max_text_length = settings.MAX_EXTRACTED_TEXT_LENGTH
    records: List[Dict[str, Any]] = []

    # Case 1: Query by document IDs with KB scope filter
    if document_ids is not None:
        if not document_ids:
            return []

        query = (
            db.query(
                KnowledgeDocument.id,
                KnowledgeDocument.kind_id,
                SubtaskContext.text_length,
            )
            .select_from(KnowledgeDocument)
            .join(
                SubtaskContext,
                KnowledgeDocument.attachment_id == SubtaskContext.id,
            )
            .filter(
                KnowledgeDocument.is_active.is_(True),
                KnowledgeDocument.status == DocumentStatus.ENABLED,
            )
            .filter(KnowledgeDocument.id.in_(document_ids))
            .filter(KnowledgeDocument.kind_id.in_(knowledge_base_ids))
        )
        doc_rows = query.all()

        if not doc_rows:
            logger.info(
                "[RAG] get_original_documents: no documents found for doc_ids=%s in kb_ids=%s",
                document_ids,
                knowledge_base_ids,
            )
            return []

        has_truncated = any((row[2] or 0) >= max_text_length for row in doc_rows)
        if has_truncated:
            truncated_ids = [
                row[0] for row in doc_rows if (row[2] or 0) >= max_text_length
            ]
            logger.warning(
                "[RAG] Documents truncated, rejecting direct_injection: "
                "kb_ids=%s, truncated_doc_ids=%s",
                knowledge_base_ids,
                truncated_ids,
            )
            return None

        all_document_ids = [row[0] for row in doc_rows]
        results = document_read_service.read_documents(
            db=db,
            document_ids=all_document_ids,
            offset=0,
            limit=10_000_000,
            knowledge_base_ids=knowledge_base_ids,
        )
        records = build_document_records(results, knowledge_base_ids)
        logger.info(
            "[RAG] get_original_documents completed: doc_ids=%s, document_count=%d",
            document_ids,
            len(records),
        )
        return records

    # Case 2: Query each KB sequentially, stop on first truncation
    for kb_id in knowledge_base_ids:
        query = (
            db.query(
                KnowledgeDocument.id,
                KnowledgeDocument.kind_id,
                SubtaskContext.text_length,
            )
            .select_from(KnowledgeDocument)
            .join(
                SubtaskContext,
                KnowledgeDocument.attachment_id == SubtaskContext.id,
            )
            .filter(
                KnowledgeDocument.is_active.is_(True),
                KnowledgeDocument.status == DocumentStatus.ENABLED,
            )
            .filter(KnowledgeDocument.kind_id == kb_id)
        )
        doc_rows = query.all()

        if not doc_rows:
            continue

        has_truncated = any((row[2] or 0) >= max_text_length for row in doc_rows)
        if has_truncated:
            truncated_ids = [
                row[0] for row in doc_rows if (row[2] or 0) >= max_text_length
            ]
            logger.warning(
                "[RAG] Documents truncated, rejecting direct_injection: "
                "kb_id=%s, truncated_doc_ids=%s",
                kb_id,
                truncated_ids,
            )
            return None

        all_document_ids = [row[0] for row in doc_rows]
        results = document_read_service.read_documents(
            db=db,
            document_ids=all_document_ids,
            offset=0,
            limit=10_000_000,
            knowledge_base_ids=[kb_id],
        )
        records.extend(build_document_records(results, [kb_id]))

    logger.info(
        "[RAG] get_original_documents completed: kb_ids=%s, document_count=%d",
        knowledge_base_ids,
        len(records),
    )
    return records


def build_document_records(
    results: List[Dict[str, Any]],
    knowledge_base_ids: list[int],
) -> List[Dict[str, Any]]:
    """Build document records from read results."""
    records = []
    kb_id = knowledge_base_ids[0] if len(knowledge_base_ids) == 1 else None

    for result in results:
        if result.get("error"):
            logger.warning(
                "[RAG] get_original_documents: skip document %s due to error: %s",
                result.get("id"),
                result.get("error"),
            )
            continue
        records.append(
            {
                "content": result.get("content", ""),
                "score": 1.0,
                "title": result.get("name", "Unknown"),
                "metadata": {
                    "document_id": result.get("id"),
                    "total_length": result.get("total_length", 0),
                },
                "knowledge_base_id": kb_id or result.get("kb_id"),
            }
        )

    return records
