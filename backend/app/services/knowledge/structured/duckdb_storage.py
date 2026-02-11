# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
DuckDB storage manager for structured data queries.

This module manages DuckDB instances for CSV/XLSX data storage and SQL query execution.
Each knowledge base gets its own isolated in-memory DuckDB instance.
"""

import io
import logging
from typing import Any, Dict, List, Optional

import duckdb
import pandas as pd

logger = logging.getLogger(__name__)


class DuckDBManager:
    """Manages DuckDB instances for structured data queries.

    Each knowledge base has its own isolated in-memory DuckDB instance.
    Data is loaded from source files and cached in memory for fast querying.

    Thread Safety:
        DuckDB connections are not thread-safe. Each thread should use its own
        connection. This class creates new connections per operation for safety.
    """

    # Class-level storage for DuckDB data (table_name -> DataFrame)
    # We store DataFrames instead of connections for thread safety
    _data_store: Dict[str, pd.DataFrame] = {}

    @classmethod
    def get_table_name(cls, kb_id: int, doc_id: int) -> str:
        """Generate a unique table name for a document."""
        return f"kb_{kb_id}_doc_{doc_id}"

    @classmethod
    def ingest_csv(
        cls,
        kb_id: int,
        doc_id: int,
        file_data: bytes,
        encoding: str = "utf-8",
    ) -> Dict[str, Any]:
        """Ingest CSV data into DuckDB.

        Args:
            kb_id: Knowledge base ID
            doc_id: Document ID
            file_data: Raw CSV file bytes
            encoding: File encoding (default: utf-8)

        Returns:
            Schema metadata dict with table_name, schema, row_count, column_count
        """
        table_name = cls.get_table_name(kb_id, doc_id)

        try:
            # Try specified encoding first, fallback to common encodings
            encodings_to_try = [encoding, "utf-8", "latin-1", "gbk", "cp1252"]
            df = None

            for enc in encodings_to_try:
                try:
                    df = pd.read_csv(io.BytesIO(file_data), encoding=enc)
                    break
                except (UnicodeDecodeError, pd.errors.ParserError):
                    continue

            if df is None:
                raise ValueError("Could not decode CSV file with any supported encoding")

            # Store DataFrame
            cls._data_store[table_name] = df

            # Extract schema
            schema = cls._extract_schema_from_df(df, table_name)

            logger.info(
                f"[DuckDB] Ingested CSV: table={table_name}, "
                f"rows={len(df)}, columns={len(df.columns)}"
            )

            return schema

        except Exception as e:
            logger.error(f"[DuckDB] Failed to ingest CSV: {e}")
            raise

    @classmethod
    def ingest_excel(
        cls,
        kb_id: int,
        doc_id: int,
        file_data: bytes,
        sheet_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Ingest Excel data into DuckDB.

        Args:
            kb_id: Knowledge base ID
            doc_id: Document ID
            file_data: Raw Excel file bytes
            sheet_name: Optional specific sheet name (default: first sheet)

        Returns:
            Schema metadata dict with table_name, schema, row_count, column_count
        """
        table_name = cls.get_table_name(kb_id, doc_id)

        try:
            # Read Excel file
            df = pd.read_excel(
                io.BytesIO(file_data),
                sheet_name=sheet_name or 0,
                engine="openpyxl",
            )

            # Store DataFrame
            cls._data_store[table_name] = df

            # Extract schema
            schema = cls._extract_schema_from_df(df, table_name)

            logger.info(
                f"[DuckDB] Ingested Excel: table={table_name}, "
                f"rows={len(df)}, columns={len(df.columns)}"
            )

            return schema

        except Exception as e:
            logger.error(f"[DuckDB] Failed to ingest Excel: {e}")
            raise

    @classmethod
    def execute_query(
        cls,
        table_name: str,
        sql: str,
        max_rows: int = 10000,
    ) -> Dict[str, Any]:
        """Execute SQL query on a table.

        Args:
            table_name: Table name to query
            sql: SQL query string
            max_rows: Maximum rows to return (safety limit)

        Returns:
            Query result dict with columns, rows, row_count, truncated
        """
        if table_name not in cls._data_store:
            raise ValueError(f"Table not found: {table_name}")

        try:
            # Create a new DuckDB connection for this query (thread safety)
            conn = duckdb.connect(":memory:")

            # Register the DataFrame as a table
            df = cls._data_store[table_name]
            conn.register(table_name, df)

            # Add LIMIT if not present
            sql_upper = sql.upper()
            if "LIMIT" not in sql_upper:
                sql = f"{sql} LIMIT {max_rows}"

            # Execute query
            result_df = conn.execute(sql).fetchdf()

            # Close connection
            conn.close()

            # Check if truncated
            truncated = len(result_df) >= max_rows

            logger.info(
                f"[DuckDB] Query executed: table={table_name}, "
                f"rows={len(result_df)}, truncated={truncated}"
            )

            return {
                "columns": list(result_df.columns),
                "rows": result_df.values.tolist(),
                "row_count": len(result_df),
                "truncated": truncated,
            }

        except Exception as e:
            logger.error(f"[DuckDB] Query failed: {e}")
            raise

    @classmethod
    def get_schema(cls, table_name: str) -> Optional[Dict[str, Any]]:
        """Get schema information for a table.

        Args:
            table_name: Table name

        Returns:
            Schema metadata dict or None if table not found
        """
        if table_name not in cls._data_store:
            return None

        df = cls._data_store[table_name]
        return cls._extract_schema_from_df(df, table_name)

    @classmethod
    def table_exists(cls, table_name: str) -> bool:
        """Check if a table exists."""
        return table_name in cls._data_store

    @classmethod
    def drop_table(cls, table_name: str) -> bool:
        """Drop a table from storage.

        Args:
            table_name: Table name to drop

        Returns:
            True if table was dropped, False if not found
        """
        if table_name in cls._data_store:
            del cls._data_store[table_name]
            logger.info(f"[DuckDB] Dropped table: {table_name}")
            return True
        return False

    @classmethod
    def drop_kb_tables(cls, kb_id: int) -> int:
        """Drop all tables for a knowledge base.

        Args:
            kb_id: Knowledge base ID

        Returns:
            Number of tables dropped
        """
        prefix = f"kb_{kb_id}_"
        tables_to_drop = [t for t in cls._data_store.keys() if t.startswith(prefix)]

        for table_name in tables_to_drop:
            del cls._data_store[table_name]

        if tables_to_drop:
            logger.info(f"[DuckDB] Dropped {len(tables_to_drop)} tables for KB {kb_id}")

        return len(tables_to_drop)

    @classmethod
    def _extract_schema_from_df(cls, df: pd.DataFrame, table_name: str) -> Dict[str, Any]:
        """Extract schema information from a DataFrame.

        Args:
            df: DataFrame to analyze
            table_name: Table name for the schema

        Returns:
            Schema metadata dict
        """
        columns = []
        column_stats = {}

        for col_name in df.columns:
            col = df[col_name]
            dtype = str(col.dtype)

            # Map pandas dtype to SQL type
            sql_type = cls._pandas_to_sql_type(dtype)

            # Get sample values (non-null, first 5)
            sample_values = col.dropna().head(5).tolist()

            columns.append({
                "name": str(col_name),
                "type": sql_type,
                "nullable": col.isna().any(),
                "sample_values": sample_values,
            })

            # Calculate statistics based on type
            stats = {
                "null_count": int(col.isna().sum()),
                "distinct_count": int(col.nunique()),
            }

            if sql_type in ("INTEGER", "DOUBLE", "DECIMAL"):
                numeric_col = pd.to_numeric(col, errors="coerce")
                stats.update({
                    "min": float(numeric_col.min()) if not pd.isna(numeric_col.min()) else None,
                    "max": float(numeric_col.max()) if not pd.isna(numeric_col.max()) else None,
                    "mean": float(numeric_col.mean()) if not pd.isna(numeric_col.mean()) else None,
                })
            elif sql_type == "VARCHAR":
                str_col = col.astype(str)
                stats.update({
                    "avg_length": float(str_col.str.len().mean()) if len(str_col) > 0 else 0,
                    "max_length": int(str_col.str.len().max()) if len(str_col) > 0 else 0,
                })

            column_stats[str(col_name)] = stats

        return {
            "table_name": table_name,
            "schema": columns,
            "column_stats": column_stats,
            "row_count": len(df),
            "column_count": len(df.columns),
        }

    @staticmethod
    def _pandas_to_sql_type(dtype: str) -> str:
        """Map pandas dtype to SQL type string."""
        dtype_lower = dtype.lower()

        if "int" in dtype_lower:
            return "INTEGER"
        elif "float" in dtype_lower:
            return "DOUBLE"
        elif "bool" in dtype_lower:
            return "BOOLEAN"
        elif "datetime" in dtype_lower:
            return "TIMESTAMP"
        elif "date" in dtype_lower:
            return "DATE"
        else:
            return "VARCHAR"
