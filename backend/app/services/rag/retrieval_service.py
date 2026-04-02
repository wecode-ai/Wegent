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

from app.services.adapters.retriever_kinds import retriever_kinds_service
from app.services.knowledge import KnowledgeService
from app.services.rag.embedding.factory import create_embedding_model_from_crd
from app.services.rag.retrieval.retriever import DocumentRetriever
from app.services.rag.storage.base import BaseStorageBackend
from app.services.rag.storage.factory import create_storage_backend
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
    Uses modular architecture with pluggable storage backends.
    """

    def __init__(self, storage_backend: Optional[BaseStorageBackend] = None):
        """
        Initialize retrieval service.

        Args:
            storage_backend: Optional storage backend instance (Elasticsearch, Qdrant, etc.)
                           If not provided, must be created from retriever configuration
        """
        self.storage_backend = storage_backend

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

    @trace_async(
        span_name="rag.retrieve_for_chat_shell",
        tracer_name="backend.services.rag",
    )
    async def retrieve_for_chat_shell(
        self,
        query: str,
        knowledge_base_ids: list[int],
        db: Session,
        max_results: int = 5,
        document_ids: Optional[list[int]] = None,
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
        """Retrieve KB data for chat_shell with Backend-side routing.

        This method centralizes the coarse routing decision that was previously made
        in chat_shell: whether to fetch all chunks for direct injection, or perform
        regular RAG retrieval.
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

        metadata_condition = self._build_document_filter(document_ids)
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

        records: list[Dict[str, Any]] = []

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
                            "score": None,
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

    def _retrieve_sync(
        self,
        knowledge_id: str,
        query: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        retrieval_setting: Dict[str, Any],
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
    ) -> Dict:
        """
        Synchronous retrieval implementation.
        Runs in thread pool to avoid event loop conflicts.

        Args:
            knowledge_id: Knowledge base ID
            query: Search query
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            retrieval_setting: Retrieval settings (Dify-style)
            metadata_condition: Optional metadata filtering
            user_name: User name for placeholder replacement in embedding headers (optional)

        Returns:
            Retrieval result dict
        """
        # Create embedding model from CRD
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
            user_name=user_name,
        )

        # Create retriever with storage backend
        retriever = DocumentRetriever(
            storage_backend=self.storage_backend, embed_model=embed_model
        )

        # Retrieve documents (pass user_id)
        result = retriever.retrieve(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            user_id=user_id,
        )

        return result

    async def retrieve(
        self,
        query: str,
        knowledge_id: str,
        embedding_model_name: str,
        embedding_model_namespace: str,
        user_id: int,
        db: Session,
        top_k: int = 5,
        score_threshold: float = 0.7,
        retrieval_mode: str = "vector",
        vector_weight: Optional[float] = None,
        keyword_weight: Optional[float] = None,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
    ) -> Dict:
        """
        Retrieve relevant document chunks (Dify-compatible API).

        Args:
            query: Search query
            knowledge_id: Knowledge base ID
            embedding_model_name: Embedding model name
            embedding_model_namespace: Embedding model namespace
            user_id: User ID
            db: Database session
            top_k: Maximum number of results
            score_threshold: Minimum similarity score (0-1)
            retrieval_mode: 'vector' or 'hybrid'
            vector_weight: Weight for vector search (hybrid mode only)
            keyword_weight: Weight for BM25 search (hybrid mode only)
            metadata_condition: Optional metadata filtering conditions
            user_name: User name for placeholder replacement in embedding headers (optional)

        Returns:
            Dict with Dify-compatible format:
                {
                    "records": [
                        {
                            "content": str,      # Chunk text content
                            "score": float,      # Relevance score (0-1)
                            "title": str,        # Document title/source file
                            "metadata": dict     # Additional metadata
                        }
                    ]
                }
        """
        # Build retrieval_setting dict (Dify-style API)
        retrieval_setting = {
            "top_k": top_k,
            "score_threshold": score_threshold,
            "retrieval_mode": retrieval_mode,
        }

        # Add hybrid search weights if provided
        if retrieval_mode == "hybrid":
            retrieval_setting["vector_weight"] = (
                vector_weight if vector_weight is not None else 0.7
            )
            retrieval_setting["keyword_weight"] = (
                keyword_weight if keyword_weight is not None else 0.3
            )

        # Run retrieval in thread pool to avoid uvloop conflicts
        return await asyncio.to_thread(
            self._retrieve_sync,
            knowledge_id,
            query,
            embedding_model_name,
            embedding_model_namespace,
            user_id,
            db,
            retrieval_setting,
            metadata_condition,
            user_name,
        )

    async def retrieve_from_knowledge_base(
        self,
        query: str,
        knowledge_base_id: int,
        user_id: int,
        db: Session,
        metadata_condition: Optional[Dict[str, Any]] = None,
    ) -> Dict:
        """
        Retrieve relevant chunks from a knowledge base using its configuration.

        This method encapsulates the logic of:
        1. Fetching knowledge base configuration
        2. Getting retriever CRD
        3. Creating storage backend
        4. Performing retrieval with configured parameters

        Args:
            query: Search query
            knowledge_base_id: Knowledge base ID
            user_id: User ID
            db: Database session
            metadata_condition: Optional metadata filtering conditions

        Returns:
            Dict with retrieval results in Dify-compatible format:
                {
                    "records": [
                        {
                            "content": str,
                            "score": float,
                            "title": str,
                            "metadata": dict
                        }
                    ]
                }

        Raises:
            ValueError: If knowledge base not found, access denied, or configuration invalid
        """
        # Get knowledge base configuration with permission check
        kb, has_access = KnowledgeService.get_knowledge_base(
            db=db,
            knowledge_base_id=knowledge_base_id,
            user_id=user_id,
        )

        if not kb:
            raise ValueError(f"Knowledge base {knowledge_base_id} not found")

        if not has_access:
            raise ValueError(
                f"Access denied to knowledge base {knowledge_base_id} for user {user_id}"
            )

        # Check if user is a Restricted Analyst in the knowledge base's group
        # Restricted Analysts cannot access knowledge base content
        if kb.namespace != "default":
            from app.services.group_permission import is_restricted_analyst

            if is_restricted_analyst(db, user_id, kb.namespace):
                logger.warning(
                    f"[RetrievalService] User {user_id} is Restricted Analyst in group "
                    f"'{kb.namespace}', blocking RAG retrieval from KB {knowledge_base_id}"
                )
                raise ValueError(
                    f"Access denied: You have Restricted Analyst permissions in group "
                    f"'{kb.namespace}'. You cannot retrieve content from this knowledge base."
                )

        return await self._retrieve_from_kb_internal(
            query=query,
            kb=kb,
            db=db,
            metadata_condition=metadata_condition,
        )

    async def retrieve_from_knowledge_base_internal(
        self,
        query: str,
        knowledge_base_id: int,
        db: Session,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
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
        )

    async def _retrieve_from_kb_internal(
        self,
        query: str,
        kb,  # Kind instance
        db: Session,
        metadata_condition: Optional[Dict[str, Any]] = None,
        user_name: Optional[str] = None,
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
        # Extract retrieval configuration from knowledge base spec
        kb_json = kb.json or {}
        spec = kb_json.get("spec", {})
        retrieval_config = spec.get("retrievalConfig")

        if not retrieval_config:
            raise ValueError(f"Knowledge base {kb.id} has no retrieval configuration")

        # Extract retriever reference
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")

        if not retriever_name:
            raise ValueError(
                f"Knowledge base {kb.id} has incomplete retrieval config (missing retriever_name)"
            )

        logger.info(
            f"[RAG] Using retriever: {retriever_name} (namespace: {retriever_namespace})"
        )

        # Determine the correct user_id for resource lookup
        # For personal resources (namespace='default'), use the KB creator's user_id
        # because the resources belong to the KB creator, not the current user
        # For group resources (namespace!='default'), use KB creator's user_id as well
        resource_owner_user_id = kb.user_id

        # Get retriever CRD
        retriever = retriever_kinds_service.get_retriever(
            db=db,
            user_id=resource_owner_user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever:
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever)
        logger.info(
            f"[RAG] Storage backend created: {storage_backend.__class__.__name__}"
        )

        # Extract embedding model configuration
        embedding_config = retrieval_config.get("embedding_config", {})
        embedding_model_name = embedding_config.get("model_name")
        embedding_model_namespace = embedding_config.get("model_namespace", "default")

        if not embedding_model_name:
            raise ValueError(f"Knowledge base {kb.id} has incomplete embedding config")

        # Determine the correct user_id for embedding model lookup
        # Use KB creator's user_id for consistent resource access
        embedding_owner_user_id = kb.user_id

        # Extract retrieval parameters
        # Increased default top_k from 5 to 20 for better RAG coverage
        top_k = retrieval_config.get("top_k", 20)
        score_threshold = retrieval_config.get("score_threshold", 0.7)
        retrieval_mode = retrieval_config.get("retrieval_mode", "vector")

        # Extract hybrid weights if in hybrid mode
        vector_weight = None
        keyword_weight = None
        if retrieval_mode == "hybrid":
            hybrid_weights = retrieval_config.get("hybrid_weights", {})
            vector_weight = hybrid_weights.get("vector_weight", 0.7)
            keyword_weight = hybrid_weights.get("keyword_weight", 0.3)

        # Use knowledge base ID as knowledge_id for retrieval
        knowledge_id = str(kb.id)

        logger.info(
            f"[RAG] Retrieving chunks: knowledge_id={knowledge_id}, "
            f"embedding_model={embedding_model_name}, "
            f"top_k={top_k}, score_threshold={score_threshold}, "
            f"retrieval_mode={retrieval_mode}"
        )

        # Build retrieval_setting dict
        retrieval_setting = {
            "top_k": top_k,
            "score_threshold": score_threshold,
            "retrieval_mode": retrieval_mode,
        }

        # Add hybrid search weights if provided
        if retrieval_mode == "hybrid":
            retrieval_setting["vector_weight"] = vector_weight
            retrieval_setting["keyword_weight"] = keyword_weight

        # Create embedding model from CRD
        # Use embedding_owner_user_id for correct resource lookup
        # For group KBs, the embedding model may be created by other users in the same group
        embed_model = create_embedding_model_from_crd(
            db=db,
            user_id=embedding_owner_user_id,
            model_name=embedding_model_name,
            model_namespace=embedding_model_namespace,
            user_name=user_name,
        )

        # Create retriever with storage backend
        retriever_instance = DocumentRetriever(
            storage_backend=storage_backend, embed_model=embed_model
        )

        # Retrieve documents (run in thread pool to avoid event loop conflicts)
        # Use KB creator's user_id for index naming (required for per_user strategy)
        # This ensures consistent index access for all users accessing this KB
        result = await asyncio.to_thread(
            retriever_instance.retrieve,
            knowledge_id=knowledge_id,
            query=query,
            retrieval_setting=retrieval_setting,
            metadata_condition=metadata_condition,
            user_id=kb.user_id,
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

    async def get_all_chunks_from_knowledge_base(
        self,
        knowledge_base_id: int,
        db: Session,
        max_chunks: int = 10000,
        query: Optional[str] = None,
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

        # Extract retrieval configuration from knowledge base spec
        kb_json = kb.json or {}
        spec = kb_json.get("spec", {})
        retrieval_config = spec.get("retrievalConfig")

        if not retrieval_config:
            raise ValueError(f"Knowledge base {kb.id} has no retrieval configuration")

        # Extract retriever reference
        retriever_name = retrieval_config.get("retriever_name")
        retriever_namespace = retrieval_config.get("retriever_namespace", "default")

        if not retriever_name:
            raise ValueError(
                f"Knowledge base {kb.id} has incomplete retrieval config (missing retriever_name)"
            )

        # Get retriever CRD
        retriever = retriever_kinds_service.get_retriever(
            db=db,
            user_id=kb.user_id,
            name=retriever_name,
            namespace=retriever_namespace,
        )

        if not retriever:
            raise ValueError(
                f"Retriever {retriever_name} (namespace: {retriever_namespace}) not found"
            )

        # Create storage backend from retriever
        storage_backend = create_storage_backend(retriever)

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
            retriever_namespace,
            retriever_name,
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
                retriever_namespace,
                retriever_name,
                query_log,
            )

        return chunks
