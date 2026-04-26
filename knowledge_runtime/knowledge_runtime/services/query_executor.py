# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query execution service for RAG retrieval operations."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.query.executor import QueryExecutor as KnowledgeQueryExecutor
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.db.session import get_session
from knowledge_runtime.services.config_resolver import ConfigResolver
from shared.models import (
    RemoteQueryRecord,
    RemoteQueryRequest,
    RemoteQueryResponse,
)

logger = logging.getLogger(__name__)


class QueryExecutor:
    """Executes RAG query operations.

    This executor:
    1. Resolves configs for each knowledge base from the database
    2. Creates storage backends and embedding models for each KB
    3. Executes queries against each KB
    4. Aggregates and sorts results by score
    """

    def __init__(self) -> None:
        self._config_resolver = ConfigResolver()

    async def execute(self, request: RemoteQueryRequest) -> RemoteQueryResponse:
        """Execute the query operation.

        Args:
            request: The query request (reference mode - configs resolved from DB).

        Returns:
            Query response with ranked records.
        """
        all_records: list[RemoteQueryRecord] = []

        # Resolve configs for each knowledge base
        for knowledge_base_id in request.knowledge_base_ids:
            records = await self._query_knowledge_base(
                request=request,
                knowledge_base_id=knowledge_base_id,
            )
            all_records.extend(records)

        # Sort by score (descending) and limit to max_results
        all_records.sort(key=lambda r: r.score or 0, reverse=True)
        limited_records = all_records[: request.max_results]

        # Calculate total estimated tokens (rough estimate)
        total_tokens = sum(
            self._estimate_tokens(record.content) for record in limited_records
        )

        logger.info(
            f"Query complete: query='{request.query[:50]}...', "
            f"total_results={len(all_records)}, returned={len(limited_records)}"
        )

        return RemoteQueryResponse(
            records=limited_records,
            total=len(all_records),
            total_estimated_tokens=total_tokens,
        )

    async def _query_knowledge_base(
        self,
        request: RemoteQueryRequest,
        knowledge_base_id: int,
    ) -> list[RemoteQueryRecord]:
        """Query a single knowledge base.

        Args:
            request: The original query request.
            knowledge_base_id: ID of the knowledge base to query.

        Returns:
            List of records from this knowledge base.
        """
        # Resolve config from database
        db_gen = get_session()
        db = next(db_gen)
        try:
            config = self._config_resolver.resolve_query_config(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=request.user_id,
            )
        finally:
            db.close()

        # Create storage backend and embedding model
        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            config.embedding_model_config
        )

        # Create query executor
        executor = KnowledgeQueryExecutor(
            storage_backend=storage_backend,
            embed_model=embed_model,
        )

        # Execute query
        knowledge_id = str(knowledge_base_id)
        result = await executor.execute(
            knowledge_id=knowledge_id,
            query=request.query,
            retrieval_config=config.retrieval_config,
            metadata_condition=request.metadata_condition,
            user_id=config.index_owner_user_id,
        )

        # Convert to RemoteQueryRecord format
        records: list[RemoteQueryRecord] = []
        for record in result.get("records", []):
            records.append(
                RemoteQueryRecord(
                    content=record.get("content", ""),
                    title=record.get("title", ""),
                    score=record.get("score"),
                    metadata=record.get("metadata"),
                    knowledge_base_id=knowledge_base_id,
                    document_id=self._extract_document_id(record),
                )
            )

        logger.info(
            f"Queried KB: knowledge_base_id={knowledge_base_id}, "
            f"records={len(records)}"
        )

        return records

    def _extract_document_id(self, record: dict[str, Any]) -> int | None:
        """Extract document ID from record metadata.

        Args:
            record: Query result record.

        Returns:
            Document ID if found, None otherwise.
        """
        metadata = record.get("metadata") or {}
        doc_ref = metadata.get("doc_ref")
        if doc_ref and isinstance(doc_ref, str):
            try:
                # doc_ref format is typically "doc_xxx" or numeric string
                if doc_ref.startswith("doc_"):
                    return int(doc_ref[4:])
                return int(doc_ref)
            except ValueError:
                pass
        return None

    def _estimate_tokens(self, text: str) -> int:
        """Estimate token count for text.

        Uses a simple heuristic: ~4 characters per token.

        Args:
            text: Text to estimate tokens for.

        Returns:
            Estimated token count.
        """
        return len(text) // 4
