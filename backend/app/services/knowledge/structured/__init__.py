# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Structured data query module for knowledge base.

This module provides SQL-based querying capabilities for tabular data (CSV/XLSX)
in knowledge bases, complementing the traditional RAG (vector search) approach.

Key components:
- DuckDBManager: Manages DuckDB instances for SQL query execution
- TextToSQLGenerator: Converts natural language to SQL using LLM
- SQLValidator: Validates SQL queries for safety
- SchemaExtractor: Extracts schema information from structured files
- StructuredQueryEngine: Orchestrates the structured query workflow
"""

from app.services.knowledge.structured.duckdb_storage import DuckDBManager
from app.services.knowledge.structured.engine import StructuredQueryEngine
from app.services.knowledge.structured.schema_extractor import SchemaExtractor
from app.services.knowledge.structured.sql_validator import SQLValidator
from app.services.knowledge.structured.text_to_sql import TextToSQLGenerator

__all__ = [
    "DuckDBManager",
    "TextToSQLGenerator",
    "SQLValidator",
    "SchemaExtractor",
    "StructuredQueryEngine",
]
