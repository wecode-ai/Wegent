# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Transport models for Backend <-> knowledge_runtime data analysis operations.

Provides request/response models for DuckDB-based Excel/CSV data analysis,
including file generation, SQL querying, and schema introspection.
"""

from __future__ import annotations

from typing import Any

from pydantic import Field

from shared.models.knowledge_runtime_protocol import (
    ContentRef,
    KnowledgeRuntimeProtocolModel,
)


class DuckDBColumnInfo(KnowledgeRuntimeProtocolModel):
    """Column metadata from DuckDB table inspection."""

    name: str
    type: str
    null_count: int = 0


class DuckDBTableInfo(KnowledgeRuntimeProtocolModel):
    """Table metadata from DuckDB database inspection."""

    name: str
    row_count: int = 0
    columns: list[DuckDBColumnInfo] = []


# ============== Generate Request/Response ==============


class RemoteDataGenerateRequest(KnowledgeRuntimeProtocolModel):
    """Request to generate a .duckdb file from an Excel/CSV attachment.

    The knowledge_runtime fetches the source file via content_ref,
    imports it into DuckDB, runs SUMMARIZE, and returns the results.
    """

    attachment_id: int
    content_ref: ContentRef
    source_file: str | None = None
    file_extension: str | None = None
    extensions: dict[str, Any] | None = None


class RemoteDataGenerateResponse(KnowledgeRuntimeProtocolModel):
    """Response from DuckDB generation for an Excel/CSV attachment."""

    success: bool
    attachment_id: int
    duckdb_attachment_id: int | None = None
    summary: dict[str, Any] | None = None
    tables: list[DuckDBTableInfo] = []
    generation_time_ms: float = 0.0
    duckdb_file_size: int = Field(default=0, ge=0)
    source_file_hash: str | None = None
    error: str | None = None


# ============== Query Request/Response ==============


class RemoteDataQueryRequest(KnowledgeRuntimeProtocolModel):
    """Request to execute a SQL query against a DuckDB attachment.

    The query runs in :memory: + ATTACH read-only mode.
    Table names must use the data_db. prefix.
    """

    attachment_id: int
    content_ref: ContentRef
    sql: str
    max_rows: int = Field(default=5000, gt=0, le=10000)
    extensions: dict[str, Any] | None = None


class RemoteDataQueryResponse(KnowledgeRuntimeProtocolModel):
    """Response from a SQL query against a DuckDB attachment."""

    success: bool
    columns: list[str] = []
    rows: list[list[Any]] = []
    row_count: int = 0
    total_count: int | None = None
    execution_time_ms: float = 0.0
    truncated: bool = False
    error: str | None = None


# ============== Schema Request/Response ==============


class RemoteDataSchemaRequest(KnowledgeRuntimeProtocolModel):
    """Request to get schema information for a DuckDB attachment."""

    attachment_id: int
    content_ref: ContentRef
    extensions: dict[str, Any] | None = None


class RemoteDataSchemaResponse(KnowledgeRuntimeProtocolModel):
    """Schema information for tables in a DuckDB attachment."""

    attachment_id: int
    tables: list[DuckDBTableInfo] = []
    error: str | None = None
