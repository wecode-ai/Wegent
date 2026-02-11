# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Structured query engine for knowledge base.

This module orchestrates the structured data query workflow:
1. Load data from knowledge document
2. Generate SQL from natural language
3. Validate SQL for safety
4. Execute query
5. Format results
"""

import logging
from typing import Any, Dict, List, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.services.knowledge.structured.duckdb_storage import DuckDBManager
from app.services.knowledge.structured.sql_validator import SQLValidator
from app.services.knowledge.structured.text_to_sql import TextToSQLGenerator

logger = logging.getLogger(__name__)


class StructuredQueryEngine:
    """Orchestrates structured data queries.

    Handles the full workflow from natural language query to SQL results:
    1. Check if structured data is available for the knowledge base
    2. Get schema information for the document
    3. Generate SQL from natural language
    4. Validate SQL for safety
    5. Execute query on DuckDB
    6. Format and return results
    """

    # Maximum retry attempts for SQL generation
    MAX_RETRIES = 3

    def __init__(self):
        """Initialize the engine."""
        self.text_to_sql = TextToSQLGenerator()
        self.sql_validator = SQLValidator()

    async def execute(
        self,
        query: str,
        knowledge_base_id: int,
        db: Session,
        document_ids: Optional[List[int]] = None,
        max_rows: Optional[int] = None,
    ) -> Dict[str, Any]:
        """Execute structured query on knowledge base.

        Args:
            query: Natural language query
            knowledge_base_id: Knowledge base ID
            db: Database session
            document_ids: Optional specific document IDs to query
            max_rows: Maximum rows to return

        Returns:
            Query result dict with:
            - query: Original query
            - mode: "structured_query"
            - generated_sql: SQL query
            - explanation: SQL explanation
            - confidence: Generation confidence
            - results: Query results
            - sources: Source documents
        """
        from app.models.knowledge import KnowledgeDocument
        from app.models.kind import Kind

        max_rows = max_rows or settings.STRUCTURED_DATA_MAX_ROWS

        # Get knowledge base
        kb = (
            db.query(Kind)
            .filter(
                Kind.id == knowledge_base_id,
                Kind.kind == "KnowledgeBase",
                Kind.is_active,
            )
            .first()
        )

        if not kb:
            return self._error_response(query, "Knowledge base not found")

        # Get structured documents
        docs_query = db.query(KnowledgeDocument).filter(
            KnowledgeDocument.kind_id == knowledge_base_id,
            KnowledgeDocument.is_active == True,
        )

        if document_ids:
            docs_query = docs_query.filter(KnowledgeDocument.id.in_(document_ids))

        # Filter to structured file types
        structured_extensions = [".csv", ".xlsx", ".xls"]
        docs_query = docs_query.filter(
            KnowledgeDocument.file_extension.in_(structured_extensions)
        )

        documents = docs_query.all()

        if not documents:
            return self._error_response(
                query,
                "No structured data documents found in this knowledge base. "
                "Structured queries require CSV or XLSX files.",
            )

        # For now, query the first document
        # TODO: Support multi-table queries in the future
        doc = documents[0]

        # Get or create schema for the document
        schema = await self._get_or_create_schema(doc, db)

        if not schema:
            return self._error_response(
                query,
                f"Failed to extract schema from document: {doc.name}",
            )

        table_name = DuckDBManager.get_table_name(knowledge_base_id, doc.id)

        # Generate SQL with retry
        result = await self._generate_and_execute_with_retry(
            query=query,
            schema=schema,
            table_name=table_name,
            doc=doc,
            max_rows=max_rows,
        )

        # Add source information
        result["sources"] = [
            {
                "index": 1,
                "title": doc.name,
                "kb_id": knowledge_base_id,
                "doc_id": doc.id,
            }
        ]

        return result

    async def _get_or_create_schema(
        self,
        doc,  # KnowledgeDocument
        db: Session,
    ) -> Optional[Dict[str, Any]]:
        """Get or create schema for a document.

        Args:
            doc: KnowledgeDocument instance
            db: Database session

        Returns:
            Schema information dict or None
        """
        from app.models.context import SubtaskContext

        # Check if schema is cached in source_config
        source_config = doc.source_config or {}
        if "structured_data" in source_config:
            cached = source_config["structured_data"]
            table_name = cached.get("duckdb_table_name")
            if table_name and DuckDBManager.table_exists(table_name):
                return {
                    "columns": cached.get("schema", []),
                    "column_stats": cached.get("column_stats", {}),
                    "row_count": cached.get("row_count", 0),
                    "column_count": cached.get("column_count", 0),
                }

        # Need to load data and create schema
        if not doc.attachment_id:
            logger.warning(f"[StructuredQuery] Document {doc.id} has no attachment")
            return None

        # Get attachment
        attachment = db.query(SubtaskContext).filter(
            SubtaskContext.id == doc.attachment_id
        ).first()

        if not attachment or not attachment.binary_data:
            logger.warning(f"[StructuredQuery] Attachment {doc.attachment_id} not found")
            return None

        # Ingest data based on file type
        try:
            file_ext = doc.file_extension.lower()
            kb_id = doc.kind_id

            if file_ext == ".csv":
                schema = DuckDBManager.ingest_csv(
                    kb_id=kb_id,
                    doc_id=doc.id,
                    file_data=attachment.binary_data,
                )
            elif file_ext in (".xlsx", ".xls"):
                schema = DuckDBManager.ingest_excel(
                    kb_id=kb_id,
                    doc_id=doc.id,
                    file_data=attachment.binary_data,
                )
            else:
                logger.warning(f"[StructuredQuery] Unsupported file type: {file_ext}")
                return None

            # Cache schema in source_config
            source_config["structured_data"] = {
                "duckdb_table_name": schema["table_name"],
                "schema": schema["schema"],
                "column_stats": schema["column_stats"],
                "row_count": schema["row_count"],
                "column_count": schema["column_count"],
            }
            doc.source_config = source_config
            # Use flush() instead of commit() to allow caller to manage transaction
            db.flush()

            logger.info(
                f"[StructuredQuery] Ingested document {doc.id}: "
                f"table={schema['table_name']}, rows={schema['row_count']}"
            )

            return {
                "columns": schema["schema"],
                "column_stats": schema["column_stats"],
                "row_count": schema["row_count"],
                "column_count": schema["column_count"],
            }

        except Exception as e:
            logger.error(f"[StructuredQuery] Failed to ingest document {doc.id}: {e}")
            return None

    async def _generate_and_execute_with_retry(
        self,
        query: str,
        schema: Dict[str, Any],
        table_name: str,
        doc,  # KnowledgeDocument
        max_rows: int,
    ) -> Dict[str, Any]:
        """Generate SQL and execute with retry on failure.

        Args:
            query: Natural language query
            schema: Schema information
            table_name: DuckDB table name
            doc: Document instance
            max_rows: Maximum rows

        Returns:
            Query result dict
        """
        last_error = None
        last_sql = None

        for attempt in range(self.MAX_RETRIES):
            try:
                # Generate SQL
                error_context = f"Previous error: {last_error}" if last_error else None
                generation = await self.text_to_sql.generate(
                    query=query if not error_context else f"{query}\n\n{error_context}",
                    schema=schema,
                    table_name=table_name,
                )

                sql = generation["sql"]
                last_sql = sql

                # Validate SQL
                validation = self.sql_validator.validate(
                    sql=sql,
                    allowed_tables=[table_name],
                )

                if not validation["is_valid"]:
                    last_error = f"SQL validation failed: {validation['errors']}"
                    logger.warning(
                        f"[StructuredQuery] Attempt {attempt + 1} validation failed: {validation['errors']}"
                    )
                    continue

                # Execute query
                result = DuckDBManager.execute_query(
                    table_name=table_name,
                    sql=sql,
                    max_rows=max_rows,
                )

                # Success!
                return {
                    "query": query,
                    "mode": "structured_query",
                    "generated_sql": sql,
                    "explanation": generation.get("explanation", ""),
                    "confidence": generation.get("confidence", 0.5),
                    "results": result,
                }

            except Exception as e:
                last_error = str(e)
                logger.warning(
                    f"[StructuredQuery] Attempt {attempt + 1} failed: {e}"
                )

        # All retries failed
        logger.error(
            f"[StructuredQuery] Query failed after {self.MAX_RETRIES} attempts"
        )

        return {
            "query": query,
            "mode": "structured_query",
            "generated_sql": last_sql or "",
            "explanation": "",
            "confidence": 0.0,
            "results": {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "truncated": False,
            },
            "error": f"Query failed after {self.MAX_RETRIES} attempts: {last_error}",
        }

    def _error_response(self, query: str, error: str) -> Dict[str, Any]:
        """Create error response.

        Args:
            query: Original query
            error: Error message

        Returns:
            Error response dict
        """
        return {
            "query": query,
            "mode": "structured_query",
            "generated_sql": "",
            "explanation": "",
            "confidence": 0.0,
            "results": {
                "columns": [],
                "rows": [],
                "row_count": 0,
                "truncated": False,
            },
            "error": error,
            "sources": [],
        }


# Singleton instance
structured_query_engine = StructuredQueryEngine()
