# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Retrieval service for RAG functionality.
Refactored to use modular architecture with pluggable storage backends.
"""

import asyncio
import logging
from typing import Any, Dict, List, Literal, Optional

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.services.rag.runtime_resolver import RagRuntimeResolver
from knowledge_engine.embedding import create_embedding_model_from_runtime_config
from knowledge_engine.query import QueryExecutor
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from shared.models import RemoteKnowledgeBaseQueryConfig
from shared.telemetry.decorators import add_span_event, set_span_attribute, trace_async

logger = logging.getLogger(__name__)

CHAT_SHELL_DIRECT_INJECTION_RATIO = 0.3
CHAT_SHELL_MAX_ALL_CHUNKS = 10000
CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS = 500
CHAT_SHELL_DIRECT_INJECTION_FORMATTING_OVERHEAD = 50
CHAT_SHELL_DIRECT_INJECTION_CHARS_PER_TOKEN = 4


class RetrievalService:
    """
    High-level retrieval service.
    Owns Backend-side routing and permission-aware retrieval orchestration.
    """

    def __init__(self):
        """Initialize retrieval service."""
        self.runtime_resolver = RagRuntimeResolver()

    @staticmethod
    def _build_document_filter(document_ids: Optional[list[int]]) -> Optional[Dict]:
        """Build metadata filter for restricting retrieval to specific documents."""
        if not document_ids:
            return None

        doc_refs = [str(doc_id) for doc_id in document_ids]
        return {
            "operator": "and",
            "conditions": [
                {
                    "key": "doc_ref",
                    "operator": "in",
                    "value": doc_refs,
                }
            ],
        }

    @staticmethod
    def _combine_metadata_conditions(
        *conditions: Optional[Dict[str, Any]],
    ) -> Optional[Dict[str, Any]]:
        normalized_conditions = [condition for condition in conditions if condition]
        if not normalized_conditions:
            return None
        if len(normalized_conditions) == 1:
            return normalized_conditions[0]
        return {
            "operator": "and",
            "conditions": normalized_conditions,
        }

    @staticmethod
    def _estimate_total_tokens_for_knowledge_bases(
        db: Session,
        knowledge_base_ids: list[int],
        document_ids: Optional[list[int]] = None,
    ) -> int:
        """Estimate aggregate KB token usage using the existing text-length heuristic.

        This estimate is intentionally coarse. It is only used for the first-pass
        auto-routing decision, while the final direct-injection decision is still
        protected by `_can_finalize_direct_injection()` with runtime chunk-count
        and context-budget checks.

        We keep the long-standing `text_length * 1.5` heuristic here to stay
        aligned with `/kb-size` and avoid introducing a heavier tokenizer-based
        preflight path on every retrieve request.
        """
        from sqlalchemy import func

        from app.models.knowledge import KnowledgeDocument
        from app.models.subtask_context import SubtaskContext

        if not knowledge_base_ids:
            return 0

        document_query = db.query(
            func.coalesce(func.sum(SubtaskContext.text_length), 0)
        )
        document_query = document_query.select_from(KnowledgeDocument).join(
            SubtaskContext,
            KnowledgeDocument.attachment_id == SubtaskContext.id,
        )
        document_query = document_query.filter(
            KnowledgeDocument.kind_id.in_(knowledge_base_ids),
            KnowledgeDocument.is_active == True,
        )
        if document_ids:
            document_query = document_query.filter(
                KnowledgeDocument.id.in_(document_ids)
            )

        total_text_length = document_query.scalar()
        normalized_text_length = int(total_text_length or 0)
        # Keep the same heuristic for both whole-KB and document-scoped
        # estimation so routing behavior stays stable and predictable.
        #
        # Aggregate functions may still return Decimal on some database/driver
        # combinations, so normalize to int before applying the heuristic.
        return int(normalized_text_length * 1.5)

    @staticmethod
    def _should_disable_auto_direct_injection() -> bool:
        """Return whether automatic direct injection routing is globally disabled."""
        return bool(settings.RAG_AUTO_DISABLE_DIRECT_INJECTION)

    @staticmethod
    def _should_use_direct_injection(
        context_window: Optional[int],
        total_estimated_tokens: int,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
    ) -> bool:
        """Decide whether chat_shell should receive all chunks for direct injection."""
        if route_mode == "direct_injection":
            return True
        if route_mode == "rag_retrieval":
            return False
        available_for_kb = (
            RetrievalService._calculate_ratio_based_direct_injection_budget(
                context_window
            )
        )
        if available_for_kb is None:
            return False
        return total_estimated_tokens <= available_for_kb

    @staticmethod
    def _calculate_ratio_based_direct_injection_budget(
        context_window: Optional[int],
    ) -> Optional[int]:
        """Calculate the legacy direct-injection threshold used for coarse routing."""
        if not context_window or context_window <= 0:
            return None
        return int(context_window * CHAT_SHELL_DIRECT_INJECTION_RATIO)

    @staticmethod
    def _estimate_direct_injection_tokens(
        records: list[Dict[str, Any]],
    ) -> int:
        """Estimate tokens for direct injection using a stable chars/token heuristic."""
        if not records:
            return 0

        total_tokens = 0
        for record in records:
            content = record.get("content", "") or ""
            total_tokens += int(
                len(content) / CHAT_SHELL_DIRECT_INJECTION_CHARS_PER_TOKEN
            )

        return total_tokens + (
            len(records) * CHAT_SHELL_DIRECT_INJECTION_FORMATTING_OVERHEAD
        )

    @staticmethod
    def _calculate_available_injection_tokens(
        context_window: Optional[int],
        used_context_tokens: int,
        reserved_output_tokens: int,
        context_buffer_ratio: float,
    ) -> Optional[int]:
        """Calculate runtime token budget available for direct injection."""
        if not context_window or context_window <= 0:
            return None

        total_available = context_window - used_context_tokens - reserved_output_tokens
        buffer_space = int(total_available * context_buffer_ratio)
        return max(0, total_available - buffer_space)

    @staticmethod
    def _can_finalize_direct_injection(
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        direct_records: list[Dict[str, Any]],
        direct_injection_estimated_tokens: int,
        available_injection_tokens: Optional[int],
        context_window: Optional[int],
        max_direct_chunks: int,
    ) -> bool:
        """Finalize whether direct injection should be used for the current request."""
        rejection_reason = RetrievalService._get_direct_injection_rejection_reason(
            route_mode=route_mode,
            direct_records=direct_records,
            direct_injection_estimated_tokens=direct_injection_estimated_tokens,
            available_injection_tokens=available_injection_tokens,
            context_window=context_window,
            max_direct_chunks=max_direct_chunks,
        )
        return rejection_reason is None

    @staticmethod
    def _get_direct_injection_rejection_reason(
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"],
        direct_records: list[Dict[str, Any]],
        direct_injection_estimated_tokens: int,
        available_injection_tokens: Optional[int],
        context_window: Optional[int],
        max_direct_chunks: int,
    ) -> Optional[str]:
        """Return the reason direct injection cannot be finalized."""
        if route_mode == "rag_retrieval":
            return "route_mode_forced_rag"
        if len(direct_records) > max_direct_chunks:
            return "max_direct_chunks_exceeded"
        available_for_kb = (
            RetrievalService._calculate_ratio_based_direct_injection_budget(
                context_window
            )
        )
        if (
            available_for_kb is not None
            and direct_injection_estimated_tokens > available_for_kb
        ):
            return "context_ratio_exceeded"
        if available_injection_tokens is not None:
            if direct_injection_estimated_tokens > available_injection_tokens:
                return "runtime_budget_exceeded"
        return None

    def decide_route_mode_for_chat_shell(
        self,
        *,
        query: str,
        knowledge_base_ids: list[int],
        db: Session,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto",
        document_ids: Optional[list[int]] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        context_window: Optional[int] = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS,
    ) -> Literal["direct_injection", "rag_retrieval"]:
        """Resolve the coarse query route while keeping final direct-fit local."""
        del query, max_direct_chunks
        if not knowledge_base_ids:
            return "rag_retrieval"
        if metadata_condition is not None:
            return "rag_retrieval"

        if route_mode == "auto" and self._should_disable_auto_direct_injection():
            logger.info(
                "[RAG] auto direct injection disabled by config; forcing rag_retrieval"
            )
            return "rag_retrieval"

        total_estimated_tokens = 0
        if route_mode == "auto":
            total_estimated_tokens = self._estimate_total_tokens_for_knowledge_bases(
                db=db,
                knowledge_base_ids=knowledge_base_ids,
                document_ids=document_ids,
            )

        use_direct_injection = self._should_use_direct_injection(
            context_window=context_window,
            total_estimated_tokens=total_estimated_tokens,
            route_mode=route_mode,
        )
        if not use_direct_injection:
            return "rag_retrieval"

        available_injection_tokens = self._calculate_available_injection_tokens(
            context_window=context_window,
            used_context_tokens=used_context_tokens,
            reserved_output_tokens=reserved_output_tokens,
            context_buffer_ratio=context_buffer_ratio,
        )
        if (
            route_mode == "auto"
            and available_injection_tokens is not None
            and total_estimated_tokens > available_injection_tokens
        ):
            return "rag_retrieval"

        if use_direct_injection:
            return "direct_injection"
        return "rag_retrieval"

    @trace_async(
        span_name="rag.retrieve_with_routing",
        tracer_name="backend.services.rag",
    )
    async def retrieve_with_routing(
        self,
        query: str,
        knowledge_base_ids: list[int],
        db: Session,
        max_results: int = 5,
        document_ids: Optional[list[int]] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        knowledge_base_configs: Optional[list[RemoteKnowledgeBaseQueryConfig]] = None,
        user_name: Optional[str] = None,
        context_window: Optional[int] = None,
        route_mode: Literal["auto", "direct_injection", "rag_retrieval"] = "auto",
        user_id: Optional[int] = None,
        used_context_tokens: int = 0,
        reserved_output_tokens: int = 4096,
        context_buffer_ratio: float = 0.1,
        max_direct_chunks: int = CHAT_SHELL_DEFAULT_MAX_DIRECT_CHUNKS,
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
            max_results: Maximum number of results to return per KB.
            document_ids: Optional list of document IDs to filter.
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
        set_span_attribute("rag.route_mode", route_mode)
        set_span_attribute("rag.kb_count", len(knowledge_base_ids))
        set_span_attribute("rag.document_filter_count", len(document_ids or []))

        if not knowledge_base_ids:
            set_span_attribute("rag.final_mode", "rag_retrieval")
            add_span_event("rag.routing.empty_request")
            return {
                "mode": "rag_retrieval",
                "records": [],
                "total": 0,
                "total_estimated_tokens": 0,
            }

        user_metadata_condition = metadata_condition
        metadata_condition = self._combine_metadata_conditions(
            self._build_document_filter(document_ids),
            metadata_condition,
        )
        metadata_requires_rag = user_metadata_condition is not None
        auto_direct_injection_disabled = (
            route_mode == "auto" and self._should_disable_auto_direct_injection()
        )
        total_estimated_tokens = 0
        if route_mode == "auto" and not auto_direct_injection_disabled:
            total_estimated_tokens = self._estimate_total_tokens_for_knowledge_bases(
                db=db,
                knowledge_base_ids=knowledge_base_ids,
                document_ids=document_ids,
            )
        use_direct_injection = (
            False
            if auto_direct_injection_disabled or metadata_requires_rag
            else self._should_use_direct_injection(
                context_window=context_window,
                total_estimated_tokens=total_estimated_tokens,
                route_mode=route_mode,
            )
        )
        available_for_kb = self._calculate_ratio_based_direct_injection_budget(
            context_window=context_window
        )
        available_injection_tokens = self._calculate_available_injection_tokens(
            context_window=context_window,
            used_context_tokens=used_context_tokens,
            reserved_output_tokens=reserved_output_tokens,
            context_buffer_ratio=context_buffer_ratio,
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
            "context_buffer_ratio=%.2f, available_for_kb=%s, "
            "available_injection_tokens=%s, direct_candidate=%s",
            len(knowledge_base_ids),
            route_mode,
            context_window,
            total_estimated_tokens,
            used_context_tokens,
            reserved_output_tokens,
            context_buffer_ratio,
            available_for_kb,
            available_injection_tokens,
            use_direct_injection,
        )
        if auto_direct_injection_disabled:
            logger.info(
                "[RAG] auto direct injection disabled by config; using rag_retrieval"
            )
        if metadata_requires_rag:
            logger.info(
                "[RAG] metadata_condition requires rag_retrieval; skipping direct injection"
            )

        records: list[Dict[str, Any]] = []
        runtime_config_by_kb_id = {
            config.knowledge_base_id: config for config in knowledge_base_configs or []
        }

        if use_direct_injection:
            direct_records: list[Dict[str, Any]] = []
            allowed_doc_refs = (
                {str(doc_id) for doc_id in document_ids} if document_ids else None
            )
            for kb_id in knowledge_base_ids:
                chunks = await self.get_all_chunks_from_knowledge_base(
                    knowledge_base_id=kb_id,
                    db=db,
                    max_chunks=CHAT_SHELL_MAX_ALL_CHUNKS,
                    query=query,
                    metadata_condition=user_metadata_condition,
                )
                for chunk in chunks:
                    if (
                        allowed_doc_refs is not None
                        and str(chunk.get("doc_ref")) not in allowed_doc_refs
                    ):
                        continue
                    direct_records.append(
                        {
                            "content": chunk.get("content", ""),
                            "score": 1.0,  # Direct injection returns all chunks, use max score
                            "title": chunk.get("title", "Unknown"),
                            "metadata": chunk.get("metadata"),
                            "knowledge_base_id": kb_id,
                        }
                    )

            direct_injection_estimated_tokens = self._estimate_direct_injection_tokens(
                direct_records
            )
            fallback_reason = self._get_direct_injection_rejection_reason(
                route_mode=route_mode,
                direct_records=direct_records,
                direct_injection_estimated_tokens=direct_injection_estimated_tokens,
                available_injection_tokens=available_injection_tokens,
                context_window=context_window,
                max_direct_chunks=max_direct_chunks,
            )
            can_finalize_direct = self._can_finalize_direct_injection(
                route_mode=route_mode,
                direct_records=direct_records,
                direct_injection_estimated_tokens=direct_injection_estimated_tokens,
                available_injection_tokens=available_injection_tokens,
                context_window=context_window,
                max_direct_chunks=max_direct_chunks,
            )
            logger.info(
                "[RAG] direct injection finalize: record_count=%d, estimated_tokens=%d, "
                "available_injection_tokens=%s, max_direct_chunks=%d, accepted=%s",
                len(direct_records),
                direct_injection_estimated_tokens,
                available_injection_tokens,
                max_direct_chunks,
                can_finalize_direct,
            )
            if can_finalize_direct:
                records = direct_records
                mode = "direct_injection"
                set_span_attribute("rag.final_mode", mode)
                add_span_event(
                    "rag.routing.direct_injection_selected",
                    {
                        "record_count": len(direct_records),
                        "estimated_tokens": direct_injection_estimated_tokens,
                    },
                )
            else:
                logger.info(
                    "[RAG] Falling back to rag_retrieval after Backend-side direct injection fit check: %s",
                    fallback_reason,
                )
                add_span_event(
                    "rag.routing.direct_injection_fallback",
                    {
                        "attempted_direct_chunks": len(direct_records),
                        "estimated_tokens": direct_injection_estimated_tokens,
                        "fallback_reason": fallback_reason or "unknown",
                    },
                )
                use_direct_injection = False

        if not use_direct_injection:
            for kb_id in knowledge_base_ids:
                result = await self.retrieve_from_knowledge_base_internal(
                    query=query,
                    knowledge_base_id=kb_id,
                    db=db,
                    metadata_condition=metadata_condition,
                    user_name=user_name,
                    knowledge_base_config=runtime_config_by_kb_id.get(kb_id),
                )
                kb_records = result.get("records", [])[:max_results]
                for record in kb_records:
                    records.append(
                        {
                            "content": record.get("content", ""),
                            "score": record.get("score", 0.0),
                            "title": record.get("title", "Unknown"),
                            "metadata": record.get("metadata"),
                            "knowledge_base_id": kb_id,
                        }
                    )
            records.sort(key=lambda x: x.get("score", 0.0) or 0.0, reverse=True)
            records = records[:max_results]
            mode = "rag_retrieval"
            set_span_attribute("rag.final_mode", mode)

        return {
            "mode": mode,
            "records": records,
            "total": len(records),
            "total_estimated_tokens": total_estimated_tokens,
        }

    async def retrieve_from_knowledge_base_internal(
        self,
        query: str,
        knowledge_base_id: int,
        db: Session,
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
            kb=kb,
            db=db,
            metadata_condition=metadata_condition,
            user_name=user_name,
            knowledge_base_config=knowledge_base_config,
        )

    async def _retrieve_from_kb_internal(
        self,
        query: str,
        kb: Kind,
        db: Session,
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
        result = await self._execute_runtime_query(
            query=query,
            knowledge_base_config=resolved_config,
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
        knowledge_base_config: RemoteKnowledgeBaseQueryConfig,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
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
            retrieval_config=knowledge_base_config.retrieval_config,
            metadata_condition=metadata_condition,
            user_id=knowledge_base_config.index_owner_user_id,
        )

    async def get_all_chunks_from_knowledge_base(
        self,
        knowledge_base_id: int,
        db: Session,
        max_chunks: int = 10000,
        query: Optional[str] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        """
        Get all chunks from a knowledge base without permission check.

        This method is used for smart context injection where we need all
        chunks from a knowledge base to determine if direct injection is possible.

        Args:
            knowledge_base_id: Knowledge base ID
            db: Database session
            max_chunks: Maximum number of chunks to retrieve (safety limit)
            query: Optional query string for logging purposes

        Returns:
            List of chunk dicts with content, title, chunk_id, doc_ref, metadata

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

        resolved_config = self._build_runtime_query_config(
            kb=kb,
            db=db,
        )
        storage_backend = create_storage_backend_from_runtime_config(
            resolved_config.retriever_config
        )

        # Use knowledge base ID as knowledge_id
        knowledge_id = str(kb.id)
        backend_name = storage_backend.__class__.__name__
        index_name = ""
        try:
            index_name = storage_backend.get_index_name(
                knowledge_id, user_id=kb.user_id
            )
        except Exception as e:
            logger.warning(
                "[RAG] Failed to precompute index name for get_all_chunks: kb_id=%s, "
                "knowledge_id=%s, backend=%s, error=%s",
                knowledge_base_id,
                knowledge_id,
                backend_name,
                e,
            )

        query_log = f", query={query[:50]}..." if query else ""
        logger.info(
            "[RAG] get_all_chunks start: kb_id=%s, kb_name=%s, knowledge_id=%s, "
            "namespace=%s, backend=%s, retriever=%s/%s, index_name=%s, max_chunks=%s, "
            "kb_owner_id=%s%s",
            knowledge_base_id,
            kb.name,
            knowledge_id,
            kb.namespace,
            backend_name,
            resolved_config.retriever_config.namespace,
            resolved_config.retriever_config.name,
            index_name or "<unknown>",
            max_chunks,
            kb.user_id,
            query_log,
        )

        # Get all chunks from storage backend
        # Run in thread pool to avoid event loop conflicts
        chunks = await asyncio.to_thread(
            storage_backend.get_all_chunks,
            knowledge_id=knowledge_id,
            max_chunks=max_chunks,
            user_id=kb.user_id,
            metadata_condition=metadata_condition,
        )

        logger.info(
            "[RAG] get_all_chunks completed: kb_id=%s, kb_name=%s, chunk_count=%s, "
            "backend=%s, index_name=%s%s",
            knowledge_base_id,
            kb.name,
            len(chunks),
            backend_name,
            index_name or "<unknown>",
            query_log,
        )
        if not chunks:
            logger.warning(
                "[RAG] get_all_chunks returned empty result: kb_id=%s, kb_name=%s, "
                "knowledge_id=%s, backend=%s, index_name=%s, retriever=%s/%s%s",
                knowledge_base_id,
                kb.name,
                knowledge_id,
                backend_name,
                index_name or "<unknown>",
                resolved_config.retriever_config.namespace,
                resolved_config.retriever_config.name,
                query_log,
            )

        return chunks


# Backward compatibility alias
retrieve_for_chat_shell = RetrievalService.retrieve_with_routing
