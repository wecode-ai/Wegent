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
from app.schemas.rag import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SplitterConfig,
)
from shared.telemetry import add_span_event

logger = logging.getLogger(__name__)


@dataclass
class KnowledgeBaseIndexInfo:
    """Container for knowledge base information needed for background indexing.

    This dataclass holds all KB-related information needed by the background
    indexing task, avoiding redundant database queries in the background task.
    """

    index_owner_user_id: int
    summary_enabled: bool = False


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


def is_organization_namespace(db: Session, namespace: str) -> bool:
    """Check if a namespace is an organization namespace.

    Args:
        db: Database session
        namespace: Namespace to check

    Returns:
        True if this is an organization namespace
    """
    # Import here to avoid circular imports
    from app.services.knowledge.knowledge_service import _is_organization_namespace

    return _is_organization_namespace(db, namespace)


def get_kb_index_info(
    db: Session, knowledge_base_id: str, current_user_id: int
) -> KnowledgeBaseIndexInfo:
    """
    Get knowledge base information needed for indexing in a single query.

    Returns index_owner_user_id and summary_enabled setting in one operation
    to avoid redundant database queries.

    For personal knowledge bases (namespace="default"), use the current user's ID.
    For organization knowledge bases, use the current user's ID.
    For group knowledge bases (namespace!="default"), use the KB creator's ID.

    Args:
        db: Database session
        knowledge_base_id: Knowledge base ID (Kind.id as string)
        current_user_id: Current requesting user's ID

    Returns:
        KnowledgeBaseIndexInfo containing index_owner_user_id and summary_enabled
    """
    try:
        kb_id = int(knowledge_base_id)
    except ValueError:
        # If knowledge_base_id is not a valid integer, return default info
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    # Get the knowledge base (single query for all needed info)
    kb = (
        db.query(Kind)
        .filter(
            Kind.id == kb_id,
            Kind.kind == "KnowledgeBase",
            Kind.is_active == True,
        )
        .first()
    )

    if not kb:
        # Knowledge base not found, return default info
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    # Extract summary_enabled from KB spec
    spec = (kb.json or {}).get("spec", {})
    summary_enabled = spec.get("summaryEnabled", False)

    # Determine index_owner_user_id based on namespace
    if kb.namespace == "default":
        # Personal knowledge base - use current user's ID
        index_owner_user_id = current_user_id
    elif is_organization_namespace(db, kb.namespace):
        # Organization knowledge base - use current user's ID for index naming
        # All users can access organization KBs, so we use the current user's ID
        index_owner_user_id = current_user_id
    else:
        # Group knowledge base - use KB creator's user_id for index naming
        # This ensures all group members access the same index
        index_owner_user_id = kb.user_id

    return KnowledgeBaseIndexInfo(
        index_owner_user_id=index_owner_user_id,
        summary_enabled=summary_enabled,
    )


