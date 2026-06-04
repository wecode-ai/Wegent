# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query execution service for RAG retrieval operations."""

from __future__ import annotations

import logging
from typing import Any

from knowledge_runtime.services.config_resolver import ConfigResolver
from knowledge_runtime.services.query_planner import QueryPlan, QueryPlanner
from sqlalchemy.orm import Session

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.query.executor import QueryExecutor as KnowledgeQueryExecutor
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import (
    RemoteKnowledgeBaseRetrievalOverride,
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

    def __init__(self, db: Session, planner: QueryPlanner | None = None) -> None:
        self._db = db
        self._config_resolver = ConfigResolver()
        self._planner = planner or QueryPlanner()

    async def execute(self, request: RemoteQueryRequest) -> RemoteQueryResponse:
        """Execute the query operation.

        Args:
            request: The query request (reference mode - configs resolved from DB).

        Returns:
            Query response with ranked records.
        """
        plan = self._planner.plan(request.query, request.search_hints)
        all_records: list[RemoteQueryRecord] = []
        retrieval_override_by_kb_id = self._build_retrieval_override_map(
            request.knowledge_base_ids,
            request.knowledge_base_retrieval_overrides,
        )

        if request.search_hints is None:
            search_hints: dict[str, Any] = {}
        elif isinstance(request.search_hints, dict):
            search_hints = dict(request.search_hints)
        else:
            search_hints = request.search_hints.model_dump(exclude_none=True)
        logger.info(
            "Query request: hint_source=%s, normalized_query='%s...', dense_query='%s...', sparse_query='%s...', hints_present=%s, semantic_query=%s, keywords=%s, phrases=%s",
            plan.hint_source,
            plan.normalized_query[:50],
            plan.dense_query[:50],
            plan.sparse_query[:50],
            bool(search_hints),
            bool(search_hints.get("semantic_query")),
            len(search_hints.get("keywords") or []),
            len(search_hints.get("phrases") or []),
        )

        # Resolve configs for each knowledge base
        for knowledge_base_id in request.knowledge_base_ids:
            records = await self._query_knowledge_base(
                request=request,
                knowledge_base_id=knowledge_base_id,
                plan=plan,
                retrieval_override=retrieval_override_by_kb_id.get(knowledge_base_id),
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
            "Query complete: hint_source=%s, normalized_query='%s...', total_results=%d, returned=%d",
            plan.hint_source,
            plan.normalized_query[:50],
            len(all_records),
            len(limited_records),
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
        plan: QueryPlan,
        retrieval_override: RemoteKnowledgeBaseRetrievalOverride | None = None,
    ) -> list[RemoteQueryRecord]:
        """Query a single knowledge base.

        Args:
            request: The original query request.
            knowledge_base_id: ID of the knowledge base to query.

        Returns:
            List of records from this knowledge base.
        """
        # Resolve config from database
        config = self._config_resolver.resolve_query_config(
            db=self._db,
            knowledge_base_id=knowledge_base_id,
            user_id=request.user_id,
        )
        if retrieval_override is not None:
            config = config.__class__(
                knowledge_base_id=config.knowledge_base_id,
                index_owner_user_id=config.index_owner_user_id,
                retriever_config=config.retriever_config,
                embedding_model_config=config.embedding_model_config,
                retrieval_config=retrieval_override.retrieval_config,
                user_name=config.user_name,
            )

        # Create storage backend and embedding model
        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            config.embedding_model_config
        )
        storage_type = config.retriever_config.storage_config.get("type", "unknown")

        logger.info(
            "Query KB config: knowledge_base_id=%d, config_source=%s, storage_type=%s, retrieval_mode=%s, top_k=%s, score_threshold=%s, vector_weight=%s, keyword_weight=%s",
            knowledge_base_id,
            "request_override" if retrieval_override is not None else "database",
            storage_type,
            config.retrieval_config.retrieval_mode,
            config.retrieval_config.top_k,
            config.retrieval_config.score_threshold,
            config.retrieval_config.vector_weight,
            config.retrieval_config.keyword_weight,
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
            query=plan.normalized_query,
            query_plan={
                "dense_query": plan.dense_query,
                "sparse_query": plan.sparse_query,
                "keywords": plan.keywords,
                "phrases": plan.phrases,
                "hint_source": plan.hint_source,
            },
            retrieval_config=config.retrieval_config,
            metadata_condition=self._combine_metadata_conditions(
                self._build_document_filter(request.document_ids),
                request.metadata_condition,
            ),
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
            "Queried KB: knowledge_base_id=%d, records=%d",
            knowledge_base_id,
            len(records),
        )

        return records

    def _build_retrieval_override_map(
        self,
        knowledge_base_ids: list[int],
        retrieval_overrides: list[RemoteKnowledgeBaseRetrievalOverride] | None,
    ) -> dict[int, RemoteKnowledgeBaseRetrievalOverride]:
        allowed_ids = set(knowledge_base_ids)
        overrides_by_kb_id: dict[int, RemoteKnowledgeBaseRetrievalOverride] = {}
        for override in retrieval_overrides or []:
            if override.knowledge_base_id not in allowed_ids:
                raise ValueError(
                    "knowledge_base_retrieval_overrides contains an unknown knowledge_base_id"
                )
            if override.knowledge_base_id in overrides_by_kb_id:
                raise ValueError(
                    "knowledge_base_retrieval_overrides contains duplicate knowledge_base_id entries"
                )
            overrides_by_kb_id[override.knowledge_base_id] = override
        return overrides_by_kb_id

    @staticmethod
    def _build_document_filter(document_ids: list[int] | None) -> dict[str, Any] | None:
        if not document_ids:
            return None

        return {
            "operator": "and",
            "conditions": [
                {
                    "key": "doc_ref",
                    "operator": "in",
                    "value": [str(doc_id) for doc_id in document_ids],
                }
            ],
        }

    @staticmethod
    def _combine_metadata_conditions(
        *conditions: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        normalized_conditions = [condition for condition in conditions if condition]
        if not normalized_conditions:
            return None
        if len(normalized_conditions) == 1:
            return normalized_conditions[0]
        return {
            "operator": "and",
            "conditions": normalized_conditions,
        }

    def _extract_document_id(self, record: dict[str, Any]) -> int | None:
        """Extract document ID from record metadata."""
        metadata = record.get("metadata") or {}
        doc_ref = metadata.get("doc_ref")
        if doc_ref and isinstance(doc_ref, str):
            try:
                if doc_ref.startswith("doc_"):
                    return int(doc_ref[4:])
                return int(doc_ref)
            except ValueError:
                pass
        return None

    def _estimate_tokens(self, text: str) -> int:
        """Estimate token count (~4 characters per token)."""
        return len(text) // 4
