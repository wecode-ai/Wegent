# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Knowledge Base Indexing Service - Shared logic for RAG document indexing.

This module provides the core indexing functionality used by both:
- REST API (via BackgroundTasks or Celery)
- MCP Tools (via Celery)
- Celery Tasks

By centralizing the indexing logic here, we:
1. Eliminate circular imports between endpoints, orchestrator, and tasks
2. Provide a single source of truth for indexing logic
3. Make it easy to switch between BackgroundTasks and Celery

Key concepts:
- KnowledgeBaseIndexInfo: Container for KB-related indexing metadata
- RAGIndexingParams: Parameters needed for scheduling RAG indexing
- run_document_indexing: Core function that performs the actual indexing
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Any, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask_context import ContextType, SubtaskContext
from app.schemas.rag import SplitterConfig
from app.services.knowledge.index_runtime import (
    KnowledgeBaseIndexInfo,
    build_kb_index_info,
    get_kb_index_info,
    resolve_kb_index_info,
)
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.runtime_resolver import RagRuntimeResolver
from app.services.rag.splitter.runtime_config import parse_runtime_splitter_config
from shared.telemetry import add_span_event

logger = logging.getLogger(__name__)
runtime_resolver = RagRuntimeResolver()
rag_gateway = LocalRagGateway()

# Excel file size limit for RAG indexing (2MB)
EXCEL_FILE_SIZE_LIMIT = 2 * 1024 * 1024  # 2MB in bytes
EXCEL_EXTENSIONS = frozenset({".xls", ".xlsx"})


@dataclass
class RAGIndexingParams:
    """Parameters for scheduling RAG document indexing."""

    knowledge_base_id: str
    attachment_id: int
    document_id: int
    retriever_name: str
    retriever_namespace: str
    embedding_model_name: str
    embedding_model_namespace: str
    user_id: int
    user_name: str
    splitter_config: Optional[SplitterConfig]
    kb_index_info: KnowledgeBaseIndexInfo


def normalize_document_extension(file_extension: Optional[str]) -> str:
    """Normalize a document extension for indexing checks."""
    ext = (file_extension or "").strip().lower()
    if not ext:
        return ""
    if not ext.startswith("."):
        return f".{ext}"
    return ext


def get_rag_indexing_skip_reason(
    source_type: Optional[str],
    file_extension: Optional[str],
    file_size: Optional[int] = None,
) -> Optional[str]:
    """Return the reason why a document should skip RAG indexing, if any.

    Args:
        source_type: The source type of the document (e.g., "file", "table")
        file_extension: The file extension (e.g., ".xlsx", "pdf")
        file_size: The file size in bytes (optional, used for Excel file size check)

    Returns:
        A string describing the reason to skip indexing, or None if indexing is allowed
    """
    normalized_source_type = (source_type or "").strip().lower()
    normalized_extension = normalize_document_extension(file_extension)

    if normalized_source_type == "table":
        return (
            "Table documents are queried in real-time and do not support RAG indexing"
        )

    # Check Excel file size limit (2MB)
    if normalized_extension in EXCEL_EXTENSIONS:
        if file_size is not None and file_size > EXCEL_FILE_SIZE_LIMIT:
            size_mb = file_size / (1024 * 1024)
            limit_mb = EXCEL_FILE_SIZE_LIMIT / (1024 * 1024)
            # Return error code with parameters for i18n support
            # Format: EXCEL_FILE_SIZE_EXCEEDED|extension|limit|size
            return f"EXCEL_FILE_SIZE_EXCEEDED|{normalized_extension}|{limit_mb:.0f}|{size_mb:.2f}"

    return None


def parse_splitter_config(config_dict: dict) -> Optional[SplitterConfig]:
    """
    Parse a dictionary into the appropriate SplitterConfig type.

    Since SplitterConfig is a Union type, it cannot be instantiated directly.
    This function determines the correct type based on the 'type' field.

    Args:
        config_dict: Dictionary containing splitter configuration

    Returns:
        SemanticSplitterConfig, SentenceSplitterConfig, or SmartSplitterConfig instance,
        or None if invalid
    """
    return parse_runtime_splitter_config(config_dict)


def _serialize_splitter_config(
    splitter_config: Optional[SplitterConfig],
    splitter_config_dict: Optional[dict],
) -> Optional[dict]:
    """Normalize splitter config to a plain dict for runtime spec transport."""
    if splitter_config_dict:
        return splitter_config_dict
    if splitter_config is None:
        return None
    return splitter_config.model_dump(exclude_none=True)


