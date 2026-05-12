# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""High-level data analysis service orchestrating DuckDB operations.

Provides a unified interface for generating DuckDB files from Excel/CSV data,
executing SQL queries against existing DuckDB files, and retrieving schema
information. Delegates to specialized services for each operation.
"""

from __future__ import annotations

import hashlib
import logging

from knowledge_runtime.services.artifact_uploader import (
    ArtifactUploader,
    ArtifactUploadError,
)
from knowledge_runtime.services.duckdb_generator import DuckDBGenerator
from knowledge_runtime.services.duckdb_manager import DuckDBManager
from knowledge_runtime.services.duckdb_query import DuckDBQueryService
from shared.models.data_analysis_protocol import (
    RemoteDataGenerateRequest,
    RemoteDataGenerateResponse,
    RemoteDataQueryRequest,
    RemoteDataQueryResponse,
    RemoteDataSchemaRequest,
    RemoteDataSchemaResponse,
)

logger = logging.getLogger(__name__)


class DataService:
    """High-level data analysis service orchestrating DuckDB operations.

    Coordinates between DuckDBGenerator, DuckDBManager, DuckDBQueryService,
    and ArtifactUploader to provide a unified data analysis API.
    """

    def __init__(self) -> None:
        self._generator = DuckDBGenerator()
        self._manager = DuckDBManager()
        self._query_service = DuckDBQueryService(self._manager)
        self._uploader = ArtifactUploader()

    async def generate_duckdb(
        self, request: RemoteDataGenerateRequest
    ) -> RemoteDataGenerateResponse:
        """Generate a .duckdb file from an Excel/CSV attachment.

        Steps:
        1. Generate .duckdb from source file
        2. Upload .duckdb to Backend as a new artifact
        3. Return summary with the new attachment ID

        Args:
            request: Generation request with content_ref and metadata.

        Returns:
            RemoteDataGenerateResponse with generation results or error.
        """
        try:
            # Determine source file metadata
            source_file = request.source_file or "data"
            file_extension = request.file_extension or ""

            # Step 1: Generate DuckDB file
            result = await self._generator.generate(
                content_ref=request.content_ref,
                source_file=source_file,
                file_extension=file_extension,
            )

            # Step 2: Upload to Backend
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

            # Step 3: Return response
            # Compute SHA256 hash of the source file for integrity verification
            source_hash = hashlib.sha256(result.duckdb_bytes).hexdigest()

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

    async def query_duckdb(
        self, request: RemoteDataQueryRequest
    ) -> RemoteDataQueryResponse:
        """Execute SQL query against a DuckDB attachment.

        Args:
            request: Query request with SQL and attachment reference.

        Returns:
            RemoteDataQueryResponse with query results or error.
        """
        try:
            result = await self._query_service.query(
                attachment_id=request.attachment_id,
                content_ref=request.content_ref,
                sql=request.sql,
                max_rows=request.max_rows,
            )

            return RemoteDataQueryResponse(
                success=result.error is None,
                columns=result.columns,
                rows=result.rows,
                row_count=result.row_count,
                total_count=result.total_count,
                execution_time_ms=result.execution_time_ms,
                truncated=result.truncated,
                error=result.error,
            )

        except Exception as exc:
            logger.error(
                "Query execution failed for attachment_id=%d: %s",
                request.attachment_id,
                exc,
            )
            return RemoteDataQueryResponse(
                success=False,
                error=f"Query execution failed: {exc}",
            )

    async def get_schema(
        self, request: RemoteDataSchemaRequest
    ) -> RemoteDataSchemaResponse:
        """Get schema information for a DuckDB attachment.

        Args:
            request: Schema request with attachment reference.

        Returns:
            RemoteDataSchemaResponse with table and column metadata.
        """
        try:
            result = await self._query_service.get_schema(
                attachment_id=request.attachment_id,
                content_ref=request.content_ref,
            )

            return RemoteDataSchemaResponse(
                attachment_id=request.attachment_id,
                tables=result.tables,
                error=result.error,
            )

        except Exception as exc:
            logger.error(
                "Schema extraction failed for attachment_id=%d: %s",
                request.attachment_id,
                exc,
            )
            return RemoteDataSchemaResponse(
                attachment_id=request.attachment_id,
                error=f"Schema extraction failed: {exc}",
            )