def resolve_kb_index_info(
    db: Session,
    knowledge_base_id: str,
    user_id: int,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
) -> KnowledgeBaseIndexInfo:
    """
    Resolve knowledge base index information.

    Use pre-computed KB info if provided, otherwise fetch from DB.
    This optimization avoids redundant DB query when called from create_document.

    Args:
        db: Database session
        knowledge_base_id: Knowledge base ID
        user_id: User ID (the user who triggered the indexing)
        kb_index_info: Pre-computed KB info (optional)

    Returns:
        KnowledgeBaseIndexInfo containing index_owner_user_id and summary_enabled
    """
    if kb_index_info:
        logger.debug(
            f"[Indexing] Using pre-computed KB info: index_owner_user_id={kb_index_info.index_owner_user_id}, "
            f"summary_enabled={kb_index_info.summary_enabled}"
        )
        return kb_index_info
    else:
        # Fallback: fetch KB info from database
        kb_info = get_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            current_user_id=user_id,
        )
        logger.debug(
            f"[Indexing] Fetched KB info from DB: index_owner_user_id={kb_info.index_owner_user_id}, "
            f"summary_enabled={kb_info.summary_enabled}"
        )
        return kb_info


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
    from app.schemas.rag import SmartSplitterConfig

    if not config_dict:
        return None

    splitter_type = config_dict.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config_dict)
    elif splitter_type == "sentence":
        return SentenceSplitterConfig(**config_dict)
    elif splitter_type == "smart":
        return SmartSplitterConfig(**config_dict)
    else:
        # Default to sentence splitter if type is not specified or unknown
        logger.warning(
            f"Unknown splitter type '{splitter_type}', defaulting to sentence splitter"
        )
        return SentenceSplitterConfig(**config_dict)


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

    # Pre-compute KB index info
    summary_enabled = spec.get("summaryEnabled", False)
    if knowledge_base.namespace == "default":
        index_owner_user_id = current_user_id
    elif is_organization_namespace(db, knowledge_base.namespace):
        index_owner_user_id = current_user_id
    else:
        # Group KB - use creator's user_id for shared index
        index_owner_user_id = knowledge_base.user_id

    kb_index_info = KnowledgeBaseIndexInfo(
        index_owner_user_id=index_owner_user_id,
        summary_enabled=summary_enabled,
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


def trigger_document_summary_if_enabled(
    db: Session,
    document_id: int,
    user_id: int,
    user_name: str,
    kb_info: KnowledgeBaseIndexInfo,
):
    """
    Trigger document summary generation if enabled.

    Check both global setting and knowledge base setting before triggering.
    Summary generation failure should not affect indexing result.

    Args:
        db: Database session
        document_id: Document ID
        user_id: User ID (the user who triggered the indexing)
        user_name: Username for placeholder resolution
        kb_info: Knowledge base index information
    """
    try:
        global_summary_enabled = getattr(settings, "SUMMARY_ENABLED", False)
        if global_summary_enabled and kb_info.summary_enabled:
            from app.services.knowledge import get_summary_service

            summary_service = get_summary_service(db)
            # Use a dedicated event loop and ensure proper cleanup
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(
                    summary_service.trigger_document_summary(
                        document_id, user_id, user_name
                    )
                )
            finally:
                loop.run_until_complete(loop.shutdown_asyncgens())
                loop.close()
            logger.info(
                f"[Indexing] Triggered document summary generation for document {document_id}"
            )
        else:
            logger.debug(
                f"[Indexing] Skipping document summary for {document_id}: summary not enabled "
                f"(global={global_summary_enabled}, kb={kb_info.summary_enabled})"
            )
    except Exception as summary_error:
        # Summary generation failure should not affect indexing result
        logger.warning(
            f"[Indexing] Failed to trigger document summary for {document_id}: {summary_error}"
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
    from app.services.adapters.retriever_kinds import retriever_kinds_service
    from app.services.rag.document_service import DocumentService
    from app.services.rag.storage import create_storage_backend

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

        # Get retriever from database
        retriever_crd = retriever_kinds_service.get_retriever(
            db=db,
            user_id=user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever_crd:
            logger.error(
                f"[Indexing] Retriever not found: name={retriever_name}, "
                f"namespace={retriever_namespace}"
            )
            add_span_event(
                "rag.indexing.retriever.not_found",
                {
                    "retriever_name": retriever_name,
                    "retriever_namespace": retriever_namespace,
                },
            )
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        logger.info(f"[Indexing] Found retriever: {retriever_name}")
        add_span_event(
            "rag.indexing.retriever.found",
            {
                "retriever_name": retriever_name,
                "retriever_namespace": retriever_namespace,
            },
        )

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever_crd)
        logger.info(
            f"[Indexing] Created storage backend: {type(storage_backend).__name__}"
        )
        add_span_event(
            "rag.indexing.storage_backend.created",
            {
                "backend_type": type(storage_backend).__name__,
            },
        )

        # Create document service
        doc_service = DocumentService(storage_backend=storage_backend)

        # Parse splitter config if dict was provided
        resolved_splitter_config = splitter_config
        if splitter_config_dict and not resolved_splitter_config:
            resolved_splitter_config = parse_splitter_config(splitter_config_dict)

        # Run async indexing code in event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            logger.info(
                f"[Indexing] Starting index_document: kb_id={knowledge_base_id}, "
                f"index_owner_user_id={kb_info.index_owner_user_id}"
            )
            add_span_event(
                "rag.indexing.index_document.started",
                {
                    "kb_id": str(knowledge_base_id),
                    "index_owner_user_id": str(kb_info.index_owner_user_id),
                    "embedding_model_name": embedding_model_name,
                    "embedding_model_namespace": embedding_model_namespace,
                },
            )
            result = loop.run_until_complete(
                doc_service.index_document(
                    knowledge_id=knowledge_base_id,
                    embedding_model_name=embedding_model_name,
                    embedding_model_namespace=embedding_model_namespace,
                    user_id=kb_info.index_owner_user_id,
                    db=db,
                    attachment_id=attachment_id,
                    splitter_config=resolved_splitter_config,
                    document_id=document_id,
                    trace_context=None,
                    user_name=user_name,
                )
            )
            logger.info(f"[Indexing] index_document returned: result={result}")
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

        # Update document status after successful indexing
        if document_id:
            from app.models.knowledge import DocumentStatus, KnowledgeDocument

            doc = (
                db.query(KnowledgeDocument)
                .filter(KnowledgeDocument.id == document_id)
                .first()
            )
            if doc:
                doc.is_active = True
                doc.status = DocumentStatus.ENABLED
                # Save chunk metadata if CHUNK_STORAGE_ENABLED
                if settings.CHUNK_STORAGE_ENABLED:
                    chunks_data = result.get("chunks_data")
                    if chunks_data:
                        doc.chunks = chunks_data
                        logger.info(
                            f"[Indexing] Saved {chunks_data.get('total_count', 0)} chunks metadata "
                            f"for document {document_id}"
                        )
                else:
                    logger.debug(
                        f"[Indexing] Skipping chunk storage for document {document_id} "
                        "(CHUNK_STORAGE_ENABLED=False)"
                    )
                db.commit()
                logger.info(
                    f"[Indexing] Updated document {document_id} status to ENABLED"
                )
                add_span_event(
                    "rag.indexing.document.status_updated",
                    {
                        "document_id": str(document_id),
                        "status": "ENABLED",
                    },
                )

                # Trigger document summary generation if enabled
                if trigger_summary:
                    trigger_document_summary_if_enabled(
                        db=db,
                        document_id=document_id,
                        user_id=user_id,
                        user_name=user_name,
                        kb_info=kb_info,
                    )

        return {
            "status": "success",
            "document_id": document_id,
            "knowledge_base_id": knowledge_base_id,
            "indexed_count": indexed_count,
            "index_name": index_name,
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