def extract_rag_config_from_knowledge_base(
    db: Session, knowledge_base: Kind, current_user_id: int
) -> Optional[RAGIndexingParams]:
    """
    Extract RAG indexing configuration from a knowledge base.

    Returns None if the knowledge base doesn't have complete RAG configuration.
    Otherwise returns a dict with all configuration values needed for indexing.

    Args:
        db: Database session
        knowledge_base: The knowledge base Kind object
        current_user_id: The current user's ID for determining index owner

    Returns:
        RAGIndexingParams with extracted config, or None if incomplete config
    """
    spec = (knowledge_base.json or {}).get("spec", {})
    retrieval_config = spec.get("retrievalConfig")

    logger.debug(
        f"[Indexing] KB {knowledge_base.id}: retrievalConfig = {retrieval_config}"
    )

    if not retrieval_config:
        logger.warning(
            f"[Indexing] KB {knowledge_base.id}: No retrievalConfig found in spec"
        )
        return None

    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    embedding_config = retrieval_config.get("embedding_config")

    logger.debug(
        f"[Indexing] KB {knowledge_base.id}: retriever_name={retriever_name}, "
        f"retriever_namespace={retriever_namespace}, embedding_config={embedding_config}"
    )

    if not retriever_name or not embedding_config:
        logger.warning(
            f"[Indexing] KB {knowledge_base.id}: Missing retriever_name or embedding_config. "
            f"retriever_name={retriever_name}, embedding_config={embedding_config}"
        )
        return None

    embedding_model_name = embedding_config.get("model_name")
    embedding_model_namespace = embedding_config.get("model_namespace", "default")

    if not embedding_model_name:
        logger.warning(
            f"[Indexing] KB {knowledge_base.id}: Missing embedding model_name. "
            f"embedding_config={embedding_config}"
        )
        return None

    kb_index_info = build_kb_index_info(
        db=db,
        knowledge_base=knowledge_base,
        current_user_id=current_user_id,
    )

    # Return partial params - document-specific fields will be filled by caller
    return RAGIndexingParams(
        knowledge_base_id="",  # To be filled by caller
        attachment_id=0,  # To be filled by caller
        document_id=0,  # To be filled by caller
        retriever_name=retriever_name,
        retriever_namespace=retriever_namespace,
        embedding_model_name=embedding_model_name,
        embedding_model_namespace=embedding_model_namespace,
        user_id=current_user_id,
        user_name="",  # To be filled by caller
        splitter_config=None,  # To be filled by caller
        kb_index_info=kb_index_info,
    )


