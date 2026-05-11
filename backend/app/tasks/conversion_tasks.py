# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Celery tasks for document format conversion.

Converts documents (PDF, PPTX, etc.) to Markdown format before RAG indexing.
Runs on dedicated conversion workers via a separate queue, isolated from the main worker.

Conversion worker startup:
    uv run celery -A app.core.celery_app worker \\
        --queues=knowledge_conversion \\
        --concurrency=2

The main worker does NOT consume this queue because task_routes directs
conversion tasks to the knowledge_conversion queue.
"""

import logging
import os
from typing import Optional

from app.core.celery_app import celery_app
from app.core.config import settings
from app.core.distributed_lock import distributed_lock
from app.db.session import SessionLocal

logger = logging.getLogger(__name__)

CONVERSION_LOCK_TIMEOUT = settings.KNOWLEDGE_CONVERSION_LOCK_TIMEOUT_SECONDS
CONVERSION_LOCK_EXTEND = settings.KNOWLEDGE_CONVERSION_LOCK_EXTEND_INTERVAL_SECONDS
CONVERSION_RETRY_DELAY = settings.KNOWLEDGE_CONVERSION_LOCK_RETRY_DELAY_SECONDS


def _build_mineru_config():
    """Build MinerUConfig from application settings."""
    from knowledge_engine.conversion import MinerUConfig

    return MinerUConfig(
        api_base_url=settings.MINERU_API_BASE_URL,
        backend=settings.MINERU_BACKEND,
        parse_method=settings.MINERU_PARSE_METHOD,
        lang_list=settings.MINERU_LANG_LIST,
        formula_enable=settings.MINERU_FORMULA_ENABLE,
        table_enable=settings.MINERU_TABLE_ENABLE,
        poll_interval_seconds=settings.MINERU_POLL_INTERVAL_SECONDS,
        max_wait_seconds=settings.MINERU_MAX_WAIT_SECONDS,
    )


def _build_s3_config():
    """Build S3Config from application settings."""
    from knowledge_engine.conversion import S3Config

    return S3Config(
        enabled=settings.WORKER_CONVERSION_S3_ENABLED,
        endpoint=settings.WORKER_CONVERSION_S3_ENDPOINT,
        access_key=settings.WORKER_CONVERSION_S3_ACCESS_KEY,
        secret_key=settings.WORKER_CONVERSION_S3_SECRET_KEY,
        bucket_name=settings.WORKER_CONVERSION_S3_BUCKET_NAME,
        region_name=settings.WORKER_CONVERSION_S3_REGION_NAME,
    )


@celery_app.task(
    bind=True,
    name="app.tasks.conversion_tasks.convert_document",
    queue=settings.KNOWLEDGE_CONVERSION_QUEUE,
    max_retries=settings.KNOWLEDGE_CONVERSION_LOCK_MAX_RETRIES,
    default_retry_delay=CONVERSION_RETRY_DELAY,
    soft_time_limit=9000,  # 150 minutes
    time_limit=10000,  # ~167 minutes
)
def convert_document_task(
    self,
    document_id: int,
    attachment_id: int,
    knowledge_base_id: str,
    knowledge_base_name: str,
    index_generation: int,
    user_id: int,
    user_name: str,
    file_extension: str,
    original_filename: str,
    # Pass-through parameters for index_document_task
    retriever_name: str,
    retriever_namespace: str,
    embedding_model_name: str,
    embedding_model_namespace: str,
    splitter_config_dict: Optional[dict] = None,
    trigger_summary: bool = True,
):
    """
    Convert a document to Markdown and dispatch indexing.

    State machine flow:
        QUEUED -> CONVERTING -> (overwrite attachment) -> QUEUED -> index_document_task
    """
    from app.services.knowledge.index_state_machine import (
        mark_document_conversion_started,
        mark_document_conversion_succeeded,
        mark_document_index_failed,
    )

    task_id = getattr(self.request, "id", "unknown")
    retry_count = getattr(self.request, "retries", 0)
    worker_hostname = getattr(self.request, "hostname", "unknown")

    logger.info(
        f"[Conversion] Task started: task_id={task_id}, "
        f"worker={worker_hostname}, retry={retry_count}/{self.max_retries}, "
        f"document_id={document_id}, file_ext={file_extension}, "
        f"index_generation={index_generation}"
    )

    # Acquire distributed lock
    lock_name = f"knowledge:convert_document:{document_id}"
    with distributed_lock.acquire_watchdog_context(
        lock_name,
        expire_seconds=CONVERSION_LOCK_TIMEOUT,
        extend_interval_seconds=CONVERSION_LOCK_EXTEND,
    ) as acquired:
        if not acquired:
            if retry_count < self.max_retries:
                logger.warning(
                    f"[Conversion] Lock held, retry: task_id={task_id}, "
                    f"document_id={document_id}, retry={retry_count + 1}"
                )
                raise self.retry(
                    exc=RuntimeError(f"conversion_lock_held:{document_id}"),
                    countdown=CONVERSION_RETRY_DELAY,
                )
            # All retries exhausted - mark as failed so the user gets feedback
            with SessionLocal() as db:
                from app.services.knowledge.index_state_machine import (
                    mark_document_index_failed,
                )

                mark_document_index_failed(
                    db=db, document_id=document_id, generation=index_generation
                )
            logger.error(
                f"[Conversion] Lock retry exhausted, marking failed: "
                f"document_id={document_id}"
            )
            return {
                "status": "skipped",
                "reason": "lock_retry_exhausted",
                "document_id": document_id,
            }

        # State: QUEUED -> CONVERTING
        with SessionLocal() as db:
            decision = mark_document_conversion_started(
                db=db, document_id=document_id, generation=index_generation
            )
        if not decision.should_execute:
            logger.info(
                f"[Conversion] Skipped: document_id={document_id}, reason={decision.reason}"
            )
            return {"status": "skipped", "reason": decision.reason}

        try:
            # Load attachment binary
            from app.models.subtask_context import ContextType, SubtaskContext
            from app.services.context.context_service import context_service

            with SessionLocal() as db:
                context = (
                    db.query(SubtaskContext)
                    .filter(
                        SubtaskContext.id == attachment_id,
                        SubtaskContext.context_type == ContextType.ATTACHMENT.value,
                        SubtaskContext.user_id == user_id,
                    )
                    .first()
                )
                if not context:
                    raise ValueError(f"Attachment {attachment_id} not found")
                binary_data = context_service.get_attachment_binary_data(
                    db=db, context=context
                )
                if binary_data is None:
                    raise ValueError(f"Attachment {attachment_id} has no binary data")

            logger.info(
                f"[Conversion] Loaded binary: attachment_id={attachment_id}, "
                f"size={len(binary_data)}"
            )

            # Convert using knowledge_engine conversion module
            from knowledge_engine.conversion import convert_document

            mineru_config = _build_mineru_config()
            s3_config = _build_s3_config()
            filename_without_ext = os.path.splitext(original_filename)[0]
            # Sanitize path components to prevent S3 path traversal
            safe_kb_name = (
                knowledge_base_name.replace("..", "").replace("\\", "/").strip("/")
            )
            safe_filename = (
                filename_without_ext.replace("..", "").replace("\\", "/").strip("/")
            )
            s3_base_path = f"{safe_kb_name}/{safe_filename}"

            result = convert_document(
                binary_data=binary_data,
                file_extension=file_extension,
                mineru_config=mineru_config,
                s3_config=s3_config,
                s3_base_path=s3_base_path,
            )

            logger.info(
                f"[Conversion] Done: document_id={document_id}, "
                f"md_size={len(result.markdown_bytes)}, "
                f"images={len(result.uploaded_images)}"
            )

            # State: CONVERTING -> QUEUED (check staleness BEFORE overwriting attachment)
            md_filename = f"{filename_without_ext}.md"
            with SessionLocal() as db:
                succeeded = mark_document_conversion_succeeded(
                    db=db,
                    document_id=document_id,
                    generation=index_generation,
                    converted_extension="md",
                    converted_name=md_filename,
                    converted_file_size=len(result.markdown_bytes),
                )
            if not succeeded:
                return {"status": "skipped", "reason": "stale_conversion"}

            # Overwrite attachment with Markdown (only after staleness check passes)
            with SessionLocal() as db:
                context_service.overwrite_attachment(
                    db=db,
                    context_id=attachment_id,
                    user_id=user_id,
                    filename=md_filename,
                    binary_data=result.markdown_bytes,
                )

            # Dispatch indexing task
            from app.tasks.knowledge_tasks import index_document_task

            async_result = index_document_task.delay(
                knowledge_base_id=knowledge_base_id,
                attachment_id=attachment_id,
                retriever_name=retriever_name,
                retriever_namespace=retriever_namespace,
                embedding_model_name=embedding_model_name,
                embedding_model_namespace=embedding_model_namespace,
                user_id=user_id,
                user_name=user_name,
                document_id=document_id,
                index_generation=index_generation,
                splitter_config_dict=splitter_config_dict,
                trigger_summary=trigger_summary,
            )

            logger.info(
                f"[Conversion] Indexing dispatched: document_id={document_id}, "
                f"index_task_id={async_result.id}"
            )
            return {
                "status": "converted",
                "document_id": document_id,
                "index_task_id": async_result.id,
            }

        except Exception as exc:
            with SessionLocal() as db:
                mark_document_index_failed(
                    db=db, document_id=document_id, generation=index_generation
                )
            logger.error(
                f"[Conversion] Error: document_id={document_id}, error={exc}",
                exc_info=True,
            )
            raise
