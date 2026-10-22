# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Thread-safe execution path for knowledge searches."""

from __future__ import annotations

from functools import partial
from typing import Any, Literal

import anyio

from app.core.async_utils import run_in_threadpool_with_cleanup
from app.db.session import SessionLocal
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.rag import direct_injection
from app.services.rag.remote_gateway import RemoteRagGateway
from app.services.rag.runtime_resolver import RagRuntimeResolver
from shared.models import RetrievalScope, SearchHints
from shared.telemetry.decorators import trace_async


def _run_direct_injection_in_worker(runtime_spec: Any) -> dict[str, Any] | None:
    """Try direct injection inside a worker-owned Session."""

    async def inject(db: Any) -> dict[str, Any] | None:
        return await direct_injection.try_direct_injection_with_budget(
            knowledge_base_ids=runtime_spec.knowledge_base_ids,
            scope=runtime_spec.scope,
            db=db,
            route_mode=runtime_spec.route_mode,
            budget=runtime_spec.direct_injection_budget,
            metadata_condition=getattr(runtime_spec, "metadata_condition", None),
        )

    with SessionLocal() as db:
        return anyio.run(partial(inject, db))


class KnowledgeSearchRunner:
    """Run synchronous knowledge search work without sharing Sessions across threads."""

    async def retrieve(
        self,
        *,
        user_id: int,
        task_id: int | None,
        knowledge_base_id: int,
        query: str,
        max_results: int,
        document_ids: list[int] | None,
        folder_ids: list[int] | None,
        include_subfolders: bool,
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
            task_id=task_id,
            knowledge_base_id=knowledge_base_id,
            query=query,
            max_results=max_results,
            document_ids=document_ids,
            folder_ids=folder_ids,
            include_subfolders=include_subfolders,
            route_mode=route_mode,
            context_window=context_window,
            used_context_tokens=used_context_tokens,
            reserved_output_tokens=reserved_output_tokens,
            context_buffer_ratio=context_buffer_ratio,
            max_direct_chunks=max_direct_chunks,
            search_hints=search_hints,
        )
        if runtime_spec is None:
            return {
                "query": query,
                "knowledge_base_id": knowledge_base_id,
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            }

        result = await self._execute(runtime_spec, user_id=user_id, task_id=task_id)

        return {
            "query": query,
            "knowledge_base_id": knowledge_base_id,
            "mode": result.get("mode", "rag_retrieval"),
            "records": result.get("records", []),
            "total": result.get("total", 0),
            "total_estimated_tokens": result.get("total_estimated_tokens", 0),
        }

    @trace_async(
        span_name="rag.retrieve_with_routing",
        tracer_name="app.services.knowledge.search_execution",
    )
    async def _execute(
        self, runtime_spec: Any, *, user_id: int, task_id: int | None
    ) -> dict[str, Any]:
        """Resolve direct injection in the Backend, else retrieve remotely.

        Direct injection only reads the original documents from MySQL. Rejected
        injections and plain retrieval are executed by knowledge_runtime, which
        resolves the execution config of each knowledge base itself.
        """
        if getattr(runtime_spec, "route_mode", None) == "direct_injection":
            injection_result = await run_in_threadpool_with_cleanup(
                _run_direct_injection_in_worker, runtime_spec
            )
            if injection_result is not None:
                return injection_result
            runtime_spec = runtime_spec.model_copy(
                update={"route_mode": "rag_retrieval"}
            )

        if not runtime_spec.authorized_resources:
            authorized = await run_in_threadpool_with_cleanup(
                self._authorize_remote, runtime_spec, user_id=user_id, task_id=task_id
            )
            runtime_spec = runtime_spec.model_copy(
                update={"authorized_resources": authorized}
            )
        return await RemoteRagGateway().query(runtime_spec)

    @staticmethod
    def _authorize_remote(
        runtime_spec: Any, *, user_id: int, task_id: int | None
    ) -> list:
        """Check the caller and owner permissions in a worker-owned session."""
        with SessionLocal() as db:
            return RagRuntimeResolver().build_query_authorized_resources(
                db=db,
                knowledge_base_ids=runtime_spec.knowledge_base_ids,
                read_user_id=user_id,
                task_id=task_id,
            )

    @staticmethod
    def _prepare(
        *,
        user_id: int,
        task_id: int | None,
        knowledge_base_id: int,
        query: str,
        max_results: int,
        document_ids: list[int] | None,
        folder_ids: list[int] | None,
        include_subfolders: bool,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        context_window: int,
        used_context_tokens: int,
        reserved_output_tokens: int,
        context_buffer_ratio: float,
        max_direct_chunks: int,
        search_hints: SearchHints | None,
    ) -> Any | None:
        """Build the complete runtime specification inside one Session-owning worker."""
        with SessionLocal() as db:
            user = KnowledgeService.resolve_read_user_for_knowledge_base(
                db,
                user_id=user_id,
                task_id=task_id,
                knowledge_base_id=knowledge_base_id,
            )
            if user is None:
                raise ValueError("User not found")

            scope_specified = folder_ids is not None or document_ids is not None
            resolved_document_ids = document_ids
            if scope_specified:
                resolved_document_ids = (
                    KnowledgeFolderService.resolve_document_ids_for_scope(
                        db=db,
                        knowledge_base_id=knowledge_base_id,
                        user_id=user.id,
                        folder_ids=folder_ids,
                        document_ids=document_ids,
                        include_subfolders=include_subfolders,
                    )
                )
                if not resolved_document_ids:
                    return None

            knowledge_base, has_access = KnowledgeService.get_knowledge_base(
                db=db,
                knowledge_base_id=knowledge_base_id,
                user_id=user.id,
            )
            if knowledge_base is None:
                raise ValueError(f"Knowledge base {knowledge_base_id} not found")
            if not has_access:
                raise ValueError(f"Access denied to knowledge base {knowledge_base_id}")

            retrieval_config = (
                (knowledge_base.json or {}).get("spec", {}).get("retrievalConfig")
            )
            if not retrieval_config:
                raise ValueError(
                    f"Knowledge base {knowledge_base_id} has no RAG configuration"
                )
            if not retrieval_config.get("retriever_name") or not retrieval_config.get(
                "embedding_config"
            ):
                raise ValueError(
                    f"Knowledge base {knowledge_base_id} has incomplete RAG configuration"
                )

            scope = (
                RetrievalScope(document_ids=resolved_document_ids)
                if resolved_document_ids
                else None
            )
            resolver = RagRuntimeResolver()
            runtime_spec = resolver.build_query_runtime_spec(
                knowledge_base_ids=[knowledge_base_id],
                query=query,
                max_results=max_results,
                scope=scope,
                route_mode=route_mode,
                user_id=user.id,
                user_name=user.user_name,
                task_id=task_id,
                context_window=context_window,
                used_context_tokens=used_context_tokens,
                reserved_output_tokens=reserved_output_tokens,
                context_buffer_ratio=context_buffer_ratio,
                max_direct_chunks=max_direct_chunks,
                search_hints=search_hints,
                restricted_mode=False,
            )
            resolved_route_mode = direct_injection.decide_route_mode_for_chat_shell(
                query=query,
                knowledge_base_ids=[knowledge_base_id],
                db=db,
                route_mode=route_mode,
                scope=scope,
                metadata_condition=None,
                context_window=context_window,
                used_context_tokens=used_context_tokens,
                reserved_output_tokens=reserved_output_tokens,
                context_buffer_ratio=context_buffer_ratio,
                max_direct_chunks=max_direct_chunks,
            )
            runtime_spec = runtime_spec.model_copy(
                update={"route_mode": resolved_route_mode}
            )
            if (
                resolved_route_mode == "rag_retrieval"
                and not runtime_spec.authorized_resources
            ):
                runtime_spec = runtime_spec.model_copy(
                    update={
                        "authorized_resources": (
                            resolver.build_query_authorized_resources(
                                db=db,
                                knowledge_base_ids=[knowledge_base_id],
                                read_user_id=user.id,
                                task_id=task_id,
                            )
                        )
                    }
                )
            return runtime_spec


knowledge_search_runner = KnowledgeSearchRunner()
