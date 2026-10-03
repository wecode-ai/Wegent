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
from knowledge_runtime.services.config_loader import RuntimeConfigLoader
from knowledge_runtime.services.config_resolver import QueryConfig
from knowledge_runtime.services.query_planner import QueryPlan, QueryPlanner
from shared.knowledge_module import QueryTarget, query_documents
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteKnowledgeBaseRetrievalOverride,
    RemoteQueryRecord,
    RemoteQueryRequest,
    RemoteQueryResponse,
    RetrievalScope,
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
        retrieval_override_by_kb_id = self._build_retrieval_override_map(
            request.knowledge_base_ids,
            request.knowledge_base_retrieval_overrides,
        )
        authorized_by_kb_id = self._build_authorized_resources_map(
            request.knowledge_base_ids,
            request.authorized_resources,
        )
        resolved_scope = request.scope
        if resolved_scope is None and request.document_ids is not None:
            resolved_scope = RetrievalScope(document_ids=request.document_ids)
        configs_by_kb_id = self._config_loader.resolve_query_configs(
            knowledge_base_ids=request.knowledge_base_ids,
            user_id=request.user_id,
            authorized=authorized_by_kb_id,
            scope=resolved_scope,
            retrieval_overrides={
                knowledge_base_id: override.retrieval_config.model_dump(
                    exclude_unset=True
                )
                for knowledge_base_id, override in retrieval_override_by_kb_id.items()
            },
        )
        search_hints = self._search_hints_dict(request.search_hints)
        self._log_query_plan(plan, search_hints)

        targets = [
            self._build_query_target(
                knowledge_base_id,
                configs_by_kb_id[knowledge_base_id],
                self._planner.plan(
                    request.query,
                    request.search_hints,
                    qa_pair_count=configs_by_kb_id[knowledge_base_id].qa_pair_count,
                ),
            )
            for knowledge_base_id in request.knowledge_base_ids
            if configs_by_kb_id[knowledge_base_id].scoped_document_ids != []
        ]
        result = await query_documents(
            targets,
            query=plan.normalized_query,
            metadata_condition=request.metadata_condition,
            max_results=request.max_results,
        )
        records = [
            RemoteQueryRecord(
                content=record.get("content", ""),
                title=record.get("title", ""),
                score=record.get("score"),
                metadata=record.get("metadata"),
                knowledge_base_id=int(record["knowledge_id"]),
                document_id=record["document_id"],
            )
            for record in result["records"]
        ]
        logger.info(
            "Query result: query_mode=%s, total_records=%d, returned_records=%d",
            plan.hint_source,
            result["total"],
            len(records),
        )
        return RemoteQueryResponse(
            records=records,
            total=result["total"],
            total_estimated_tokens=result["total_estimated_tokens"],
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
            "Query request hints: hint_source=%s, normalized_query='%s...', "
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
    def _build_query_target(
        knowledge_base_id: int, config: QueryConfig, plan: QueryPlan
    ) -> QueryTarget:
        """Supply execution dependencies after the config session has closed."""
        storage = create_storage_backend_from_runtime_config(config.retriever_config)
        embedding = create_embedding_model_from_runtime_config(
            config.embedding_model_config
        )
        return QueryTarget(
            KnowledgeQueryExecutor(storage_backend=storage, embed_model=embedding),
            str(knowledge_base_id),
            config.retrieval_config,
            config.index_owner_user_id,
            document_ids=config.scoped_document_ids,
            query_plan={
                "dense_query": plan.dense_query,
                "sparse_query": plan.sparse_query,
                "keywords": plan.keywords,
                "phrases": plan.phrases,
                "hint_source": plan.hint_source,
            },
        )

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
                    "knowledge_base_retrieval_overrides contains an unknown "
                    "knowledge_base_id"
                )
            if override.knowledge_base_id in overrides_by_kb_id:
                raise ValueError(
                    "knowledge_base_retrieval_overrides contains duplicate "
                    "knowledge_base_id entries"
                )
            overrides_by_kb_id[override.knowledge_base_id] = override
        return overrides_by_kb_id

    @staticmethod
    def _build_authorized_resources_map(
        knowledge_base_ids: list[int],
        authorized_resources: list[RemoteAuthorizedRetrievalResources] | None,
    ) -> dict[int, RemoteAuthorizedRetrievalResources]:
        """Index the authorized retrieval resources by knowledge base ID."""
        authorized_by_kb_id: dict[int, RemoteAuthorizedRetrievalResources] = {}
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
