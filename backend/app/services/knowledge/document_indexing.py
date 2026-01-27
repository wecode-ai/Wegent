# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Shared helpers for scheduling and running knowledge document indexing.
"""

import asyncio
import logging
from dataclasses import dataclass
from typing import Optional

from fastapi import BackgroundTasks
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import SessionLocal
from app.schemas.knowledge import DocumentSourceType
from app.schemas.rag import (
    SemanticSplitterConfig,
    SentenceSplitterConfig,
    SplitterConfig,
)
from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.rag.document_service import DocumentService
from app.services.rag.storage.factory import create_storage_backend

logger = logging.getLogger(__name__)


@dataclass
class KnowledgeBaseIndexInfo:
    """Container for knowledge base information needed for background indexing."""

    index_owner_user_id: int
    summary_enabled: bool = False


def build_kb_index_info(knowledge_base, current_user_id: int) -> KnowledgeBaseIndexInfo:
    """Build KB index info from a knowledge base model."""
    spec = knowledge_base.json.get("spec", {})
    summary_enabled = spec.get("summaryEnabled", False)
    if knowledge_base.namespace == "default":
        index_owner_user_id = current_user_id
    else:
        index_owner_user_id = knowledge_base.user_id
    return KnowledgeBaseIndexInfo(
        index_owner_user_id=index_owner_user_id,
        summary_enabled=summary_enabled,
    )


def _get_kb_index_info_sync(
    db: Session, knowledge_base_id: str, current_user_id: int
) -> KnowledgeBaseIndexInfo:
    """
    Get knowledge base info for background indexing.

    For personal knowledge bases (namespace="default"), use the current user's ID.
    For group knowledge bases (namespace!="default"), use the knowledge base creator's ID.
    """
    from app.models.kind import Kind

    try:
        kb_id = int(knowledge_base_id)
    except ValueError:
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

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
        return KnowledgeBaseIndexInfo(
            index_owner_user_id=current_user_id,
            summary_enabled=False,
        )

    spec = (kb.json or {}).get("spec", {})
    summary_enabled = spec.get("summaryEnabled", False)

    if kb.namespace == "default":
        index_owner_user_id = current_user_id
    else:
        index_owner_user_id = kb.user_id

    return KnowledgeBaseIndexInfo(
        index_owner_user_id=index_owner_user_id,
        summary_enabled=summary_enabled,
    )


def _resolve_kb_index_info(
    db: Session,
    knowledge_base_id: str,
    user_id: int,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
) -> KnowledgeBaseIndexInfo:
    """Resolve KB index info, using pre-computed data when available."""
    if kb_index_info:
        logger.info(
            "Using pre-computed KB info: index_owner_user_id=%s, summary_enabled=%s",
            kb_index_info.index_owner_user_id,
            kb_index_info.summary_enabled,
        )
        return kb_index_info

    kb_info = _get_kb_index_info_sync(
        db=db,
        knowledge_base_id=knowledge_base_id,
        current_user_id=user_id,
    )
    logger.info(
        "Fetched KB info from DB: index_owner_user_id=%s, summary_enabled=%s",
        kb_info.index_owner_user_id,
        kb_info.summary_enabled,
    )
    return kb_info


def parse_splitter_config(config_dict: dict) -> Optional[SplitterConfig]:
    """
    Parse a dictionary into the appropriate SplitterConfig type.

    Since SplitterConfig is a Union type (Union[SemanticSplitterConfig, SentenceSplitterConfig]),
    it cannot be instantiated directly.
    """
    if not config_dict:
        return None

    splitter_type = config_dict.get("type")
    if splitter_type == "semantic":
        return SemanticSplitterConfig(**config_dict)
    if splitter_type == "sentence":
        return SentenceSplitterConfig(**config_dict)

    logger.warning(
        "Unknown splitter type '%s', defaulting to sentence splitter",
        splitter_type,
    )
    return SentenceSplitterConfig(**config_dict)


def _trigger_document_summary_if_enabled(
    db: Session,
    document_id: int,
    user_id: int,
    user_name: str,
    kb_info: KnowledgeBaseIndexInfo,
) -> None:
    """Trigger document summary generation if enabled."""
    try:
        global_summary_enabled = getattr(settings, "SUMMARY_ENABLED", False)
        if global_summary_enabled and kb_info.summary_enabled:
            from app.services.knowledge import get_summary_service

            summary_service = get_summary_service(db)
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
            logger.info("Triggered document summary generation for %s", document_id)
        else:
            logger.info(
                "Skipping document summary for %s: summary not enabled "
                "(global=%s, kb=%s)",
                document_id,
                global_summary_enabled,
                kb_info.summary_enabled,
            )
    except Exception as summary_error:
        logger.warning(
            "Failed to trigger document summary for %s: %s",
            document_id,
            summary_error,
        )


def index_document_background(
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    user_name: str,
    splitter_config: Optional[SplitterConfig] = None,
    document_id: Optional[int] = None,
    kb_index_info: Optional[KnowledgeBaseIndexInfo] = None,
) -> None:
    """Background task for RAG document indexing."""
    logger.info(
        "Background task started: indexing document for knowledge base %s, attachment %s",
        knowledge_base_id,
        attachment_id,
    )

    db = SessionLocal()
    try:
        kb_info = _resolve_kb_index_info(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
            kb_index_info=kb_index_info,
        )

        retriever_crd = retriever_kinds_service.get_retriever(
            db=db,
            user_id=user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever_crd:
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        storage_backend = create_storage_backend(retriever_crd)
        doc_service = DocumentService(storage_backend=storage_backend)

        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            result = loop.run_until_complete(
                doc_service.index_document(
                    knowledge_id=knowledge_base_id,
                    embedding_model_name=embedding_model_name,
                    embedding_model_namespace=embedding_model_namespace,
                    user_id=kb_info.index_owner_user_id,
                    db=db,
                    attachment_id=attachment_id,
                    splitter_config=splitter_config,
                    document_id=document_id,
                )
            )
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

        logger.info(
            "Successfully indexed document for knowledge base %s: %s",
            knowledge_base_id,
            result,
        )

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
                db.commit()
                logger.info(
                    "Updated document %s is_active to True and status to enabled",
                    document_id,
                )

                _trigger_document_summary_if_enabled(
                    db=db,
                    document_id=document_id,
                    user_id=user_id,
                    user_name=user_name,
                    kb_info=kb_info,
                )
    except Exception as e:
        logger.error(
            "Failed to index document for knowledge base %s: %s",
            knowledge_base_id,
            str(e),
            exc_info=True,
        )
    finally:
        db.close()
        logger.info(
            "Background task completed for knowledge base %s",
            knowledge_base_id,
        )


def schedule_document_indexing(
    background_tasks: BackgroundTasks,
    knowledge_base,
    attachment_id: int,
    document_id: int,
    current_user_id: int,
    current_user_name: str,
    source_type: DocumentSourceType,
    splitter_config: Optional[SplitterConfig] = None,
) -> bool:
    """Schedule RAG indexing for a document if retrieval is configured."""
    if not knowledge_base:
        return False

    if attachment_id <= 0:
        logger.warning(
            "Document %s has no attachment, skipping RAG indexing",
            document_id,
        )
        return False

    if source_type == DocumentSourceType.TABLE:
        return False

    spec = knowledge_base.json.get("spec", {})
    retrieval_config = spec.get("retrievalConfig")
    if not retrieval_config:
        return False

    retriever_name = retrieval_config.get("retriever_name")
    retriever_namespace = retrieval_config.get("retriever_namespace", "default")
    embedding_config = retrieval_config.get("embedding_config")
    if not retriever_name or not embedding_config:
        logger.warning(
            "Knowledge base %s has incomplete retrieval_config, skipping RAG indexing",
            knowledge_base.id,
        )
        return False

    embedding_model_name = embedding_config.get("model_name")
    embedding_model_namespace = embedding_config.get("model_namespace", "default")
    if not embedding_model_name:
        logger.warning(
            "Knowledge base %s has missing embedding model, skipping RAG indexing",
            knowledge_base.id,
        )
        return False

    kb_index_info = build_kb_index_info(knowledge_base, current_user_id)
    background_tasks.add_task(
        index_document_background,
        knowledge_base_id=str(knowledge_base.id),
        attachment_id=attachment_id,
        retriever_name=retriever_name,
        retriever_namespace=retriever_namespace,
        embedding_model_name=embedding_model_name,
        embedding_model_namespace=embedding_model_namespace,
        user_id=current_user_id,
        user_name=current_user_name,
        splitter_config=splitter_config,
        document_id=document_id,
        kb_index_info=kb_index_info,
    )
    return True
