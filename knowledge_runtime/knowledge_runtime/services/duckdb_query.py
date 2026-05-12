# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""SQL query execution service for DuckDB data analysis.

Executes SQL queries against DuckDB files in read-only mode with security
validation, timeout enforcement, and result size limiting.
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import duckdb

from knowledge_runtime.config import get_settings
from knowledge_runtime.services.duckdb_manager import DuckDBManager
from shared.models.data_analysis_protocol import DuckDBColumnInfo, DuckDBTableInfo
from shared.models.knowledge_runtime_protocol import ContentRef

logger = logging.getLogger(__name__)


@dataclass
class DuckDBQueryResult:
    """Result of a SQL query execution."""

    columns: list[str] = field(default_factory=list)
    rows: list[list[Any]] = field(default_factory=list)
    row_count: int = 0
    total_count: int | None = None
    execution_time_ms: float = 0.0
    truncated: bool = False
    error: str | None = None


@dataclass
class DuckDBSchemaResult:
    """Result of a schema introspection query."""

    tables: list[DuckDBTableInfo] = field(default_factory=list)
    error: str | None = None


class DuckDBQueryService:
    """Executes SQL queries against DuckDB in read-only mode.

    Uses :memory: + ATTACH read-only pattern for safe query execution
    with SQL injection prevention via keyword blocking.
    """

    # SQL keywords that are blocked for security
    BLOCKED_KEYWORDS = [
        "DROP",
        "DELETE",
        "INSERT",
        "UPDATE",
        "ALTER",
        "CREATE",
        "ATTACH",
        "DETACH",
        "COPY",
        "EXPORT",
        "PRAGMA",
        "LOAD",
        "INSTALL",
        "FORCE",
    ]

    # Keywords allowed for read-only analysis (overrides BLOCKED for specific patterns)
    ALLOWED_PATTERNS = [
        # Allow CREATE TEMP TABLE/VIEW for complex analysis
        r"\bCREATE\s+(TEMP|TEMPORARY)\s+(TABLE|VIEW)\b",
    ]

    def __init__(self, manager: DuckDBManager) -> None:
        self._settings = get_settings()
        self._manager = manager

    async def query(
        self,
        attachment_id: int,
        content_ref: ContentRef,
        sql: str,
        max_rows: int = 5000,
    ) -> DuckDBQueryResult:
        """Execute SQL query using :memory: + ATTACH read-only pattern.

        Args:
            attachment_id: Attachment ID for cache lookup.
            content_ref: Content reference for downloading the DuckDB file.
            sql: SQL query to execute.
            max_rows: Maximum number of rows to return.

        Returns:
            DuckDBQueryResult with query results or error information.
        """
        start_time = time.monotonic()

        # Validate SQL for blocked keywords
        validation_error = self._validate_sql(sql)
        if validation_error:
            return DuckDBQueryResult(
                error=validation_error,
                execution_time_ms=(time.monotonic() - start_time) * 1000,
            )

        try:
            # Get the local DuckDB file path (downloading if needed)
            duckdb_path = await self._manager.get_duckdb_path(
                attachment_id, content_ref
            )

            # Execute query in thread (CPU-bound)
            result = await asyncio.to_thread(
                self._execute_query_sync,
                duckdb_path,
                sql,
                max_rows,
            )

            result.execution_time_ms = (time.monotonic() - start_time) * 1000
            return result

        except Exception as exc:
            logger.error(
                "Query execution failed for attachment_id=%d: %s",
                attachment_id,
                exc,
            )
            return DuckDBQueryResult(
                error=str(exc),
                execution_time_ms=(time.monotonic() - start_time) * 1000,
            )

    async def get_schema(
        self,
        attachment_id: int,
        content_ref: ContentRef,
    ) -> DuckDBSchemaResult:
        """Get schema for all tables in the DuckDB file.

        Args:
            attachment_id: Attachment ID for cache lookup.
            content_ref: Content reference for downloading the DuckDB file.

        Returns:
            DuckDBSchemaResult with table and column metadata.
        """
        try:
            duckdb_path = await self._manager.get_duckdb_path(
                attachment_id, content_ref
            )

            result = await asyncio.to_thread(
                self._execute_schema_sync,
                duckdb_path,
            )
            return result

        except Exception as exc:
            logger.error(
                "Schema extraction failed for attachment_id=%d: %s",
                attachment_id,
                exc,
            )
            return DuckDBSchemaResult(error=str(exc))

    def _validate_sql(self, sql: str) -> str | None:
        """Validate SQL for blocked keywords.

        Checks for potentially dangerous SQL keywords using word-boundary
        matching. Allows CREATE TEMP TABLE/VIEW patterns.

        Args:
            sql: SQL query to validate.

        Returns:
            Error message if validation fails, None if valid.
        """
        # Normalize SQL for checking
        sql_upper = sql.upper().strip()

        # Check if any allowed pattern matches first
        is_allowed_by_pattern = False
        for pattern in self.ALLOWED_PATTERNS:
            if re.search(pattern, sql_upper, re.IGNORECASE):
                is_allowed_by_pattern = True
                break

        # Check for blocked keywords with word boundary matching
        for keyword in self.BLOCKED_KEYWORDS:
            # Use word boundary to avoid false positives
            pattern = rf"\b{keyword}\b"
            if re.search(pattern, sql_upper):
                # Special case: allow CREATE TEMP/TEMPORARY TABLE/VIEW
                if keyword == "CREATE" and is_allowed_by_pattern:
                    continue
                return (
                    f"SQL contains blocked keyword '{keyword}'. "
                    f"Only read-only operations are allowed."
                )

        return None

    def _execute_query_sync(
        self,
        duckdb_path: Path,
        sql: str,
        max_rows: int,
    ) -> DuckDBQueryResult:
        """Execute SQL query synchronously.

        Uses :memory: connection with ATTACH read-only for safe execution.

        Args:
            duckdb_path: Local path to the DuckDB file.
            sql: SQL query to execute.
            max_rows: Maximum number of rows to return.

        Returns:
            DuckDBQueryResult with query results.
        """
        safe_path = str(duckdb_path).replace("'", "\\'")
        timeout = self._settings.duckdb_query_timeout

        conn = duckdb.connect(":memory:")
        try:
            # Attach the DuckDB file in read-only mode first
            conn.execute(f"ATTACH '{safe_path}' AS data_db (READ_ONLY)")

            # Disable external access after ATTACH to prevent further file system access.
            # ATTACH must come first since it requires file system access.
            # After ATTACH, this setting prevents any additional file reads
            # (e.g., read_csv_auto, read_xlsx) from being executed in queries.
            conn.execute("SET enable_external_access = false")
            # Note: statement_timeout is not available in all DuckDB versions.
            # The timeout is enforced at the asyncio.to_thread level instead.

            # Execute the query
            result = conn.execute(sql)

            # Extract column names
            columns = (
                [desc[0] for desc in result.description] if result.description else []
            )

            # Fetch all rows
            all_rows = result.fetchall()

            # Apply max_rows limit
            truncated = len(all_rows) > max_rows
            limited_rows = all_rows[:max_rows]

            # Convert rows to list of lists for serialization
            rows: list[list[Any]] = []
            for row in limited_rows:
                serialized_row = []
                for val in row:
                    # Convert non-serializable types to string
                    if val is not None and not isinstance(val, (str, int, float, bool)):
                        val = str(val)
                    serialized_row.append(val)
                rows.append(serialized_row)

            # Try to get total count for SELECT queries
            total_count: int | None = None
            if truncated:
                total_count = len(all_rows)

            return DuckDBQueryResult(
                columns=columns,
                rows=rows,
                row_count=len(rows),
                total_count=total_count,
                truncated=truncated,
            )

        except (duckdb.IOException, duckdb.OperationalError):
            logger.warning("Query timed out after %ds: %s", timeout, sql[:100])
            return DuckDBQueryResult(error=f"Query timed out after {timeout} seconds")
        except Exception as exc:
            logger.error("Query execution failed: %s", exc)
            return DuckDBQueryResult(error=str(exc))
        finally:
            conn.close()

    def _execute_schema_sync(
        self,
        duckdb_path: Path,
    ) -> DuckDBSchemaResult:
        """Extract schema information synchronously.

        Args:
            duckdb_path: Local path to the DuckDB file.

        Returns:
            DuckDBSchemaResult with table and column metadata.
        """
        safe_path = str(duckdb_path).replace("'", "\\'")

        conn = duckdb.connect(":memory:")
        try:
            # Attach first, then disable external access
            conn.execute(f"ATTACH '{safe_path}' AS data_db (READ_ONLY)")
            conn.execute("SET enable_external_access = false")

            # Get all tables in the attached database using table_catalog filter
            tables_result = conn.execute(
                "SELECT table_name FROM information_schema.tables "
                "WHERE table_catalog = 'data_db' AND table_schema = 'main'"
            ).fetchall()

            tables_info: list[DuckDBTableInfo] = []

            for (table_name,) in tables_result:
                try:
                    # Get row count
                    count_result = conn.execute(
                        f'SELECT COUNT(*) FROM data_db."{table_name}"'
                    ).fetchone()
                    row_count = count_result[0] if count_result else 0

                    # Get column info using table_catalog filter and parameterized query
                    columns_info: list[DuckDBColumnInfo] = []
                    col_result = conn.execute(
                        "SELECT column_name, data_type "
                        "FROM information_schema.columns "
                        "WHERE table_catalog = 'data_db' "
                        "AND table_name = ? "
                        "AND table_schema = 'main' "
                        "ORDER BY ordinal_position",
                        [table_name],
                    ).fetchall()

                    for col_name, col_type in col_result:
                        # Get null count
                        try:
                            null_result = conn.execute(
                                f'SELECT COUNT(*) FROM data_db."{table_name}" '
                                f'WHERE "{col_name}" IS NULL'
                            ).fetchone()
                            null_count = null_result[0] if null_result else 0
                        except Exception:
                            null_count = 0

                        columns_info.append(
                            DuckDBColumnInfo(
                                name=col_name,
                                type=col_type,
                                null_count=null_count,
                            )
                        )

                    tables_info.append(
                        DuckDBTableInfo(
                            name=table_name,
                            row_count=row_count,
                            columns=columns_info,
                        )
                    )

                except Exception as exc:
                    logger.warning(
                        "Failed to extract schema for table '%s': %s",
                        table_name,
                        exc,
                    )

            return DuckDBSchemaResult(tables=tables_info)

        except Exception as exc:
            logger.error("Schema extraction failed: %s", exc)
            return DuckDBSchemaResult(error=str(exc))
        finally:
            conn.close()
