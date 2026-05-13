"""
Celery task for document format conversion.

Converts documents (PDF, PPTX, etc.) to Markdown format before RAG indexing.
Runs as a standalone Celery worker consuming the knowledge_conversion queue.
Communicates with backend via HTTP callbacks instead of direct DB access.

Converter worker startup:
    uv run celery -A knowledge_doc_converter.celery_app worker \\
        --queues=knowledge_conversion \\
        --concurrency=2
"""

import logging
import os
import time

from knowledge_doc_converter.celery_app import celery_app
from knowledge_doc_converter.config import settings
from knowledge_doc_converter.core.metrics import (
    record_conversion_failed,
    record_conversion_skipped,
    record_conversion_started,
    record_conversion_succeeded,
    record_lock_acquired,
    record_lock_exhausted,
    record_lock_retry,
)
from knowledge_doc_converter.services.callback_client import callback_client
from knowledge_doc_converter.services.content_fetcher import content_fetcher
from knowledge_doc_converter.services.lock_service import lock_service

logger = logging.getLogger(__name__)


from knowledge_engine.conversion import MinerUConfig, S3Config


def _build_mineru_config() -> MinerUConfig:
    """Build MinerUConfig from service settings."""
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


def _build_s3_config() -> S3Config:
    """Build S3Config from service settings."""
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
    name="knowledge_doc_converter.convert_document",
    queue=settings.KNOWLEDGE_CONVERSION_QUEUE,
    max_retries=settings.KNOWLEDGE_CONVERSION_LOCK_MAX_RETRIES,
    default_retry_delay=settings.KNOWLEDGE_CONVERSION_LOCK_RETRY_DELAY_SECONDS,
    soft_time_limit=settings.CONVERSION_TASK_SOFT_TIME_LIMIT,
    time_limit=settings.CONVERSION_TASK_TIME_LIMIT,
)
def convert_document_task(
    self,
    document_id: int,
    attachment_id: int,
    file_extension: str,
    original_filename: str,
    knowledge_base_name: str,
    index_generation: int,
    content_download_path: str,
    callback_status_path: str,
    callback_completed_path: str,
    index_dispatch_payload: dict,
) -> dict:
    """
    Convert a document to Markdown and notify backend via callbacks.

    Flow:
        1. Acquire distributed lock
        2. Callback: conversion_started
        3. Fetch binary content from backend
        4. Convert using knowledge_engine
        5. Callback: conversion_completed (with markdown bytes)
    On exception:
        6. Callback: conversion_failed
    """
    task_id = getattr(self.request, "id", "unknown")
    retry_count = getattr(self.request, "retries", 0)
    worker_hostname = getattr(self.request, "hostname", "unknown")

    logger.info(
        f"[Conversion] Task started: task_id={task_id}, "
        f"worker={worker_hostname}, retry={retry_count}/{self.max_retries}, "
        f"document_id={document_id}, file_ext={file_extension}, "
        f"index_generation={index_generation}"
    )

    start_time = time.monotonic()
    record_conversion_started()

    # Acquire distributed lock
    lock_name = f"knowledge:convert_document:{document_id}"
    with lock_service.acquire_watchdog_context(
        lock_name,
        expire_seconds=settings.KNOWLEDGE_CONVERSION_LOCK_TIMEOUT_SECONDS,
        extend_interval_seconds=settings.KNOWLEDGE_CONVERSION_LOCK_EXTEND_INTERVAL_SECONDS,
    ) as acquired:
        if not acquired:
            if retry_count < self.max_retries:
                record_lock_retry()
                logger.warning(
                    f"[Conversion] Lock held, retry: task_id={task_id}, "
                    f"document_id={document_id}, retry={retry_count + 1}"
                )
                raise self.retry(
                    exc=RuntimeError(f"conversion_lock_held:{document_id}"),
                    countdown=settings.KNOWLEDGE_CONVERSION_LOCK_RETRY_DELAY_SECONDS,
                )
            # All retries exhausted - notify backend
            record_lock_exhausted()
            record_conversion_skipped("lock_retry_exhausted")
            try:
                callback_client.notify_failed(
                    path=callback_status_path,
                    document_id=document_id,
                    generation=index_generation,
                    error_message="Lock retry exhausted",
                )
            except Exception as callback_err:
                logger.error(
                    f"[Conversion] Failed to notify lock retry exhaustion: "
                    f"{callback_err}"
                )
            logger.error(
                f"[Conversion] Lock retry exhausted: document_id={document_id}"
            )
            return {
                "status": "skipped",
                "reason": "lock_retry_exhausted",
                "document_id": document_id,
            }

        record_lock_acquired()

        # Step 1: Notify conversion started (replaces direct DB call)
        try:
            resp = callback_client.notify_started(
                path=callback_status_path,
                document_id=document_id,
                generation=index_generation,
            )
            if not resp.get("ok") or not resp.get("document_exists"):
                logger.info(
                    f"[Conversion] Skipped: document_id={document_id}, " f"resp={resp}"
                )
                record_conversion_skipped("not_exists_or_stale")
                return {"status": "skipped", "reason": "not_exists_or_stale"}
        except Exception as e:
            # Log but do NOT abort — the conversion itself can still proceed.
            # If notify_started fails (transient backend outage), the document
            # status stays at pending_conversion. When notify_completed succeeds
            # later, the backend state machine still handles the transition
            # correctly (mark_document_conversion_started accepts both QUEUED
            # and PENDING_CONVERSION as valid pre-states).
            logger.warning(
                f"[Conversion] Failed to notify started (non-fatal): "
                f"document_id={document_id}, error={e}"
            )

        try:
            # Step 2: Fetch binary content from backend
            binary_data = content_fetcher.download(content_download_path)
            logger.info(
                f"[Conversion] Loaded binary: attachment_id={attachment_id}, "
                f"size={len(binary_data)}"
            )

            # Step 3: Convert using knowledge_engine
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
            s3_base_path = f"{safe_kb_name}/{document_id}/{safe_filename}"

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

            # Step 4: Notify conversion completed (backend handles
            # state transition, attachment overwrite, and index dispatch atomically)
            md_filename = f"{filename_without_ext}.md"
            resp = callback_client.notify_completed(
                path=callback_completed_path,
                document_id=document_id,
                generation=index_generation,
                converted_name=md_filename,
                converted_extension="md",
                file_size=len(result.markdown_bytes),
                markdown_bytes=result.markdown_bytes,
                index_dispatch_payload=index_dispatch_payload,
            )

            if resp.get("skipped"):
                logger.info(
                    f"[Conversion] Backend skipped (stale): document_id={document_id}"
                )
                record_conversion_skipped("stale_conversion")
                return {"status": "skipped", "reason": "stale_conversion"}

            if not resp.get("ok"):
                logger.error(
                    f"[Conversion] Backend rejected completion: document_id={document_id}, "
                    f"resp={resp}"
                )
                record_conversion_failed(file_extension, time.monotonic() - start_time)
                return {"status": "error", "reason": "backend_rejected"}

            duration = time.monotonic() - start_time
            record_conversion_succeeded(
                file_extension=file_extension,
                duration_seconds=duration,
                input_size=len(binary_data),
                output_size=len(result.markdown_bytes),
            )
            logger.info(
                f"[Conversion] Completed: document_id={document_id}, "
                f"index_task_id={resp.get('index_task_id')}"
            )
            return {
                "status": "converted",
                "document_id": document_id,
                "index_task_id": resp.get("index_task_id"),
            }

        except Exception as exc:
            # Handle soft timeout separately — still has time to execute cleanup
            from celery.exceptions import SoftTimeLimitExceeded

            if isinstance(exc, SoftTimeLimitExceeded):
                logger.warning(
                    f"[Conversion] Soft timeout: document_id={document_id}, "
                    f"exceeded {settings.CONVERSION_TASK_SOFT_TIME_LIMIT}s"
                )
                record_conversion_failed(
                    file_extension,
                    time.monotonic() - start_time,
                    input_size=0,
                )
                try:
                    callback_client.notify_failed(
                        path=callback_status_path,
                        document_id=document_id,
                        generation=index_generation,
                        error_message=(
                            f"conversion_soft_timeout:"
                            f"{settings.CONVERSION_TASK_SOFT_TIME_LIMIT}s"
                        ),
                    )
                except Exception as callback_err:
                    logger.error(
                        f"[Conversion] Failed to notify soft timeout: "
                        f"{callback_err}"
                    )
                return {
                    "status": "failed",
                    "reason": "soft_timeout",
                    "document_id": document_id,
                }

            logger.error(
                f"[Conversion] Error: document_id={document_id}, error={exc}",
                exc_info=True,
            )
            record_conversion_failed(
                file_extension,
                time.monotonic() - start_time,
                input_size=0,
            )
            # Notify backend of failure
            try:
                resp = callback_client.notify_failed(
                    path=callback_status_path,
                    document_id=document_id,
                    generation=index_generation,
                    error_message=str(exc),
                )
                if not resp.get("document_exists"):
                    logger.info(
                        f"[Conversion] Document {document_id} was deleted during "
                        f"conversion, skipping retry"
                    )
                    record_conversion_skipped("document_deleted")
                    return {"status": "skipped", "reason": "document_deleted"}
            except Exception as callback_err:
                logger.error(f"[Conversion] Failed to notify failure: {callback_err}")
            raise
