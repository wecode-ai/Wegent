# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schema extractor for structured data files.

This module extracts schema information from CSV/XLSX files for use in
Text-to-SQL prompts and query validation.
"""

import io
import logging
from typing import Any, Dict, List, Optional

import pandas as pd

logger = logging.getLogger(__name__)


class SchemaExtractor:
    """Extracts schema information from structured data files.

    Analyzes CSV/XLSX files to extract:
    - Column names and types
    - Sample values
    - Statistics (min, max, distinct count, etc.)
    - Natural language description for LLM context
    """

    # Maximum sample rows to analyze for statistics
    MAX_SAMPLE_ROWS = 10000

    # Maximum sample values per column
    MAX_SAMPLE_VALUES = 5

    @classmethod
    def extract_from_csv(
        cls,
        file_data: bytes,
        encoding: str = "utf-8",
    ) -> Dict[str, Any]:
        """Extract schema from CSV file.

        Args:
            file_data: Raw CSV file bytes
            encoding: File encoding

        Returns:
            Schema information dict
        """
        # Try multiple encodings
        encodings_to_try = [encoding, "utf-8", "latin-1", "gbk", "cp1252"]
        df = None

        for enc in encodings_to_try:
            try:
                df = pd.read_csv(
                    io.BytesIO(file_data),
                    encoding=enc,
                    nrows=cls.MAX_SAMPLE_ROWS,
                )
                break
            except (UnicodeDecodeError, pd.errors.ParserError):
                continue

        if df is None:
            raise ValueError("Could not decode CSV file with any supported encoding")

        return cls._analyze_dataframe(df)

    @classmethod
    def extract_from_excel(
        cls,
        file_data: bytes,
        sheet_name: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Extract schema from Excel file.

        Args:
            file_data: Raw Excel file bytes
            sheet_name: Optional specific sheet name

        Returns:
            Schema information dict
        """
        df = pd.read_excel(
            io.BytesIO(file_data),
            sheet_name=sheet_name or 0,
            engine="openpyxl",
            nrows=cls.MAX_SAMPLE_ROWS,
        )

        return cls._analyze_dataframe(df)

    @classmethod
    def _analyze_dataframe(cls, df: pd.DataFrame) -> Dict[str, Any]:
        """Analyze DataFrame and extract schema information.

        Args:
            df: DataFrame to analyze

        Returns:
            Schema information dict
        """
        columns = []
        column_stats = {}

        for col_name in df.columns:
            col = df[col_name]
            col_info = cls._analyze_column(col, str(col_name))
            columns.append(col_info["definition"])
            column_stats[str(col_name)] = col_info["stats"]

        # Generate natural language description
        nl_description = cls._generate_description(df, columns)

        # Generate sample queries
        sample_queries = cls._generate_sample_queries(columns)

        return {
            "columns": columns,
            "column_stats": column_stats,
            "row_count": len(df),
            "column_count": len(df.columns),
            "natural_language_description": nl_description,
            "sample_queries": sample_queries,
        }

    @classmethod
    def _analyze_column(cls, col: pd.Series, col_name: str) -> Dict[str, Any]:
        """Analyze a single column.

        Args:
            col: Column Series
            col_name: Column name

        Returns:
            Column analysis dict with definition and stats
        """
        dtype = str(col.dtype)
        sql_type = cls._infer_sql_type(col, dtype)

        # Get sample values
        sample_values = col.dropna().head(cls.MAX_SAMPLE_VALUES).tolist()

        # Convert sample values to appropriate types for JSON serialization
        sample_values = [
            str(v) if not isinstance(v, (int, float, bool, type(None))) else v
            for v in sample_values
        ]

        definition = {
            "name": col_name,
            "type": sql_type,
            "nullable": bool(col.isna().any()),
            "sample_values": sample_values,
        }

        # Calculate statistics
        stats = {
            "null_count": int(col.isna().sum()),
            "distinct_count": int(col.nunique()),
        }

        if sql_type in ("INTEGER", "DOUBLE", "DECIMAL"):
            numeric_col = pd.to_numeric(col, errors="coerce")
            if not numeric_col.isna().all():
                stats.update({
                    "min": float(numeric_col.min()) if pd.notna(numeric_col.min()) else None,
                    "max": float(numeric_col.max()) if pd.notna(numeric_col.max()) else None,
                    "mean": float(numeric_col.mean()) if pd.notna(numeric_col.mean()) else None,
                })
        elif sql_type == "VARCHAR":
            str_col = col.astype(str)
            if len(str_col) > 0:
                stats.update({
                    "avg_length": float(str_col.str.len().mean()),
                    "max_length": int(str_col.str.len().max()),
                })

        return {"definition": definition, "stats": stats}

    @classmethod
    def _infer_sql_type(cls, col: pd.Series, dtype: str) -> str:
        """Infer SQL type from column data.

        Args:
            col: Column Series
            dtype: Pandas dtype string

        Returns:
            SQL type string
        """
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
        elif dtype_lower == "object":
            # Try to infer from actual values
            sample = col.dropna().head(100)
            if len(sample) == 0:
                return "VARCHAR"

            # Check if all values look like numbers
            try:
                pd.to_numeric(sample)
                return "DOUBLE"
            except (ValueError, TypeError):
                pass

            # Check if all values look like dates
            try:
                pd.to_datetime(sample)
                return "DATE"
            except (ValueError, TypeError):
                pass

            return "VARCHAR"
        else:
            return "VARCHAR"

    @classmethod
    def _generate_description(
        cls,
        df: pd.DataFrame,
        columns: List[Dict[str, Any]],
    ) -> str:
        """Generate natural language description of the data.

        Args:
            df: DataFrame
            columns: Column definitions

        Returns:
            Natural language description string
        """
        col_descriptions = []
        for col in columns:
            col_type = col["type"]
            samples = col.get("sample_values", [])
            sample_str = ", ".join(str(s) for s in samples[:3]) if samples else "N/A"
            col_descriptions.append(f"- {col['name']} ({col_type}): e.g., {sample_str}")

        return f"""This table contains {len(df)} rows and {len(columns)} columns.

Columns:
{chr(10).join(col_descriptions)}"""

    @classmethod
    def _generate_sample_queries(cls, columns: List[Dict[str, Any]]) -> List[str]:
        """Generate sample queries based on column types.

        Args:
            columns: Column definitions

        Returns:
            List of sample query strings
        """
        queries = []

        # Find numeric columns for aggregation
        numeric_cols = [c["name"] for c in columns if c["type"] in ("INTEGER", "DOUBLE")]
        # Find categorical columns for grouping
        categorical_cols = [c["name"] for c in columns if c["type"] == "VARCHAR"]

        if numeric_cols:
            num_col = numeric_cols[0]
            queries.append(f"What is the total {num_col}?")
            queries.append(f"What is the average {num_col}?")

            if categorical_cols:
                cat_col = categorical_cols[0]
                queries.append(f"What is the {num_col} by {cat_col}?")
                queries.append(f"What are the top 10 {cat_col} by {num_col}?")

        if categorical_cols:
            cat_col = categorical_cols[0]
            queries.append(f"How many unique {cat_col} are there?")

        return queries[:5]  # Limit to 5 sample queries