def run_document_indexing(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    user_name: str,
    splitter_config: Optional[SplitterConfig] = None,
    splitter_config_dict: Optional[dict] = None,
    document_id: Optional[int] = None,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
    trigger_summary: bool = True,
    db: Optional[Session] = None,
) -> dict:
    """
    Core function for RAG document indexing.

    This is a synchronous function that creates its own event loop to run
    the async indexing code. It can be called from:
    - FastAPI BackgroundTasks
    - Celery tasks
    - Directly from other services

    Args:
        knowledge_base_id: Knowledge base ID
        attachment_id: Attachment ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace
        embedding_model_name: Embedding model name
        embedding_model_namespace: Embedding model namespace
        user_id: User ID (the user who triggered the indexing)
        user_name: Username for placeholder resolution
        splitter_config: Optional splitter configuration object
        splitter_config_dict: Optional splitter config as dict (for Celery serialization)
        document_id: Optional document ID to use as doc_ref
        kb_index_info: Pre-computed KB info (avoids redundant DB query if provided)
        trigger_summary: Whether to trigger summary generation after indexing
        db: Optional database session (will create new one if not provided)

    Returns:
        Dict with status, document_id, and indexed_count
    """
    logger.info(
        f"[Indexing] Starting: kb_id={knowledge_base_id}, "
        f"attachment_id={attachment_id}, document_id={document_id}"
    )
    add_span_event(
        "rag.indexing.started",
        {
            "kb_id": str(knowledge_base_id),
            "attachment_id": str(attachment_id),
            "document_id": str(document_id),
        },
    )

    # Create a new database session if not provided
    own_session = db is None
    if own_session:
        db = SessionLocal()

    try:
        document = None
        file_extension = None
        source_type = None
        file_size = None

        if document_id is not None:
            from app.models.knowledge import KnowledgeDocument

            document = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .first()
            )
            if document:
                file_extension = document.file_extension
                source_type = document.source_type
                file_size = document.file_size
        elif attachment_id:
            attachment = (
                db.query(SubtaskContext)
                .filter(
                    SubtaskContext.id == attachment_id,
                    SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                )
                .first()
            )
            if attachment:
                file_extension = attachment.file_extension
                file_size = attachment.file_size

        skip_reason = get_rag_indexing_skip_reason(
            source_type, file_extension, file_size
        )
        if skip_reason:
            logger.info(
                f"[Indexing] Skipping: kb_id={knowledge_base_id}, "
                f"document_id={document_id}, attachment_id={attachment_id}, "
                f"reason={skip_reason}"
            )
            add_span_event(
                "rag.indexing.skipped",
                {
                    "kb_id": str(knowledge_base_id),
                    "document_id": str(document_id),
                    "attachment_id": str(attachment_id),
                    "reason": skip_reason,
                },
            )
            return {
                "status": "skipped",
                "reason": skip_reason,
                "document_id": document_id,
                "knowledge_base_id": knowledge_base_id,
                "indexed_count": 0,
                "index_name": None,
            }

        # Resolve KB index info (use pre-computed or fetch from DB)
        kb_info = resolve_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
            kb_index_info=kb_index_info,
        )
        add_span_event(
            "rag.indexing.kb_info.resolved",
            {
                "kb_id": str(knowledge_base_id),
                "index_owner_user_id": str(kb_info.index_owner_user_id),
                "summary_enabled": str(kb_info.summary_enabled),
            },
        )

        runtime_spec = runtime_resolver.build_index_runtime_spec(
            db=db,
            knowledge_base_id=knowledge_base_id,
            attachment_id=attachment_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            user_id=user_id,
            user_name=user_name,
            document_id=document_id,
            splitter_config_dict=_serialize_splitter_config(
                splitter_config=splitter_config,
                splitter_config_dict=splitter_config_dict,
            ),
            kb_index_info=kb_info,
        )

        # Run async indexing code in event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            logger.info(
                f"[Indexing] Starting gateway index_document: kb_id={knowledge_base_id}, "
                f"index_owner_user_id={kb_info.index_owner_user_id}"
            )
            add_span_event(
                "rag.indexing.gateway.index_document.started",
                {
                    "kb_id": str(knowledge_base_id),
                    "index_owner_user_id": str(kb_info.index_owner_user_id),
                    "embedding_model_name": embedding_model_name,
                    "embedding_model_namespace": embedding_model_namespace,
                },
            )
            result = loop.run_until_complete(
                rag_gateway.index_document(runtime_spec, db=db)
            )
            logger.info(
                "[Indexing] gateway index_document returned: status=%s indexed_count=%s index_name=%s",
                result.get("status"),
                result.get("indexed_count"),
                result.get("index_name"),
            )
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

        # Verify indexing result
        indexed_count = result.get("indexed_count", 0)
        index_name = result.get("index_name", "unknown")
        indexing_status = result.get("status", "unknown")

        logger.info(
            f"[Indexing] Completed: kb_id={knowledge_base_id}, "
            f"document_id={document_id}, indexed_count={indexed_count}, "
            f"index_name={index_name}, status={indexing_status}"
        )
        add_span_event(
            "rag.indexing.completed",
            {
                "kb_id": str(knowledge_base_id),
                "document_id": str(document_id),
                "indexed_count": indexed_count,
                "index_name": index_name,
                "status": indexing_status,
            },
        )

        return {
            "status": indexing_status,
            "reason": result.get("reason"),
            "document_id": document_id,
            "knowledge_base_id": knowledge_base_id,
            "indexed_count": indexed_count,
            "index_name": index_name,
            "chunks_data": result.get("chunks_data"),
        }

    except Exception as e:
        logger.error(
            f"[Indexing] FAILED: kb_id={knowledge_base_id}, document_id={document_id}, "
            f"error={str(e)}",
            exc_info=True,
        )
        add_span_event(
            "rag.indexing.failed",
            {
                "kb_id": str(knowledge_base_id),
                "document_id": str(document_id),
                "error": str(e),
            },
        )
        raise

    finally:
        # Close the database session if we created it
        if own_session:
            db.close()
            logger.debug(
                f"[Indexing] Closed database session: kb_id={knowledge_base_id}, "
                f"document_id={document_id}"
            )
