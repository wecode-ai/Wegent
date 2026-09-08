# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Thread-safe execution path for knowledge searches."""

from __future__ import annotations

import logging
from functools import partial
from typing import Any, Literal

import anyio

from app.core.async_utils import run_in_threadpool_with_cleanup
from app.db.session import SessionLocal
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.rag.gateway_factory import get_query_gateway
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import (
    RemoteRagGatewayError,
    should_fallback_to_local,
)
from app.services.rag.retrieval_service import RetrievalService
from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.models import RetrievalScope, SearchHints

logger = logging.getLogger(__name__)


class KnowledgeSearchRunner:
    """Run synchronous knowledge search work without sharing Sessions across threads."""

    async def retrieve(
        self,
        *,
        user_id: int,
        user_name: str | None,
        knowledge_base_id: int,
        query: str,
        max_results: int,
        document_ids: list[int] | None,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        context_window: int,
        used_context_tokens: int,
        reserved_output_tokens: int,
        context_buffer_ratio: float,
        max_direct_chunks: int,
        search_hints: SearchHints | None,
    ) -> dict[str, Any]:
        """Prepare and execute a search using worker-owned database Sessions."""
        runtime_spec = await run_in_threadpool_with_cleanup(
            self._prepare,
            user_id=user_id,
            user_name=user_name,
            knowledge_base_id=knowledge_base_id,
            query=query,
            max_results=max_results,
            document_ids=document_ids,
            route_mode=route_mode,
            context_window=context_window,
            used_context_tokens=used_context_tokens,
            reserved_output_tokens=reserved_output_tokens,
            context_buffer_ratio=context_buffer_ratio,
            max_direct_chunks=max_direct_chunks,
            search_hints=search_hints,
        )

        gateway = get_query_gateway()
        if isinstance(gateway, LocalRagGateway):
            result = await self._query_local(runtime_spec)
        else:
            try:
                result = await gateway.query(runtime_spec)
            except RemoteRagGatewayError as exc:
                if not should_fallback_to_local(exc):
                    raise
                logger.warning(
                    "[KnowledgeSearch] Remote query failed for KB %s; falling back: %s",
                    knowledge_base_id,
                    exc,
                )
                result = await self._query_local(runtime_spec)

        return {
            "query": query,
            "knowledge_base_id": knowledge_base_id,
            "mode": result.get("mode", "rag_retrieval"),
            "records": result.get("records", []),
            "total": result.get("total", 0),
            "total_estimated_tokens": result.get("total_estimated_tokens", 0),
        }

    @staticmethod
    def _prepare(**kwargs: Any) -> Any:
        """Build the complete runtime specification inside one Session-owning worker."""
        with SessionLocal() as db:
            knowledge_base, has_access = KnowledgeService.get_knowledge_base(
                db=db,
                knowledge_base_id=kwargs["knowledge_base_id"],
                user_id=kwargs["user_id"],
            )
            if knowledge_base is None:
                raise ValueError(
                    f"Knowledge base {kwargs['knowledge_base_id']} not found"
                )
            if not has_access:
                raise ValueError(
                    f"Access denied to knowledge base {kwargs['knowledge_base_id']}"
                )

            retrieval_config = (
                (knowledge_base.json or {}).get("spec", {}).get("retrievalConfig")
            )
            if not retrieval_config:
                raise ValueError(
                    f"Knowledge base {kwargs['knowledge_base_id']} has no RAG configuration"
                )
            if not retrieval_config.get("retriever_name") or not retrieval_config.get(
                "embedding_config"
            ):
                raise ValueError(
                    f"Knowledge base {kwargs['knowledge_base_id']} has incomplete RAG configuration"
                )

            scope = (
                RetrievalScope(document_ids=kwargs["document_ids"])
                if kwargs["document_ids"]
                else None
            )
            resolver = RagRuntimeResolver()
            runtime_spec = resolver.build_query_runtime_spec(
                db=db,
                knowledge_base_ids=[kwargs["knowledge_base_id"]],
                query=kwargs["query"],
                max_results=kwargs["max_results"],
                scope=scope,
                route_mode=kwargs["route_mode"],
                user_id=kwargs["user_id"],
                user_name=kwargs["user_name"],
                context_window=kwargs["context_window"],
                used_context_tokens=kwargs["used_context_tokens"],
                reserved_output_tokens=kwargs["reserved_output_tokens"],
                context_buffer_ratio=kwargs["context_buffer_ratio"],
                max_direct_chunks=kwargs["max_direct_chunks"],
                search_hints=kwargs["search_hints"],
                restricted_mode=False,
            )
            resolved_route_mode = RetrievalService().decide_route_mode_for_chat_shell(
                query=kwargs["query"],
                knowledge_base_ids=[kwargs["knowledge_base_id"]],
                db=db,
                route_mode=kwargs["route_mode"],
                scope=scope,
                metadata_condition=None,
                context_window=kwargs["context_window"],
                used_context_tokens=kwargs["used_context_tokens"],
                reserved_output_tokens=kwargs["reserved_output_tokens"],
                context_buffer_ratio=kwargs["context_buffer_ratio"],
                max_direct_chunks=kwargs["max_direct_chunks"],
            )
            runtime_spec = runtime_spec.model_copy(
                update={"route_mode": resolved_route_mode}
            )
            if resolved_route_mode == "rag_retrieval":
                runtime_spec = runtime_spec.model_copy(
                    update={
                        "knowledge_base_configs": resolver.build_query_knowledge_base_configs(
                            db=db,
                            knowledge_base_ids=[kwargs["knowledge_base_id"]],
                            user_name=kwargs["user_name"],
                        )
                    }
                )
            return runtime_spec

    @staticmethod
    def _query_local_sync(runtime_spec: Any) -> dict[str, Any]:
        """Execute local RAG and close its Session in the same worker thread."""
        with SessionLocal() as db:
            return anyio.run(partial(LocalRagGateway().query, runtime_spec, db=db))

    async def _query_local(self, runtime_spec: Any) -> dict[str, Any]:
        return await run_in_threadpool_with_cleanup(
            self._query_local_sync, runtime_spec
        )


knowledge_search_runner = KnowledgeSearchRunner()
