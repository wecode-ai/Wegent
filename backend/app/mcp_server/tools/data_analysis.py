# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for data analysis - SQL querying and schema introspection for Excel/CSV files."""

from __future__ import annotations

import logging
from typing import Any, Dict

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.rag.content_refs import build_content_ref_for_duckdb
from shared.models.data_analysis_protocol import (
    RemoteDataQueryRequest,
    RemoteDataQueryResponse,
    RemoteDataSchemaRequest,
    RemoteDataSchemaResponse,
)

logger = logging.getLogger(__name__)


def _get_duckdb_attachment_id(
    db: Session, attachment_id: int, user_id: int
) -> int | None:
    """Look up the duckdb_attachment_id from SubtaskContext.type_data.

    Args:
        db: Database session
        attachment_id: The source attachment ID
        user_id: User ID for ownership verification

    Returns:
        The duckdb_attachment_id if found, None otherwise
    """
    context = (
        db.query(SubtaskContext)
        .filter(
            SubtaskContext.id == attachment_id,
            SubtaskContext.user_id == user_id,
            SubtaskContext.context_type == ContextType.ATTACHMENT.value,
        )
        .first()
    )
    if not context:
        return None

    type_data = context.type_data or {}
    return type_data.get("duckdb_attachment_id")


def _call_kr_schema(attachment_id: int, duckdb_attachment_id: int) -> Dict[str, Any]:
    """Call knowledge_runtime to get schema information.

    Args:
        attachment_id: Original source attachment ID
        duckdb_attachment_id: The .duckdb file attachment ID

    Returns:
        Schema response dict with consistent success field
    """
    import httpx

    from app.core.config import settings

    db = SessionLocal()
    try:
        content_ref = build_content_ref_for_duckdb(
            db=db,
            duckdb_attachment_id=duckdb_attachment_id,
        )
        request = RemoteDataSchemaRequest(
            attachment_id=attachment_id,
            content_ref=content_ref,
        )

        kr_url = (
            getattr(settings, "KNOWLEDGE_RUNTIME_URL", "http://localhost:8200")
            or "http://localhost:8200"
        )
        with httpx.Client(timeout=30) as client:
            response = client.post(
                f"{kr_url}/internal/data/schema",
                json=request.model_dump(mode="json"),
                headers={
                    "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            result = RemoteDataSchemaResponse.model_validate(response.json())
            # Add success field for consistent response format
            result_dict = result.model_dump()
            result_dict["success"] = result.error is None
            return result_dict
    finally:
        db.close()


def _call_kr_query(
    attachment_id: int, duckdb_attachment_id: int, sql: str
) -> Dict[str, Any]:
    """Call knowledge_runtime to execute a SQL query.

    Args:
        attachment_id: Original source attachment ID
        duckdb_attachment_id: The .duckdb file attachment ID
        sql: SQL query to execute

    Returns:
        Query response dict
    """
    import httpx

    from app.core.config import settings

    db = SessionLocal()
    try:
        content_ref = build_content_ref_for_duckdb(
            db=db,
            duckdb_attachment_id=duckdb_attachment_id,
        )
        request = RemoteDataQueryRequest(
            attachment_id=attachment_id,
            content_ref=content_ref,
            sql=sql,
        )

        kr_url = (
            getattr(settings, "KNOWLEDGE_RUNTIME_URL", "http://localhost:8200")
            or "http://localhost:8200"
        )
        with httpx.Client(timeout=60) as client:
            response = client.post(
                f"{kr_url}/internal/data/query",
                json=request.model_dump(mode="json"),
                headers={
                    "Authorization": f"Bearer {settings.INTERNAL_SERVICE_TOKEN}",
                    "Content-Type": "application/json",
                },
            )
            response.raise_for_status()
            result = RemoteDataQueryResponse.model_validate(response.json())
            return result.model_dump()
    finally:
        db.close()


@mcp_tool(
    name="wegent_data_schema",
    description="Get the schema and statistical summary of an Excel/CSV data file attachment. Returns table names, column types, row counts, and statistical summaries. Use this tool FIRST to understand the data structure before writing SQL queries with wegent_data_query.",
    server="data_analysis",
    param_descriptions={
        "attachment_id": "Attachment ID of the Excel/CSV file (found in the attachment metadata prefix of uploaded files)",
    },
)
def get_data_schema(
    attachment_id: int,
    token_info: TaskTokenInfo,
) -> Dict[str, Any]:
    """Get schema information for a data attachment.

    Retrieves table names, column definitions, and statistical summaries
    for an Excel/CSV file that has been processed with DuckDB.

    Args:
        attachment_id: The ID of the attachment to inspect
        token_info: Task token info (injected by MCP framework)

    Returns:
        Dict containing tables with their schema information
    """
    db = SessionLocal()
    try:
        # Look up duckdb_attachment_id from the source attachment
        duckdb_attachment_id = _get_duckdb_attachment_id(
            db=db,
            attachment_id=attachment_id,
            user_id=token_info.user_id,
        )
        if not duckdb_attachment_id:
            return {
                "success": False,
                "error": f"No DuckDB data found for attachment {attachment_id}. "
                "The file may not be an Excel/CSV file, or DuckDB generation may not have completed yet.",
            }

        return _call_kr_schema(
            attachment_id=attachment_id,
            duckdb_attachment_id=duckdb_attachment_id,
        )
    except Exception as e:
        logger.exception(
            f"Error getting data schema for attachment {attachment_id}: {e}"
        )
        return {
            "success": False,
            "error": f"Failed to get schema: {str(e)}",
        }
    finally:
        db.close()


@mcp_tool(
    name="wegent_data_query",
    description="Execute a SQL query against an Excel/CSV data file attachment. The query runs in read-only mode with temporary table support. Use data_db. prefix for table names (e.g., data_db.sales_2024). Only SELECT queries are allowed. Results are limited to 5000 rows with a 30-second timeout.",
    server="data_analysis",
    param_descriptions={
        "attachment_id": "Attachment ID of the Excel/CSV file (found in the attachment metadata prefix of uploaded files)",
        "sql": "SQL SELECT query to execute. Use data_db. prefix for table names (e.g., data_db.sales_2024). Supports CREATE TEMP TABLE/VIEW for complex analysis.",
    },
)
def execute_data_query(
    attachment_id: int,
    sql: str,
    token_info: TaskTokenInfo,
) -> Dict[str, Any]:
    """Execute a SQL query against a data attachment.

    Runs a read-only SQL query against the DuckDB database generated
    from an Excel/CSV file. Use wegent_data_schema first to understand
    the available tables and columns.

    Args:
        attachment_id: The ID of the attachment to query
        sql: SQL query to execute (SELECT only)
        token_info: Task token info (injected by MCP framework)

    Returns:
        Dict containing query results with columns, rows, and metadata
    """
    db = SessionLocal()
    try:
        # Look up duckdb_attachment_id from the source attachment
        duckdb_attachment_id = _get_duckdb_attachment_id(
            db=db,
            attachment_id=attachment_id,
            user_id=token_info.user_id,
        )
        if not duckdb_attachment_id:
            return {
                "success": False,
                "error": f"No DuckDB data found for attachment {attachment_id}. "
                "The file may not be an Excel/CSV file, or DuckDB generation may not have completed yet.",
            }

        return _call_kr_query(
            attachment_id=attachment_id,
            duckdb_attachment_id=duckdb_attachment_id,
            sql=sql,
        )
    except Exception as e:
        logger.exception(
            f"Error executing data query for attachment {attachment_id}: {e}"
        )
        return {
            "success": False,
            "error": f"Failed to execute query: {str(e)}",
        }
    finally:
        db.close()
