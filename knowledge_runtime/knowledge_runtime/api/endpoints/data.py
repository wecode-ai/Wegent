# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Data analysis endpoints for DuckDB operations.

Provides REST API endpoints for generating DuckDB files from Excel/CSV
attachments. Query execution has been moved to the Executor container
to keep knowledge_runtime stateless.
"""

from __future__ import annotations

from fastapi import APIRouter

from knowledge_runtime.services.data_service import DataService
from shared.models.data_analysis_protocol import (
    RemoteDataGenerateRequest,
    RemoteDataGenerateResponse,
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
