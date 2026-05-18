# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""High-level data analysis service orchestrating DuckDB generation.

Provides a unified interface for generating DuckDB files from Excel/CSV data.
Query execution has been moved to the Executor container to keep
knowledge_runtime stateless.
"""

from __future__ import annotations

import hashlib
import logging

from knowledge_runtime.services.artifact_uploader import (
    ArtifactUploader,
    ArtifactUploadError,
)
from knowledge_runtime.services.content_fetcher import ContentFetcher
from knowledge_runtime.services.duckdb_generator import DuckDBGenerator
from shared.models.data_analysis_protocol import (
    RemoteDataGenerateRequest,
    RemoteDataGenerateResponse,
)

logger = logging.getLogger(__name__)


class DataService:
    """High-level data analysis service for DuckDB file generation.

    Coordinates between DuckDBGenerator and ArtifactUploader to generate
    .duckdb files from Excel/CSV attachments and upload them to Backend.

    Query execution is handled by the Executor container, not knowledge_runtime,
    to maintain statelessness and avoid per-node caching issues.
    """

    def __init__(self) -> None:
        self._generator = DuckDBGenerator()
        self._uploader = ArtifactUploader()
        self._content_fetcher = ContentFetcher()

    async def generate_duckdb(
        self, request: RemoteDataGenerateRequest
    ) -> RemoteDataGenerateResponse:
        """Generate a .duckdb file from an Excel/CSV attachment.

        If existing_source_file_hash is provided, the service first computes
        the source file hash and compares it. If they match, generation is
        skipped and a source_unchanged response is returned, avoiding
        redundant DuckDB regeneration when the file content has not changed.

        Steps:
        1. (Optional) Fetch source file and compute hash for change detection
        2. Generate .duckdb from source file
        3. Upload .duckdb to Backend as a new artifact
        4. Return summary with the new attachment ID

        Args:
            request: Generation request with content_ref and metadata.

        Returns:
            RemoteDataGenerateResponse with generation results or error.
        """
        try:
            # Determine source file metadata
            source_file = request.source_file or "data"
            file_extension = request.file_extension or ""

            # Step 1: If existing hash provided, check if source has changed
            if request.existing_source_file_hash:
                try:
                    binary_data, _, _ = await self._content_fetcher.fetch(
                        request.content_ref
                    )
                    new_hash = hashlib.sha256(binary_data).hexdigest()

                    if new_hash == request.existing_source_file_hash:
                        logger.info(
                            "Source file unchanged for attachment_id=%d, "
                            "skipping DuckDB regeneration",
                            request.attachment_id,
                        )
                        return RemoteDataGenerateResponse(
                            success=True,
                            attachment_id=request.attachment_id,
                            source_file_hash=new_hash,
                            source_unchanged=True,
                        )
                except Exception as exc:
                    # If hash pre-check fails, proceed with full generation
                    logger.warning(
                        "Failed to compute source hash for attachment_id=%d, "
                        "proceeding with generation: %s",
                        request.attachment_id,
                        exc,
                    )

            # Step 2: Generate DuckDB file
            result = await self._generator.generate(
                content_ref=request.content_ref,
                source_file=source_file,
                file_extension=file_extension,
            )

            # Step 3: Upload to Backend
            duckdb_attachment_id: int | None = None
            try:
                duckdb_filename = f"{source_file}.duckdb"
                duckdb_attachment_id = await self._uploader.upload(
                    duckdb_bytes=result.duckdb_bytes,
                    filename=duckdb_filename,
                    source_attachment_id=request.attachment_id,
                )
            except ArtifactUploadError as exc:
                logger.error(
                    "Failed to upload DuckDB artifact for attachment_id=%d: %s",
                    request.attachment_id,
                    exc,
                )
                # Continue without the attachment ID - the generation succeeded
                # but the upload failed. The caller can retry the upload later.

            # Step 4: Return response
            # Use the source file hash computed by the generator (hash of the
            # original Excel/CSV bytes), NOT the generated DuckDB file hash.
            # This allows the Backend to detect whether the source file has
            # changed on re-index and skip redundant DuckDB regeneration.
            source_hash = result.source_file_hash

            return RemoteDataGenerateResponse(
                success=True,
                attachment_id=request.attachment_id,
                duckdb_attachment_id=duckdb_attachment_id,
                summary=result.summary,
                tables=result.tables,
                generation_time_ms=result.generation_time_ms,
                duckdb_file_size=len(result.duckdb_bytes),
                source_file_hash=source_hash,
            )

        except ValueError as exc:
            logger.warning(
                "Validation error generating DuckDB for attachment_id=%d: %s",
                request.attachment_id,
                exc,
            )
            return RemoteDataGenerateResponse(
                success=False,
                attachment_id=request.attachment_id,
                error=str(exc),
            )
        except Exception as exc:
            logger.error(
                "Failed to generate DuckDB for attachment_id=%d: %s",
                request.attachment_id,
                exc,
            )
            return RemoteDataGenerateResponse(
                success=False,
                attachment_id=request.attachment_id,
                error=f"DuckDB generation failed: {exc}",
            )
