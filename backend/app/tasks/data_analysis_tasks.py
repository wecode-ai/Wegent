# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Celery tasks for DuckDB data analysis generation.

Handles asynchronous DuckDB generation for Excel/CSV files uploaded
to knowledge bases. These tasks are triggered after successful RAG indexing.
"""

from __future__ import annotations

import hashlib
import logging
from typing import Any

from app.core.celery_app import celery_app
from app.core.config import settings
from app.db.session import SessionLocal
from app.models.duckdb_cache import DuckDBCache
from app.models.subtask_context import SubtaskContext

logger = logging.getLogger(__name__)

# Supported file extensions for DuckDB generation
DUCKDB_SUPPORTED_EXTENSIONS = {".xlsx", ".xls", ".csv"}


@celery_app.task(
    bind=True,
    name="app.tasks.data_analysis_tasks.generate_duckdb",
    max_retries=0,  # No auto-retry; users can re-index to retry
)
def generate_duckdb_task(
    self,
    attachment_id: int,
    user_id: int,
    source_file: str,
    file_extension: str,
) -> dict[str, Any]:
    """Async task for DuckDB generation on KB document upload.

    Generates a .duckdb file from an Excel/CSV attachment via knowledge_runtime,
    then updates the duckdb_cache table and SubtaskContext metadata.

    No automatic retry: if generation fails (e.g., file format issues, timeout),
    the status is set to "failed". Users can re-index the document to retry.

    Args:
        attachment_id: Source attachment ID
        user_id: User ID who owns the attachment
        source_file: Original filename
        file_extension: File extension (e.g., '.xlsx')

    Returns:
        Dict with success status and metadata
    """
    # Check feature flag
    if not settings.DUCKDB_DATA_ANALYSIS_ENABLED:
        return {"success": False, "error": "DuckDB data analysis is disabled"}

    # Check file extension
    if file_extension not in DUCKDB_SUPPORTED_EXTENSIONS:
        return {
            "success": False,
            "error": f"Unsupported file extension: {file_extension}",
        }

    db = SessionLocal()
    try:
        # Check if already generated
        existing = (
            db.query(DuckDBCache)
            .filter(DuckDBCache.attachment_id == attachment_id)
            .first()
        )
        if existing and existing.status == "ready":
            # Source file hash may be empty for legacy entries;
            # in that case we cannot skip, so proceed with generation.
            if existing.source_file_hash:
                logger.info(
                    f"DuckDB already generated for attachment {attachment_id}, "
                    f"skipping (source_file_hash={existing.source_file_hash[:8]}...)"
                )
                return {
                    "success": True,
                    "duckdb_attachment_id": existing.duckdb_attachment_id,
                }
            else:
                logger.info(
                    f"DuckDB exists for attachment {attachment_id} but has no "
                    f"source_file_hash, regenerating for hash tracking"
                )

        # Create or update cache entry with generating status
        existing_hash = existing.source_file_hash if existing else None
        if existing:
            existing.status = "generating"
        else:
            cache_entry = DuckDBCache(
                attachment_id=attachment_id,
                status="generating",
            )
            db.add(cache_entry)
        db.commit()

        # Call knowledge_runtime to generate DuckDB, passing existing hash
        # so it can skip generation if source file has not changed
        result = _call_kr_generate(
            attachment_id=attachment_id,
            user_id=user_id,
            source_file=source_file,
            file_extension=file_extension,
            existing_source_file_hash=existing_hash,
        )

        if result.get("success"):
            # Handle source-unchanged case: file has not changed since last
            # generation, so the existing DuckDB cache is still valid.
            if result.get("source_unchanged"):
                cache_entry = (
                    db.query(DuckDBCache)
                    .filter(DuckDBCache.attachment_id == attachment_id)
                    .first()
                )
                if cache_entry:
                    # Restore ready status - the existing DuckDB is still valid
                    cache_entry.status = "ready"
                    # Update the hash if it was missing (legacy migration)
                    if not cache_entry.source_file_hash:
                        cache_entry.source_file_hash = result.get("source_file_hash")
                    db.commit()

                logger.info(
                    f"DuckDB cache still valid for attachment {attachment_id}, "
                    f"source file unchanged"
                )
                return {
                    "success": True,
                    "duckdb_attachment_id": (
                        cache_entry.duckdb_attachment_id if cache_entry else None
                    ),
                    "source_unchanged": True,
                }

            # Update cache entry
            cache_entry = (
                db.query(DuckDBCache)
                .filter(DuckDBCache.attachment_id == attachment_id)
                .first()
            )
            if cache_entry:
                cache_entry.duckdb_attachment_id = result.get("duckdb_attachment_id")
                cache_entry.summary = result.get("summary")
                cache_entry.tables_count = len(result.get("tables", []))
                cache_entry.file_size = result.get("duckdb_file_size", 0)
                cache_entry.source_file_hash = result.get("source_file_hash")
                cache_entry.status = "ready"
                db.commit()

            # Update SubtaskContext type_data and extracted_text
            context = (
                db.query(SubtaskContext)
                .filter(SubtaskContext.id == attachment_id)
                .first()
            )
            if context:
                type_data = context.type_data or {}
                type_data["duckdb_attachment_id"] = result.get("duckdb_attachment_id")
                type_data["duckdb_summary"] = result.get("summary")
                type_data["duckdb_tables"] = result.get("tables")
                context.type_data = type_data

                # Overwrite extracted_text with DuckDB summary
                from app.services.context.context_service import context_service

                summary_text = context_service.format_duckdb_summary(
                    summary=result.get("summary") or {},
                    tables=result.get("tables") or [],
                    filename=context.name or source_file,
                )
                context.extracted_text = summary_text
                context.text_length = len(summary_text)

                db.commit()

            logger.info(
                f"DuckDB generation succeeded for attachment {attachment_id}: "
                f"duckdb_attachment_id={result.get('duckdb_attachment_id')}"
            )
            return {
                "success": True,
                "duckdb_attachment_id": result.get("duckdb_attachment_id"),
            }
        else:
            # Generation failed
            cache_entry = (
                db.query(DuckDBCache)
                .filter(DuckDBCache.attachment_id == attachment_id)
                .first()
            )
            if cache_entry:
                cache_entry.status = "failed"
                db.commit()

            error = result.get("error", "Unknown error")
            logger.warning(
                f"DuckDB generation failed for attachment {attachment_id}: {error}"
            )

            return {"success": False, "error": error}

    except Exception as e:
        logger.exception(
            f"Error in DuckDB generation task for attachment {attachment_id}: {e}"
        )
        # Update cache entry status to failed
        try:
            cache_entry = (
                db.query(DuckDBCache)
                .filter(DuckDBCache.attachment_id == attachment_id)
                .first()
            )
            if cache_entry:
                cache_entry.status = "failed"
                db.commit()
        except Exception:
            pass

        return {"success": False, "error": str(e)}
    finally:
        db.close()


def _call_kr_generate(
    attachment_id: int,
    user_id: int,
    source_file: str,
    file_extension: str,
    existing_source_file_hash: str | None = None,
) -> dict:
    """Call knowledge_runtime to generate DuckDB from attachment.

    Args:
        attachment_id: Source attachment ID
        user_id: User ID
        source_file: Original filename
        file_extension: File extension
        existing_source_file_hash: Hash of the previously indexed source file,
            used to skip generation if the file has not changed.

    Returns:
        Dict with generation result
    """
    import httpx

    from app.services.auth.rag_download_token import create_rag_download_token
    from shared.models import BackendAttachmentStreamContentRef
    from shared.models.data_analysis_protocol import (
        RemoteDataGenerateRequest,
        RemoteDataGenerateResponse,
    )

    # Build content ref for the source attachment
    auth_token = create_rag_download_token(
        attachment_id=attachment_id,
        expires_delta_seconds=600,  # 10 minutes for async task
    )
    base_url = settings.BACKEND_INTERNAL_URL.rstrip("/")
    content_ref = BackendAttachmentStreamContentRef(
        kind="backend_attachment_stream",
        url=f"{base_url}{settings.API_PREFIX}/internal/rag/content/{attachment_id}",
        auth_token=auth_token,
    )

    request = RemoteDataGenerateRequest(
        attachment_id=attachment_id,
        content_ref=content_ref,
        source_file=source_file,
        file_extension=file_extension,
        existing_source_file_hash=existing_source_file_hash,
    )

    kr_url = (
        getattr(settings, "KNOWLEDGE_RUNTIME_URL", "http://localhost:8200")
        or "http://localhost:8200"
    )
    with httpx.Client(timeout=120) as client:  # 2 minute timeout for async
        response = client.post(
            f"{kr_url}/internal/data/generate",
            json=request.model_dump(mode="json"),
            headers={
                "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}",
                "Content-Type": "application/json",
            },
        )
        response.raise_for_status()
        result = RemoteDataGenerateResponse.model_validate(response.json())
        return result.model_dump()
