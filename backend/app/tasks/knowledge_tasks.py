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
from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

KNOWLEDGE_INDEX_LOCK_TIMEOUT_SECONDS = settings.KNOWLEDGE_INDEX_LOCK_TIMEOUT_SECONDS
KNOWLEDGE_INDEX_LOCK_EXTEND_INTERVAL_SECONDS = (
    settings.KNOWLEDGE_INDEX_LOCK_EXTEND_INTERVAL_SECONDS
)
KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS = (
    settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS
)


def _enqueue_document_summary_task(
    *,
    document_id: int,
    user_id: int,
    user_name: str,
) -> None:
    """Enqueue document summary generation without blocking the indexing task."""
    try:
        generate_document_summary_task.delay(
            document_id=document_id,
            user_id=user_id,
            user_name=user_name,
        )
        logger.info(
            f"[Celery RAG Indexing] Enqueued document summary task: "
            f"document_id={document_id}, user_id={user_id}"
        )
    except Exception as exc:
        logger.warning(
            f"[Celery RAG Indexing] Failed to enqueue document summary task for "
            f"document {document_id}: {exc}",
            exc_info=True,
        )


@celery_app.task(
    bind=True,
    name="app.tasks.knowledge_tasks.index_document",
    max_retries=settings.KNOWLEDGE_INDEX_LOCK_MAX_RETRIES,
    default_retry_delay=settings.KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS,
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
    index_generation: int = 0,
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
        index_generation: Business generation for stale-task protection
        splitter_config_dict: Optional splitter configuration as dict
        trigger_summary: Whether to trigger document summary after indexing
    """
    from app.services.knowledge.index_state_machine import (
        get_document_index_lock_name,
        mark_document_index_failed,
        mark_document_index_started,
        mark_document_index_succeeded,
    )
    from app.services.knowledge.indexing import (
        get_kb_index_info,
        run_document_indexing,
    )

    task_id = getattr(self.request, "id", "unknown")
    retry_count = getattr(self.request, "retries", 0)
    worker_hostname = getattr(self.request, "hostname", "unknown")

    logger.info(
        f"[Celery RAG Indexing] Task started: task_id={task_id}, "
        f"worker={worker_hostname}, retry={retry_count}/{self.max_retries}, "
        f"kb_id={knowledge_base_id}, attachment_id={attachment_id}, "
        f"document_id={document_id}, index_generation={index_generation}, "
        f"trigger_summary={trigger_summary}"
    )

    if document_id is None:
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
            f"[Celery RAG Indexing] Completed without document guard: task_id={task_id}, "
            f"attachment_id={attachment_id}, result={result}"
        )
        return result

    lock_name = get_document_index_lock_name(document_id)
    with distributed_lock.acquire_watchdog_context(
        lock_name,
        expire_seconds=KNOWLEDGE_INDEX_LOCK_TIMEOUT_SECONDS,
        extend_interval_seconds=KNOWLEDGE_INDEX_LOCK_EXTEND_INTERVAL_SECONDS,
    ) as acquired:
        if not acquired:
            if retry_count < self.max_retries:
                logger.warning(
                    f"[Celery RAG Indexing] Lock held, scheduling retry: "
                    f"task_id={task_id}, document_id={document_id}, "
                    f"index_generation={index_generation}, retry={retry_count + 1}/{self.max_retries}, "
                    f"countdown={KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS}s"
                )
                raise self.retry(
                    exc=RuntimeError(
                        f"knowledge_index_lock_held:{document_id}:{index_generation}"
                    ),
                    countdown=KNOWLEDGE_INDEX_LOCK_RETRY_DELAY_SECONDS,
                )

            logger.warning(
                f"[Celery RAG Indexing] Task skipped after lock retry exhaustion: "
                f"task_id={task_id}, document_id={document_id}, "
                f"index_generation={index_generation}, retries={retry_count}"
            )
            logger.info(
                f"[Celery RAG Indexing] Task skipped: task_id={task_id}, "
                f"document_id={document_id}, reason=lock_retry_exhausted"
            )
            return {
                "status": "skipped",
                "reason": "lock_retry_exhausted",
                "document_id": document_id,
                "knowledge_base_id": knowledge_base_id,
                "index_generation": index_generation,
            }

        with SessionLocal() as state_db:
            start_decision = mark_document_index_started(
                db=state_db,
                document_id=document_id,
                generation=index_generation,
            )

        if not start_decision.should_execute:
            logger.info(
                f"[Celery RAG Indexing] Task skipped: task_id={task_id}, "
                f"document_id={document_id}, attachment_id={attachment_id}, "
                f"index_generation={index_generation}, reason={start_decision.reason}"
            )
            return {
                "status": "skipped",
                "reason": start_decision.reason,
                "document_id": document_id,
                "knowledge_base_id": knowledge_base_id,
                "index_generation": index_generation,
            }

        try:
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

            if result.get("status") == "skipped":
                with SessionLocal() as finalize_db:
                    finalized = mark_document_index_failed(
                        db=finalize_db,
                        document_id=document_id,
                        generation=index_generation,
                    )

                if not finalized:
                    logger.info(
                        f"[Celery RAG Indexing] Task skip result was ignored after supersession: "
                        f"task_id={task_id}, document_id={document_id}, "
                        f"index_generation={index_generation}, reason={result.get('reason')}"
                    )
                    return {
                        "status": "skipped",
                        "reason": "stale_skip_result",
                        "document_id": document_id,
                        "knowledge_base_id": knowledge_base_id,
                        "index_generation": index_generation,
                    }

                logger.info(
                    f"[Celery RAG Indexing] Task finished with skip result and was marked failed: "
                    f"task_id={task_id}, document_id={document_id}, "
                    f"index_generation={index_generation}, reason={result.get('reason')}"
                )
                result["index_generation"] = index_generation
                return result

            with SessionLocal() as finalize_db:
                finalized = mark_document_index_succeeded(
                    db=finalize_db,
                    document_id=document_id,
                    generation=index_generation,
                    chunks=result.get("chunks_data"),
                    chunk_storage_enabled=settings.CHUNK_STORAGE_ENABLED,
                )

            if not finalized:
                logger.info(
                    f"[Celery RAG Indexing] Task completed but finalization was skipped: "
                    f"task_id={task_id}, document_id={document_id}, "
                    f"index_generation={index_generation}, reason=stale_or_already_finalized"
                )
                return {
                    "status": "skipped",
                    "reason": "stale_or_already_finalized",
                    "document_id": document_id,
                    "knowledge_base_id": knowledge_base_id,
                    "index_generation": index_generation,
                }

            if trigger_summary:
                try:
                    with SessionLocal() as summary_db:
                        kb_info = get_kb_index_info(
                            db=summary_db,
                            knowledge_base_id=knowledge_base_id,
                            current_user_id=user_id,
                        )
                    if settings.SUMMARY_ENABLED and kb_info.summary_enabled:
                        _enqueue_document_summary_task(
                            document_id=document_id,
                            user_id=user_id,
                            user_name=user_name,
                        )
                except Exception as summary_error:
                    logger.warning(
                        f"[Celery RAG Indexing] Failed to prepare document summary "
                        f"for document {document_id}: {summary_error}",
                        exc_info=True,
                    )

            logger.info(
                f"[Celery RAG Indexing] Completed: task_id={task_id}, "
                f"document_id={document_id}, attachment_id={attachment_id}, "
                f"index_generation={index_generation}, result={result}"
            )
            result["index_generation"] = index_generation
            return result

        except Exception as exc:
            with SessionLocal() as finalize_db:
                finalized = mark_document_index_failed(
                    db=finalize_db,
                    document_id=document_id,
                    generation=index_generation,
                )

            if not finalized:
                logger.warning(
                    f"[Celery RAG Indexing] Task failed after being superseded: "
                    f"task_id={task_id}, document_id={document_id}, "
                    f"index_generation={index_generation}, error={exc}",
                    exc_info=True,
                )
                return {
                    "status": "skipped",
                    "reason": "stale_failure",
                    "document_id": document_id,
                    "knowledge_base_id": knowledge_base_id,
                    "index_generation": index_generation,
                }

            logger.error(
                f"[Celery RAG Indexing] Error: task_id={task_id}, "
                f"document_id={document_id}, attachment_id={attachment_id}, "
                f"index_generation={index_generation}, error={exc}",
                exc_info=True,
            )
            raise


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
