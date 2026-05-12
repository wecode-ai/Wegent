# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data analysis endpoints for DuckDB operations.

Provides REST API endpoints for generating DuckDB files from Excel/CSV
attachments, executing SQL queries, and retrieving schema information.
"""

from __future__ import annotations

from fastapi import APIRouter

from knowledge_runtime.services.data_service import DataService
from shared.models.data_analysis_protocol import (
    RemoteDataGenerateRequest,
    RemoteDataGenerateResponse,
    RemoteDataQueryRequest,
    RemoteDataQueryResponse,
    RemoteDataSchemaRequest,
    RemoteDataSchemaResponse,
)

router = APIRouter()
_data_service = DataService()


@router.post("/generate", response_model=RemoteDataGenerateResponse)
async def generate_duckdb(
    request: RemoteDataGenerateRequest,
) -> RemoteDataGenerateResponse:
    """Generate a .duckdb file from an Excel/CSV attachment.

    Fetches the source file via content_ref, imports it into DuckDB,
    runs SUMMARIZE analysis, uploads the resulting .duckdb file to Backend,
    and returns the summary with table metadata.
    """
    return await _data_service.generate_duckdb(request)


@router.post("/query", response_model=RemoteDataQueryResponse)
async def query_duckdb(
    request: RemoteDataQueryRequest,
) -> RemoteDataQueryResponse:
    """Execute a SQL query against a DuckDB attachment.

    Runs the query in :memory: + ATTACH read-only mode with security
    validation, timeout enforcement, and result size limiting.
    """
    return await _data_service.query_duckdb(request)


@router.post("/schema", response_model=RemoteDataSchemaResponse)
async def get_schema(
    request: RemoteDataSchemaRequest,
) -> RemoteDataSchemaResponse:
    """Get schema information for a DuckDB attachment.

    Returns table names, row counts, and column metadata (name, type,
    null_count) for all tables in the DuckDB file.
    """
    return await _data_service.get_schema(request)
