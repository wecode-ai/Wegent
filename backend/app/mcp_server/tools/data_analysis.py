# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for data analysis - SQL querying and schema introspection for Excel/CSV files.

Architecture: Backend provides ContentRef for the Executor to download .duckdb files
and execute queries locally. This keeps knowledge_runtime stateless and avoids
per-node caching issues in load-balanced deployments.

Flow:
1. AI calls wegent_data_schema/wegent_data_query via MCP
2. Backend returns ContentRef + schema/query instructions
3. Executor downloads .duckdb file, executes query locally
4. Result is returned to AI
"""

from __future__ import annotations

import json
import logging
from typing import Any, Dict

from sqlalchemy.orm import Session

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.models.duckdb_cache import DuckDBCache
from app.models.subtask_context import ContextType, SubtaskContext
from app.services.rag.content_refs import build_content_ref_for_duckdb

logger = logging.getLogger(__name__)


def _get_duckdb_info(
    db: Session, attachment_id: int, user_id: int
) -> Dict[str, Any] | None:
    """Look up DuckDB metadata from duckdb_cache table and SubtaskContext.

    Args:
        db: Database session
        attachment_id: The source attachment ID
        user_id: User ID for ownership verification

    Returns:
        Dict with duckdb_attachment_id, content_ref, summary, tables
        if found, None otherwise
    """
    # Verify the attachment belongs to the user
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

    # Look up from duckdb_cache table (primary source of truth)
    cache_entry = (
        db.query(DuckDBCache).filter(DuckDBCache.attachment_id == attachment_id).first()
    )
    if (
        not cache_entry
        or cache_entry.status != "ready"
        or not cache_entry.duckdb_attachment_id
    ):
        return None

    # Build ContentRef for the .duckdb file
    try:
        content_ref = build_content_ref_for_duckdb(
            db=db,
            duckdb_attachment_id=cache_entry.duckdb_attachment_id,
        )
    except Exception as exc:
        logger.error(
            "Failed to build content ref for duckdb_attachment_id=%d: %s",
            cache_entry.duckdb_attachment_id,
            exc,
        )
        return None

    # Get tables info from type_data (populated during generation)
    type_data = context.type_data or {}
    duckdb_tables = type_data.get("duckdb_tables", [])
    duckdb_summary = type_data.get("duckdb_summary", {})

    return {
        "duckdb_attachment_id": cache_entry.duckdb_attachment_id,
        "content_ref": content_ref.model_dump(mode="json"),
        "summary": duckdb_summary,
        "tables": duckdb_tables,
    }


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
    Also returns a ContentRef for the Executor to download the .duckdb file.

    Args:
        attachment_id: The ID of the attachment to inspect
        token_info: Task token info (injected by MCP framework)

    Returns:
        Dict containing tables with their schema information and content_ref
    """
    db = SessionLocal()
    try:
        info = _get_duckdb_info(
            db=db,
            attachment_id=attachment_id,
            user_id=token_info.user_id,
        )
        if not info:
            return {
                "success": False,
                "error": f"No DuckDB data found for attachment {attachment_id}. "
                "The file may not be an Excel/CSV file, or DuckDB generation may not have completed yet.",
            }

        # Build schema from stored summary and tables info
        tables_schema = []
        for table in info["tables"]:
            table_name = table.get("name", "unknown")
            row_count = table.get("row_count", 0)
            columns = table.get("columns", [])

            columns_info = []
            for col in columns:
                columns_info.append(
                    {
                        "name": col.get("name", ""),
                        "type": col.get("type", ""),
                        "null_count": col.get("null_count", 0),
                    }
                )

            tables_schema.append(
                {
                    "name": table_name,
                    "row_count": row_count,
                    "columns": columns_info,
                }
            )

        return {
            "success": True,
            "attachment_id": attachment_id,
            "tables": tables_schema,
            "summary": info["summary"],
            "content_ref": info["content_ref"],
        }
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

    Returns a ContentRef for the Executor to download the .duckdb file
    and execute the query locally. The actual SQL execution happens in
    the Executor container, keeping knowledge_runtime stateless.

    Args:
        attachment_id: The ID of the attachment to query
        sql: SQL query to execute (SELECT only)
        token_info: Task token info (injected by MCP framework)

    Returns:
        Dict containing content_ref for downloading the .duckdb file,
        available table names, and the validated SQL.
    """
    db = SessionLocal()
    try:
        info = _get_duckdb_info(
            db=db,
            attachment_id=attachment_id,
            user_id=token_info.user_id,
        )
        if not info:
            return {
                "success": False,
                "error": f"No DuckDB data found for attachment {attachment_id}. "
                "The file may not be an Excel/CSV file, or DuckDB generation may not have completed yet.",
            }

        # Extract available table names
        table_names = [table.get("name", "") for table in info["tables"]]

        return {
            "success": True,
            "content_ref": info["content_ref"],
            "tables": table_names,
            "sql": sql,
            "instruction": (
                "Download the .duckdb file using the content_ref, "
                "then execute the SQL query locally in read-only mode. "
                "Use data_db. prefix for table names."
            ),
        }
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
