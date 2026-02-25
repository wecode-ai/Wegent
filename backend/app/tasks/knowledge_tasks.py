# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for Knowledge Base background operations.

This module provides Celery tasks for:
1. RAG document indexing
2. Document summary generation
3. Knowledge base summary update

These tasks are the unified async mechanism used by both REST API and MCP tools.
"""

import asyncio
import logging
from typing import Optional

from app.core.celery_app import celery_app
from app.core.config import settings
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)


@celery_app.task(
    bind=True,
    name="app.tasks.knowledge_tasks.index_document",
    max_retries=1,
    default_retry_delay=60,
    retry_backoff=True,
    retry_backoff_max=600,
)
def index_document_task(
    self,
    knowledge_base_id: str,
    attachment_id: int,
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    user_id: int,
    user_name: str,
    document_id: Optional[int] = None,
    splitter_config_dict: Optional[dict] = None,
    trigger_summary: bool = True,
):
    """
    Celery task for RAG document indexing.

    This is the unified async task for document indexing, used by both
    REST API and MCP tools.

    Args:
        knowledge_base_id: Knowledge base ID
        attachment_id: Attachment ID
        retriever_name: Retriever name
        retriever_namespace: Retriever namespace
        embedding_model_name: Embedding model name
        embedding_model_namespace: Embedding model namespace
        user_id: User ID
        user_name: Username
        document_id: Document ID
        splitter_config_dict: Optional splitter configuration as dict
        trigger_summary: Whether to trigger document summary after indexing
    """
    logger.info(
        f"[Celery RAG Indexing] Task started: kb_id={knowledge_base_id}, "
        f"attachment_id={attachment_id}, document_id={document_id}"
    )

    try:
        # Import from shared indexing module (avoids circular imports)
        from app.services.knowledge.indexing import run_document_indexing

        result = run_document_indexing(
            knowledge_base_id=knowledge_base_id,
            attachment_id=attachment_id,
            retriever_name=retriever_name,
            retriever_namespace=retriever_namespace,
            embedding_model_name=embedding_model_name,
            embedding_model_namespace=embedding_model_namespace,
            user_id=user_id,
            user_name=user_name,
            splitter_config_dict=splitter_config_dict,
            document_id=document_id,
            trigger_summary=trigger_summary,
        )

        logger.info(
            f"[Celery RAG Indexing] Completed for document {document_id}: {result}"
        )
        return result

    except Exception as e:
        logger.error(
            f"[Celery RAG Indexing] Error indexing document {document_id}: {e}",
            exc_info=True,
        )
        # Retry the task
        raise self.retry(exc=e)


@celery_app.task(
    bind=True,
    name="app.tasks.knowledge_tasks.generate_document_summary",
    max_retries=3,
    default_retry_delay=30,
    retry_backoff=True,
    retry_backoff_max=300,
)
def generate_document_summary_task(
    self,
    document_id: int,
    user_id: int,
    user_name: str,
):
    """
    Celery task for document summary generation.

    Args:
        document_id: Document ID
        user_id: User ID
        user_name: Username
    """
    logger.info(
        f"[Celery Summary] Task started: document_id={document_id}, user_id={user_id}"
    )

    db = SessionLocal()
    try:
        global_summary_enabled = getattr(settings, "SUMMARY_ENABLED", False)
        if not global_summary_enabled:
            logger.info(f"[Celery Summary] Skipping: global summary not enabled")
            return {
                "status": "skipped",
                "reason": "global_summary_disabled",
                "document_id": document_id,
            }

        from app.services.knowledge import get_summary_service

        summary_service = get_summary_service(db)

        # Run async summary code in event loop
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

        logger.info(f"[Celery Summary] Summary generated for document {document_id}")

        return {
            "status": "success",
            "document_id": document_id,
        }

    except Exception as e:
        logger.error(
            f"[Celery Summary] Error generating summary for document {document_id}: {e}",
            exc_info=True,
        )
        raise self.retry(exc=e)

    finally:
        db.close()


@celery_app.task(
    bind=True,
    name="app.tasks.knowledge_tasks.update_kb_summary",
    max_retries=2,
    default_retry_delay=30,
)
def update_kb_summary_task(
    self,
    knowledge_base_id: int,
    user_id: int,
    user_name: str,
):
    """
    Celery task for updating knowledge base summary.

    This is typically triggered after document deletion to update the KB summary.

    Args:
        knowledge_base_id: Knowledge base ID
        user_id: User ID
        user_name: Username
    """
    logger.info(
        f"[Celery KB Summary] Task started: kb_id={knowledge_base_id}, user_id={user_id}"
    )

    db = SessionLocal()
    try:
        global_summary_enabled = getattr(settings, "SUMMARY_ENABLED", False)
        if not global_summary_enabled:
            logger.info(f"[Celery KB Summary] Skipping: global summary not enabled")
            return {
                "status": "skipped",
                "reason": "global_summary_disabled",
                "knowledge_base_id": knowledge_base_id,
            }

        from app.services.knowledge import get_summary_service

        summary_service = get_summary_service(db)

        # Run async summary code in event loop
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(
                summary_service.trigger_kb_summary(
                    knowledge_base_id, user_id, user_name
                )
            )
        finally:
            loop.run_until_complete(loop.shutdown_asyncgens())
            loop.close()

        logger.info(
            f"[Celery KB Summary] Summary updated for knowledge base {knowledge_base_id}"
        )

        return {
            "status": "success",
            "knowledge_base_id": knowledge_base_id,
        }

    except Exception as e:
        logger.error(
            f"[Celery KB Summary] Error updating KB summary {knowledge_base_id}: {e}",
            exc_info=True,
        )
        raise self.retry(exc=e)

    finally:
        db.close()
