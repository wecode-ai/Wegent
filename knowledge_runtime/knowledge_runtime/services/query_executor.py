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
from shared.models import (
    RemoteKnowledgeBaseQueryConfig,
    RemoteQueryRecord,
    RemoteQueryRequest,
    RemoteQueryResponse,
)

logger = logging.getLogger(__name__)


class QueryExecutor:
    """Executes RAG query operations.

    This executor:
    1. Creates storage backends and embedding models for each knowledge base
    2. Executes queries against each KB
    3. Aggregates and sorts results by score
    """

    async def execute(self, request: RemoteQueryRequest) -> RemoteQueryResponse:
        """Execute the query operation.

        Args:
            request: The query request containing query text and KB configs.

        Returns:
            Query response with ranked records.
        """
        all_records: list[RemoteQueryRecord] = []

        # Query each knowledge base
        for kb_config in request.knowledge_base_configs:
            records = await self._query_knowledge_base(
                request=request,
                kb_config=kb_config,
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
        kb_config: RemoteKnowledgeBaseQueryConfig,
    ) -> list[RemoteQueryRecord]:
        """Query a single knowledge base.

        Args:
            request: The original query request.
            kb_config: Configuration for this specific knowledge base.

        Returns:
            List of records from this knowledge base.
        """
        # Create storage backend
        storage_backend = create_storage_backend_from_runtime_config(
            kb_config.retriever_config
        )

        # Create embedding model
        embed_model = create_embedding_model_from_runtime_config(
            kb_config.embedding_model_config
        )

        # Create query executor
        executor = KnowledgeQueryExecutor(
            storage_backend=storage_backend,
            embed_model=embed_model,
        )

        # Build knowledge_id
        knowledge_id = str(kb_config.knowledge_base_id)

        # Execute query
        result = await executor.execute(
            knowledge_id=knowledge_id,
            query=request.query,
            retrieval_config=kb_config.retrieval_config,
            metadata_condition=request.metadata_condition,
            user_id=kb_config.index_owner_user_id,
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
                    knowledge_base_id=kb_config.knowledge_base_id,
                    document_id=self._extract_document_id(record),
                )
            )

        logger.info(
            f"Queried KB: knowledge_base_id={kb_config.knowledge_base_id}, "
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
