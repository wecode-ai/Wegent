# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import asyncio
import logging
from typing import Any

from knowledge_engine.retrieval.hierarchical import (
    collect_parent_node_ids,
    merge_parent_records,
)
from knowledge_engine.retrieval.search_hints import resolve_search_queries
from shared.models import RetrievalScope, RuntimeRetrievalConfig, SearchHints

logger = logging.getLogger(__name__)


class QueryExecutor:
    """Backend-agnostic RAG query executor."""

    def __init__(self, *, storage_backend, embed_model) -> None:
        self.storage_backend = storage_backend
        self.embed_model = embed_model

    async def execute(
        self,
        *,
        knowledge_id: str,
        query: str,
        query_plan: dict[str, Any] | None = None,
        search_hints: SearchHints | dict[str, Any] | None = None,
        retrieval_config: RuntimeRetrievalConfig | dict[str, Any],
        scope: RetrievalScope | dict[str, Any] | None = None,
        metadata_condition: dict[str, Any] | None = None,
        user_id: int | None = None,
    ) -> dict[str, Any]:
        retrieval_setting = self._normalize_retrieval_setting(
            retrieval_config,
            query_plan=query_plan,
            search_hints=search_hints,
        )
        resolved_queries = resolve_search_queries(query, retrieval_setting)
        resolved_scope = self._normalize_scope(scope)
        self._ensure_retrieval_scope_supported(resolved_scope)
        logger.info(
            "[QueryExecutor] knowledge_id=%s, retrieval_mode=%s, hint_source=%s, hints_present=%s, dense_query=%s, sparse_query=%s",
            knowledge_id,
            retrieval_setting["retrieval_mode"],
            retrieval_setting.get("hint_source", "fallback"),
            "search_hints" in retrieval_setting,
            resolved_queries.dense_query,
            resolved_queries.sparse_query,
        )
        kwargs: dict[str, Any] = {}
        if user_id is not None:
            kwargs["user_id"] = user_id

        result = await asyncio.to_thread(
            self.storage_backend.retrieve,
            knowledge_id=knowledge_id,
            query=query,
            embed_model=self.embed_model,
            retrieval_setting=retrieval_setting,
            scope=resolved_scope,
            metadata_condition=metadata_condition,
            **kwargs,
        )
        return await self._merge_hierarchical_records(
            knowledge_id=knowledge_id,
            result=result,
            kwargs=kwargs,
        )

    @staticmethod
    def _normalize_retrieval_setting(
        retrieval_config: RuntimeRetrievalConfig | dict[str, Any],
        *,
        query_plan: dict[str, Any] | None = None,
        search_hints: SearchHints | dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        if isinstance(retrieval_config, RuntimeRetrievalConfig):
            config = retrieval_config.model_dump(exclude_none=True)
        else:
            config = dict(retrieval_config)

        retrieval_setting = {
            "top_k": config.get("top_k") or 20,
            "score_threshold": (
                config.get("score_threshold")
                if config.get("score_threshold") is not None
                else 0.7
            ),
            "retrieval_mode": config.get("retrieval_mode") or "vector",
        }
        if "vector_weight" in config:
            retrieval_setting["vector_weight"] = config["vector_weight"]
        if "keyword_weight" in config:
            retrieval_setting["keyword_weight"] = config["keyword_weight"]
        if query_plan is not None:
            for field in (
                "dense_query",
                "sparse_query",
                "keywords",
                "phrases",
                "hint_source",
            ):
                if field in query_plan:
                    retrieval_setting[field] = query_plan[field]
        if search_hints is not None:
            retrieval_setting["search_hints"] = (
                search_hints.model_dump(exclude_none=True)
                if isinstance(search_hints, SearchHints)
                else dict(search_hints)
            )
        return retrieval_setting

    @staticmethod
    def _normalize_scope(
        scope: RetrievalScope | dict[str, Any] | None,
    ) -> RetrievalScope | None:
        if scope is None or isinstance(scope, RetrievalScope):
            return scope
        return RetrievalScope.model_validate(scope)

    def _ensure_retrieval_scope_supported(
        self,
        scope: RetrievalScope | None,
    ) -> None:
        if not scope or not scope.document_ids:
            return

        if bool(getattr(self.storage_backend, "supports_retrieval_scope", False)):
            return

        raise ValueError(
            "Retrieval scope is not supported by this storage backend; "
            "document_ids would otherwise be ignored."
        )

    async def _merge_hierarchical_records(
        self,
        *,
        knowledge_id: str,
        result: dict[str, Any],
        kwargs: dict[str, Any],
    ) -> dict[str, Any]:
        records = result.get("records")
        if not isinstance(records, list) or not records:
            return result

        parent_node_ids = collect_parent_node_ids(records)
        if not parent_node_ids:
            return result

        parent_records = await asyncio.to_thread(
            self.storage_backend.get_parent_nodes,
            knowledge_id=knowledge_id,
            parent_node_ids=parent_node_ids,
            **kwargs,
        )
        if not parent_records:
            return result

        merged_result = dict(result)
        merged_result["records"] = merge_parent_records(records, parent_records)
        return merged_result
