# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Query execution service for RAG retrieval operations."""

from __future__ import annotations

import logging
from typing import Any, TypeVar

from knowledge_engine.embedding.factory import (
    create_embedding_model_from_runtime_config,
)
from knowledge_engine.query.executor import QueryExecutor as KnowledgeQueryExecutor
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import QueryConfig
from knowledge_runtime.services.query_planner import QueryPlan, QueryPlanner
from shared.models import (
    RemoteKnowledgeBaseRetrievalOverride,
    RemoteQueryAuthorizedResources,
    RemoteQueryExplicitResources,
    RemoteQueryRecord,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RetrievalScope,
)

logger = logging.getLogger(__name__)

T = TypeVar("T")


class QueryExecutor:
    """Executes RAG query operations.

    This executor:
    1. Resolves configs for each knowledge base from the database
    2. Creates storage backends and embedding models for each KB
    3. Executes queries against each KB
    4. Aggregates and sorts results by score
    """

    def __init__(
        self,
        config_loader: RuntimeConfigLoader | None = None,
        planner: QueryPlanner | None = None,
    ) -> None:
        self._config_loader = config_loader or RuntimeConfigLoader()
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
        authorized_by_kb_id = self._build_authorized_resources_map(
            request.knowledge_base_ids,
            request.authorized_resources,
        )
        explicit_resources_by_kb_id = self._build_explicit_resources_map(
            request.knowledge_base_ids,
            request.explicit_resources,
        )
        configs_by_kb_id = self._config_loader.resolve_query_configs(
            knowledge_base_ids=request.knowledge_base_ids,
            user_id=request.user_id,
            authorized=authorized_by_kb_id,
            retrieval_overrides={
                knowledge_base_id: override.retrieval_config.model_dump(
                    exclude_unset=True
                )
                for knowledge_base_id, override in retrieval_override_by_kb_id.items()
            },
            explicit_resources=explicit_resources_by_kb_id,
        )
        search_hints = self._search_hints_dict(request.search_hints)
        self._log_query_plan(plan, search_hints)

        # Query each knowledge base after config loading has closed its DB session.
        for knowledge_base_id in request.knowledge_base_ids:
            records = await self._query_knowledge_base(
                request=request,
                knowledge_base_id=knowledge_base_id,
                config=configs_by_kb_id[knowledge_base_id],
                plan=plan,
            )
            all_records.extend(records)

        # Sort by score (descending) and limit to max_results
        all_records.sort(key=lambda r: r.score or 0, reverse=True)
        limited_records = all_records[: request.max_results]

        # Calculate total estimated tokens (rough estimate)
        total_tokens = sum(
            self._estimate_tokens(record.content) for record in limited_records
        )
        self._log_query_result(plan, all_records, limited_records)

        return RemoteQueryResponse(
            records=limited_records,
            total=len(all_records),
            total_estimated_tokens=total_tokens,
        )

    @staticmethod
    def _search_hints_dict(
        search_hints: Any,
    ) -> dict[str, Any]:
        """Normalize optional search hints to a plain mapping."""
        if search_hints is None:
            return {}
        if isinstance(search_hints, dict):
            return dict(search_hints)
        return search_hints.model_dump(exclude_none=True)

    @staticmethod
    def _log_query_plan(plan: QueryPlan, search_hints: dict[str, Any]) -> None:
        logger.info(
            "Query request: hint_source=%s, normalized_query='%s...', "
            "dense_query='%s...', sparse_query='%s...', hints_present=%s, "
            "semantic_query=%s, keywords=%s, phrases=%s",
            plan.hint_source,
            plan.normalized_query[:50],
            plan.dense_query[:50],
            plan.sparse_query[:50],
            bool(search_hints),
            bool(search_hints.get("semantic_query")),
            len(search_hints.get("keywords") or []),
            len(search_hints.get("phrases") or []),
        )

    @staticmethod
    def _log_query_result(
        plan: QueryPlan,
        all_records: list[RemoteQueryRecord],
        limited_records: list[RemoteQueryRecord],
    ) -> None:
        logger.info(
            "Query complete: hint_source=%s, normalized_query='%s...', "
            "total_results=%d, returned=%d",
            plan.hint_source,
            plan.normalized_query[:50],
            len(all_records),
            len(limited_records),
        )

    async def _query_knowledge_base(
        self,
        request: RemoteQueryRequest,
        knowledge_base_id: int,
        config: QueryConfig,
        plan: QueryPlan,
    ) -> list[RemoteQueryRecord]:
        """Query a single knowledge base.

        Args:
            request: The original query request.
            knowledge_base_id: ID of the knowledge base to query.

        Returns:
            List of records from this knowledge base.
        """
        # Create storage backend and embedding model
        storage_backend = create_storage_backend_from_runtime_config(
            config.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            config.embedding_model_config
        )
        storage_type = config.retriever_config.storage_config.get("type", "unknown")

        logger.info(
            "Query KB config: knowledge_base_id=%d, config_source=%s, "
            "storage_type=%s, retrieval_mode=%s, top_k=%s, "
            "score_threshold=%s, vector_weight=%s, keyword_weight=%s",
            knowledge_base_id,
            "module_resolved",
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
        resolved_scope = request.scope
        if resolved_scope is None and request.document_ids is not None:
            resolved_scope = RetrievalScope(document_ids=request.document_ids)
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
            scope=resolved_scope,
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
        return self._index_by_knowledge_base_id(
            retrieval_overrides,
            knowledge_base_ids=knowledge_base_ids,
            label="knowledge_base_retrieval_overrides",
        )

    @staticmethod
    def _build_explicit_resources_map(
        knowledge_base_ids: list[int],
        explicit_resources: list[RemoteQueryExplicitResources] | None,
    ) -> dict[int, RemoteQueryExplicitResources]:
        """Index the caller's explicit resource selection by knowledge base ID."""
        return QueryExecutor._index_by_knowledge_base_id(
            explicit_resources,
            knowledge_base_ids=knowledge_base_ids,
            label="explicit_resources",
        )

    @staticmethod
    def _index_by_knowledge_base_id(
        entries: list[T] | None,
        *,
        knowledge_base_ids: list[int],
        label: str,
    ) -> dict[int, T]:
        """Index protocol entries, rejecting unknown or duplicate knowledge base ids."""
        allowed_ids = set(knowledge_base_ids)
        indexed: dict[int, T] = {}
        for entry in entries or []:
            if entry.knowledge_base_id not in allowed_ids:
                raise ValueError(f"{label} contains an unknown knowledge_base_id")
            if entry.knowledge_base_id in indexed:
                raise ValueError(
                    f"{label} contains duplicate knowledge_base_id entries"
                )
            indexed[entry.knowledge_base_id] = entry
        return indexed

    @staticmethod
    def _build_authorized_resources_map(
        knowledge_base_ids: list[int],
        authorized_resources: list[RemoteQueryAuthorizedResources] | None,
    ) -> dict[int, RemoteQueryAuthorizedResources]:
        """Index the authorized retrieval resources by knowledge base ID."""
        authorized_by_kb_id: dict[int, RemoteQueryAuthorizedResources] = {}
        for entry in authorized_resources or []:
            if entry.knowledge_base_id in authorized_by_kb_id:
                raise ValueError(
                    "authorized_resources contains duplicate knowledge_base_id entries"
                )
            authorized_by_kb_id[entry.knowledge_base_id] = entry

        missing = [
            knowledge_base_id
            for knowledge_base_id in knowledge_base_ids
            if knowledge_base_id not in authorized_by_kb_id
        ]
        if missing:
            raise ValueError(
                "query requires authorized retrieval resources for knowledge "
                f"bases {missing}"
            )
        return authorized_by_kb_id

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
