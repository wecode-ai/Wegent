# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retrieval service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import logging
from typing import Any, Dict, List, Literal, Optional

from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.services.rag import direct_injection
from app.services.rag.document_id_utils import extract_document_id
from app.services.rag.runtime_resolver import RagRuntimeResolver
from knowledge_engine.embedding import create_embedding_model_from_runtime_config
from knowledge_engine.query import QueryExecutor
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import RemoteKnowledgeBaseQueryConfig, RetrievalScope, SearchHints
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

logger = logging.getLogger(__name__)


class RetrievalService:
    """
    High-level retrieval service.
    Owns Backend-side routing and permission-aware retrieval orchestration.
    """

    def __init__(self):
        """Initialize retrieval service."""
        self.runtime_resolver = RagRuntimeResolver()

    async def _do_rag_retrieval(
        self,
        query: str,
        search_hints: SearchHints | None,
        knowledge_base_ids: list[int],
        db: Session,
        max_results: int,
        scope: RetrievalScope | None,
        metadata_condition: Optional[Dict[str, Any]],
        knowledge_base_configs: Optional[list[RemoteKnowledgeBaseQueryConfig]],
        user_name: Optional[str],
    ) -> Dict[str, Any]:
        """Perform RAG retrieval across knowledge bases."""
        runtime_config_by_kb_id = {
            config.knowledge_base_id: config for config in knowledge_base_configs or []
        }
        records: list[Dict[str, Any]] = []

        for kb_id in knowledge_base_ids:
            result = await self.retrieve_from_knowledge_base_internal(
                query=query,
                search_hints=search_hints,
                knowledge_base_id=kb_id,
                db=db,
                scope=scope,
                metadata_condition=metadata_condition,
                user_name=user_name,
                knowledge_base_config=runtime_config_by_kb_id.get(kb_id),
            )
            kb_records = result.get("records", [])[:max_results]
            for record in kb_records:
                metadata = record.get("metadata") or {}
                records.append(
                    {
                        "content": record.get("content", ""),
                        "score": record.get("score", 0.0),
                        "title": record.get("title", "Unknown"),
                        "metadata": metadata,
                        "knowledge_base_id": kb_id,
                        "document_id": extract_document_id(record),
                    }
                )
        records.sort(key=lambda x: x.get("score", 0.0) or 0.0, reverse=True)
        records = records[:max_results]

        set_span_attribute("rag.final_mode", "rag_retrieval")
        return {
            "mode": "rag_retrieval",
            "records": records,
            "total": len(records),
            "total_estimated_tokens": 0,
        }

    @trace_async(
        span_name="rag.retrieve_with_routing",
        tracer_name="backend.services.rag",
    )
    async def retrieve_with_routing(
        self,
        query: str,
        knowledge_base_ids: list[int],
        db: Session,
        search_hints: SearchHints | None = None,
        max_results: int = 5,
        scope: RetrievalScope | None = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        knowledge_base_configs: Optional[list[RemoteKnowledgeBaseQueryConfig]] = None,
        user_name: Optional[str] = None,
        context_window: Optional[int] = None,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto",
        user_id: Optional[int] = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = direct_injection.CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS,
        restricted_mode: bool = False,
    ) -> Dict[str, Any]:
        """Retrieve knowledge with automatic routing between direct injection and RAG.

        This method centralizes the routing decision: whether to fetch all chunks
        for direct injection, or perform regular RAG retrieval based on context
        window capacity and content size.

        Args:
            query: Search query text.
            knowledge_base_ids: List of knowledge base IDs to search.
            db: Database session.
            search_hints: Optional retrieval hints for sparse/dense query shaping.
            max_results: Maximum number of results to return per KB.
            scope: Optional domain retrieval scope.
            metadata_condition: Optional metadata filtering conditions.
            knowledge_base_configs: Optional pre-built KB runtime configs.
            user_name: User name for embedding API headers.
            context_window: Model context window size for routing decision.
            route_mode: Routing strategy - "auto", "direct_injection", or "rag_retrieval".
            user_id: User ID for restricted mode checks.
            used_context_tokens: Tokens already used in conversation.
            reserved_output_tokens: Tokens reserved for model output.
            context_buffer_ratio: Safety buffer ratio for context.
            max_direct_chunks: Maximum chunks allowed for direct injection.
            restricted_mode: Whether to apply restricted search policies.

        Returns:
            Dict with mode, records, total count, and estimated tokens.
        """
        del user_id, restricted_mode  # Reserved for future use

        set_span_attribute("rag.route_mode", route_mode)
        set_span_attribute("rag.kb_count", len(knowledge_base_ids))
        set_span_attribute(
            "rag.document_filter_count",
            len(scope.document_ids if scope and scope.document_ids else []),
        )

        # === Early check: empty knowledge base list ===
        if not knowledge_base_ids:
            set_span_attribute("rag.final_mode", "rag_retrieval")
            add_span_event("rag.routing.empty_request")
            return {
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            }

        # === Metadata filter remains independent from domain retrieval scope ===
        combined_metadata_condition = metadata_condition
        metadata_requires_rag = metadata_condition is not None

        # === Metadata filter requires RAG ===
        if metadata_requires_rag:
            logger.info(
                "[RAG] metadata_condition requires rag_retrieval; skipping direct injection"
            )
            return await self._do_rag_retrieval(
                query=query,
                search_hints=search_hints,
                knowledge_base_ids=knowledge_base_ids,
                db=db,
                max_results=max_results,
                scope=scope,
                metadata_condition=combined_metadata_condition,
                knowledge_base_configs=knowledge_base_configs,
                user_name=user_name,
            )

        # === Check if auto direct injection is disabled ===
        auto_direct_injection_disabled = (
            route_mode == "auto"
            and direct_injection.should_disable_auto_direct_injection()
        )
        if auto_direct_injection_disabled:
            logger.info(
                "[RAG] auto direct injection disabled by config; using rag_retrieval"
            )

        available_injection_tokens = (
            direct_injection.calculate_available_injection_tokens(
                context_window=context_window,
                used_context_tokens=used_context_tokens,
                reserved_output_tokens=reserved_output_tokens,
                context_buffer_ratio=context_buffer_ratio,
            )
        )

        # === Estimate tokens and decide if direct injection should be attempted ===
        total_estimated_tokens = 0
        if route_mode == "auto" and not auto_direct_injection_disabled:
            total_estimated_tokens = (
                direct_injection.estimate_total_tokens_for_knowledge_bases(
                    db=db,
                    knowledge_base_ids=knowledge_base_ids,
                    document_ids=scope.document_ids if scope else None,
                )
            )

        use_direct_injection = (
            False
            if auto_direct_injection_disabled
            else direct_injection.should_use_direct_injection(
                available_injection_tokens=available_injection_tokens,
                total_estimated_tokens=total_estimated_tokens,
                route_mode=route_mode,
            )
        )

        add_span_event(
            "rag.routing.candidate_evaluated",
            {
                "route_mode": route_mode,
                "estimated_tokens": total_estimated_tokens,
                "direct_candidate": use_direct_injection,
            },
        )

        logger.info(
            "[RAG] chat_shell routing: kb_count=%d, route_mode=%s, context_window=%s, "
            "estimated_tokens=%d, used_context_tokens=%d, reserved_output_tokens=%d, "
            "context_buffer_ratio=%.2f, available_injection_tokens=%s, direct_candidate=%s",
            len(knowledge_base_ids),
            route_mode,
            context_window,
            total_estimated_tokens,
            used_context_tokens,
            reserved_output_tokens,
            context_buffer_ratio,
            available_injection_tokens,
            use_direct_injection,
        )

        # === Try direct injection ===
        if use_direct_injection:
            result = await direct_injection.try_direct_injection(
                knowledge_base_ids=knowledge_base_ids,
                scope=scope,
                db=db,
                route_mode=route_mode,
                available_injection_tokens=available_injection_tokens,
                max_direct_chunks=max_direct_chunks,
            )
            if result:
                return result
            # Fall through to RAG retrieval

        # === RAG retrieval ===
        return await self._do_rag_retrieval(
            query=query,
            search_hints=search_hints,
            knowledge_base_ids=knowledge_base_ids,
            db=db,
            max_results=max_results,
            scope=scope,
            metadata_condition=combined_metadata_condition,
            knowledge_base_configs=knowledge_base_configs,
            user_name=user_name,
        )

    async def retrieve_from_knowledge_base_internal(
        self,
        query: str,
        knowledge_base_id: int,
        db: Session,
        search_hints: SearchHints | None = None,
        scope: RetrievalScope | None = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
        knowledge_base_config: Optional[RemoteKnowledgeBaseQueryConfig] = None,
    ) -> Dict:
        """
        Internal method to retrieve from knowledge base without user permission check.

        This method is used by tools (e.g., KnowledgeBaseTool) in scenarios where
        permission has already been validated at a higher level (e.g., task-level access).

        ⚠️ WARNING: This method bypasses user permission checks. Only use when:
        - Permission is validated at task/team level
        - Knowledge base is shared within a group/task context

        Args:
            query: Search query
            knowledge_base_id: Knowledge base ID
            db: Database session
            search_hints: Optional retrieval hints for sparse/dense query shaping.
            metadata_condition: Optional metadata filtering conditions
            user_name: User name for placeholder replacement in embedding headers

        Returns:
            Dict with retrieval results in Dify-compatible format

        Raises:
            ValueError: If knowledge base not found or configuration invalid
        """
        from app.models.kind import Kind

        # Get knowledge base directly without permission check
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
            raise ValueError(f"Knowledge base {knowledge_base_id} not found")

        return await self._retrieve_from_kb_internal(
            query=query,
            search_hints=search_hints,
            kb=kb,
            db=db,
            scope=scope,
            metadata_condition=metadata_condition,
            user_name=user_name,
            knowledge_base_config=knowledge_base_config,
        )

    async def _retrieve_from_kb_internal(
        self,
        query: str,
        kb: Kind,
        db: Session,
        search_hints: SearchHints | None = None,
        scope: RetrievalScope | None = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
        knowledge_base_config: Optional[RemoteKnowledgeBaseQueryConfig] = None,
    ) -> Dict:
        """
        Internal helper method to perform retrieval from a knowledge base.

        Args:
            query: Search query
            kb: Knowledge base Kind instance
            db: Database session
            search_hints: Optional retrieval hints for sparse/dense query shaping.
            metadata_condition: Optional metadata filtering conditions
            user_name: User name for placeholder replacement in embedding headers (optional)

        Returns:
            Dict with retrieval results

        Raises:
            ValueError: If configuration is invalid
        """
        resolved_config = knowledge_base_config or self._build_runtime_query_config(
            kb=kb,
            db=db,
            user_name=user_name,
        )
        retrieval_config = resolved_config.retrieval_config
        retrieval_mode = (
            retrieval_config.get("retrieval_mode")
            if isinstance(retrieval_config, dict)
            else getattr(retrieval_config, "retrieval_mode", None)
        )
        query_plan = (
            self._build_qa_query_plan(
                db=db,
                knowledge_base_id=kb.id,
                scope=scope,
            )
            if retrieval_mode == "vector"
            else None
        )
        result = await self._execute_runtime_query(
            query=query,
            search_hints=search_hints,
            query_plan=query_plan,
            knowledge_base_config=resolved_config,
            scope=scope,
            metadata_condition=metadata_condition,
        )

        # Log detailed retrieval results for debugging
        records = result.get("records", [])
        total_content_chars = sum(len(r.get("content", "")) for r in records)
        total_content_kb = total_content_chars / 1024
        total_content_mb = total_content_kb / 1024

        logger.info(
            f"[RAG] Retrieved {len(records)} records from KB {kb.id} (name={kb.name}), "
            f"total_size={total_content_chars} chars ({total_content_kb:.2f}KB / {total_content_mb:.4f}MB), "
            f"query={query[:50]}..."
        )

        # Log individual record details for debugging
        if records:
            for i, r in enumerate(records[:5]):  # Log first 5 records
                content_len = len(r.get("content", ""))
                score = r.get("score", 0)
                title = r.get("title", "Unknown")[:50]
                logger.debug(
                    f"[RAG] Record[{i}]: score={score:.4f}, size={content_len} chars, title={title}"
                )

        return result

    def _build_runtime_query_config(
        self,
        *,
        kb: Kind,
        db: Session,
        user_name: Optional[str] = None,
    ) -> RemoteKnowledgeBaseQueryConfig:
        configs = self.runtime_resolver.build_query_knowledge_base_configs(
            db=db,
            knowledge_base_ids=[kb.id],
            user_name=user_name,
        )
        if not configs:
            raise ValueError(
                f"Failed to resolve runtime config for knowledge base {kb.id}"
            )
        return configs[0]

    async def _execute_runtime_query(
        self,
        *,
        query: str,
        search_hints: SearchHints | None = None,
        query_plan: dict[str, Any] | None = None,
        knowledge_base_config: RemoteKnowledgeBaseQueryConfig,
        scope: RetrievalScope | None = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute a single knowledge query with optional retrieval hints."""
        storage_backend = create_storage_backend_from_runtime_config(
            knowledge_base_config.retriever_config
        )
        embed_model = create_embedding_model_from_runtime_config(
            knowledge_base_config.embedding_model_config
        )
        executor = QueryExecutor(
            storage_backend=storage_backend,
            embed_model=embed_model,
        )
        return await executor.execute(
            knowledge_id=str(knowledge_base_config.knowledge_base_id),
            query=query,
            query_plan=query_plan,
            search_hints=search_hints,
            retrieval_config=knowledge_base_config.retrieval_config,
            scope=scope,
            metadata_condition=metadata_condition,
            user_id=knowledge_base_config.index_owner_user_id,
        )

    @staticmethod
    def _build_qa_query_plan(
        *,
        db: Session,
        knowledge_base_id: int,
        scope: RetrievalScope | None = None,
    ) -> dict[str, Any] | None:
        from sqlalchemy import Integer, case, cast, func

        from app.models.knowledge import KnowledgeDocument

        bind = db.get_bind()
        dialect_name = bind.dialect.name if bind is not None else None
        if dialect_name == "mysql":
            splitter_subtype = func.json_unquote(
                func.json_extract(KnowledgeDocument.chunks, "$.splitter_subtype")
            )
            qa_pair_count_value = func.json_unquote(
                func.json_extract(KnowledgeDocument.chunks, "$.qa_pair_count")
            )
        elif dialect_name == "sqlite":
            splitter_subtype = func.json_extract(
                KnowledgeDocument.chunks, "$.splitter_subtype"
            )
            qa_pair_count_value = func.json_extract(
                KnowledgeDocument.chunks, "$.qa_pair_count"
            )
        else:
            return None

        qa_pair_count_expr = cast(qa_pair_count_value, Integer)
        query = db.query(
            func.coalesce(
                func.sum(
                    case(
                        (splitter_subtype == "qa_pair", qa_pair_count_expr),
                        else_=0,
                    )
                ),
                0,
            )
        ).select_from(KnowledgeDocument)
        query = query.filter(
            KnowledgeDocument.kind_id == knowledge_base_id,
            KnowledgeDocument.is_active.is_(True),
        )
        if scope and scope.document_ids:
            query = query.filter(KnowledgeDocument.id.in_(scope.document_ids))

        qa_pair_count = int(query.scalar() or 0)

        if qa_pair_count <= 0:
            return None

        return {
            "retrieval_profile": "qa_pair",
            "qa_pair_count": qa_pair_count,
        }

    async def get_all_chunks_from_knowledge_base(
        self,
        knowledge_base_id: int,
        db: Session,
        user_id: int,
        max_chunks: int = 10000,
        query: Optional[str] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """Get all chunks from a knowledge base with permission check.

        This method is used for smart context injection where we need all
        chunks from a knowledge base to determine if direct injection is possible.

        Uses gateway (local or remote based on RAG_RUNTIME_MODE) instead of
        directly accessing storage backend, enabling proper architecture separation.

        Args:
            knowledge_base_id: Knowledge base ID
            db: Database session
            user_id: User ID for permission check
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            query: Optional query string for logging purposes
            metadata_condition: Optional metadata filter conditions

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata

        Raises:
            ValueError: If knowledge base not found, access denied, or configuration invalid
        """
        from app.services.rag.gateway_factory import get_list_chunks_gateway
        from app.services.rag.runtime_resolver import RagRuntimeResolver

        # Build runtime spec via resolver
        runtime_resolver = RagRuntimeResolver()
        spec = runtime_resolver.build_public_list_chunks_runtime_spec(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
            user_name=None,
            max_chunks=max_chunks,
            query=query,
            metadata_condition=metadata_condition,
        )

        query_log = f", query={query[:50]}..." if query else ""
        logger.info(
            "[RAG] get_all_chunks start: kb_id=%s, max_chunks=%s%s",
            knowledge_base_id,
            max_chunks,
            query_log,
        )

        # Use gateway to get chunks (supports local and remote modes)
        rag_gateway = get_list_chunks_gateway()
        result = await rag_gateway.list_chunks(spec, db=db)

        chunks = result.get("chunks", [])
        total = result.get("total", 0)

        logger.info(
            "[RAG] get_all_chunks completed: kb_id=%s, chunk_count=%s%s",
            knowledge_base_id,
            total,
            query_log,
        )
        if not chunks:
            logger.warning(
                "[RAG] get_all_chunks returned empty result: kb_id=%s%s",
                knowledge_base_id,
                query_log,
            )

        # Convert RemoteListChunkRecord to dict format for backward compatibility
        return [
            {
                "content": chunk.get("content", ""),
                "title": chunk.get("title", ""),
                "chunk_id": chunk.get("chunk_id"),
                "doc_ref": chunk.get("doc_ref"),
                "metadata": chunk.get("metadata"),
            }
            for chunk in chunks
        ]


# Backward compatibility alias
retrieve_for_chat_shell = RetrievalService.retrieve_with_routing
