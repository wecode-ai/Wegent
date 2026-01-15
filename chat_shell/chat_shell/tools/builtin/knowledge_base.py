# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Knowledge base retrieval tool with intelligent context injection.

This tool implements smart injection strategy that automatically chooses
between direct injection and RAG retrieval based on context window capacity.
"""

import json
import logging
from typing import Any, Dict, List, Optional

from langchain_core.callbacks import CallbackManagerForToolRun
from langchain_core.tools import BaseTool
from pydantic import BaseModel, Field

from ..knowledge_content_cleaner import get_content_cleaner
from ..knowledge_injection_strategy import InjectionMode, InjectionStrategy

logger = logging.getLogger(__name__)


class KnowledgeBaseInput(BaseModel):
    """Input schema for knowledge base retrieval tool."""

    query: str = Field(
        description="Search query to find relevant information in the knowledge base"
    )
    max_results: int = Field(
        default=20,
        description="Maximum number of results to return. Increased from 5 to 20 for better RAG coverage.",
    )


class KnowledgeBaseTool(BaseTool):
    """Knowledge base retrieval tool with intelligent context injection.

    This tool implements smart injection strategy that automatically chooses
    between direct injection and RAG retrieval based on context window capacity.
    When model context window can fit all KB content, it injects chunks directly.
    When space is insufficient, it falls back to traditional RAG retrieval.
    """

    name: str = "knowledge_base_search"
    display_name: str = "检索知识库"
    description: str = (
        "Search the knowledge base for relevant information. "
        "This tool uses intelligent context injection - it may inject content directly "
        "or use RAG retrieval based on context window capacity. "
        "Returns relevant document chunks with their sources and relevance scores."
    )
    args_schema: type[BaseModel] = KnowledgeBaseInput

    # Knowledge base IDs to search (set when creating the tool)
    knowledge_base_ids: list[int] = Field(default_factory=list)

    # Document IDs to filter (optional, for searching specific documents only)
    # When set, only chunks from these documents will be returned
    document_ids: list[int] = Field(default_factory=list)

    # User ID for access control
    user_id: int = 0

    # Database session (will be set when tool is created)
    # Accepts both sync Session (backend) and AsyncSession (chat_shell HTTP mode)
    # In HTTP mode, db_session is not used - retrieval goes through HTTP API
    db_session: Optional[Any] = None

    # User subtask ID for persisting RAG results to context database
    # This is the subtask_id of the user message that triggered the AI response
    user_subtask_id: Optional[int] = None

    # Model ID for token counting and context window calculation
    model_id: str = "claude-3-5-sonnet"

    # Context window size from Model CRD (required for injection strategy)
    context_window: Optional[int] = None

    # Injection strategy configuration
    injection_mode: str = (
        InjectionMode.HYBRID
    )  # Default: auto-decide based on token count
    min_chunk_score: float = 0.5
    max_direct_chunks: int = 500
    context_buffer_ratio: float = 0.1

    # Current conversation messages for context calculation
    current_messages: List[Dict[str, Any]] = Field(default_factory=list)

    # Injection strategy instance (lazy initialized)
    _injection_strategy: Optional[InjectionStrategy] = None

    @property
    def injection_strategy(self) -> InjectionStrategy:
        """Get or create injection strategy instance."""
        if self._injection_strategy is None:
            self._injection_strategy = InjectionStrategy(
                model_id=self.model_id,
                context_window=self.context_window,
                injection_mode=self.injection_mode,
                min_chunk_score=self.min_chunk_score,
                max_direct_chunks=self.max_direct_chunks,
                context_buffer_ratio=self.context_buffer_ratio,
            )
        return self._injection_strategy

    def _run(
        self,
        query: str,
        max_results: int = 20,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Synchronous run - not implemented, use async version."""
        raise NotImplementedError("KnowledgeBaseTool only supports async execution")

    async def _arun(
        self,
        query: str,
        max_results: int = 20,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute knowledge base search with intelligent injection strategy.

        The strategy is:
        1. First get the total file size of all knowledge bases
        2. Estimate token count from file size
        3. If estimated tokens fit in context window, get all chunks and inject directly
        4. Otherwise, use RAG retrieval to get relevant chunks

        Args:
            query: Search query
            max_results: Maximum number of results per knowledge base
            run_manager: Callback manager

        Returns:
            JSON string with search results or injected content
        """
        try:
            if not self.knowledge_base_ids:
                return json.dumps(
                    {"error": "No knowledge bases configured for this conversation."}
                )

            # Note: db_session may be None in HTTP mode (chat_shell running independently)
            # In that case, we use HTTP API to communicate with backend

            logger.info(
                f"[KnowledgeBaseTool] Searching {len(self.knowledge_base_ids)} knowledge bases with query: {query}"
                + (
                    f", filtering by {len(self.document_ids)} documents"
                    if self.document_ids
                    else ""
                )
            )

            # Step 1: Get knowledge base size information to decide strategy
            kb_size_info = await self._get_kb_size_info()
            total_estimated_tokens = kb_size_info.get("total_estimated_tokens", 0)

            # Step 2: Decide strategy based on estimated tokens vs context window
            should_use_direct_injection = self._should_use_direct_injection(
                total_estimated_tokens
            )

            logger.info(
                f"[KnowledgeBaseTool] Strategy decision: estimated_tokens={total_estimated_tokens}, "
                f"context_window={self.injection_strategy.context_window}, "
                f"injection_mode={self.injection_mode}, "
                f"should_use_direct_injection={should_use_direct_injection}"
            )

            if should_use_direct_injection:
                # Step 3a: Get all chunks and inject directly
                kb_chunks = await self._get_all_chunks_from_all_kbs()

                if not kb_chunks:
                    return json.dumps(
                        {
                            "query": query,
                            "results": [],
                            "count": 0,
                            "sources": [],
                            "message": "No documents found in the knowledge base.",
                        },
                        ensure_ascii=False,
                    )

                # Apply injection strategy with all chunks
                injection_result = (
                    await self.injection_strategy.execute_injection_strategy(
                        messages=self.current_messages,
                        kb_chunks=kb_chunks,
                        query=query,
                        reserved_output_tokens=4096,
                    )
                )

                if injection_result["mode"] == InjectionMode.DIRECT_INJECTION:
                    logger.info(
                        f"[KnowledgeBaseTool] Direct injection: {len(injection_result.get('chunks_used', []))} chunks"
                    )
                    return self._format_direct_injection_result(injection_result, query)
                else:
                    # Fallback to RAG if injection strategy decides not to inject
                    logger.info(
                        "[KnowledgeBaseTool] Injection strategy decided to use RAG fallback"
                    )
                    kb_chunks = await self._retrieve_chunks_from_all_kbs(
                        query, max_results
                    )
                    return await self._format_rag_result(kb_chunks, query, max_results)
            else:
                # Step 3b: Use RAG retrieval
                logger.info(
                    f"[KnowledgeBaseTool] Using RAG retrieval: estimated_tokens={total_estimated_tokens} "
                    f"exceeds threshold"
                )
                kb_chunks = await self._retrieve_chunks_from_all_kbs(query, max_results)

                if not kb_chunks:
                    return json.dumps(
                        {
                            "query": query,
                            "results": [],
                            "count": 0,
                            "sources": [],
                            "message": "No relevant information found in the knowledge base for this query.",
                        },
                        ensure_ascii=False,
                    )

                return await self._format_rag_result(kb_chunks, query, max_results)

        except Exception as e:
            logger.error(f"[KnowledgeBaseTool] Search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Knowledge base search failed: {str(e)}"})

    def _should_use_direct_injection(self, total_estimated_tokens: int) -> bool:
        """Decide whether to use direct injection based on estimated tokens.

        Args:
            total_estimated_tokens: Estimated total tokens for all KB content

        Returns:
            True if should use direct injection, False for RAG retrieval
        """
        # If injection mode is forced to RAG_ONLY, never use direct injection
        if self.injection_mode == InjectionMode.RAG_ONLY:
            logger.info(
                f"[KnowledgeBaseTool] Injection decision: mode=RAG_ONLY, "
                f"estimated_tokens={total_estimated_tokens}, result=False (forced RAG)"
            )
            return False

        # If injection mode is forced to DIRECT_INJECTION, always use it
        if self.injection_mode == InjectionMode.DIRECT_INJECTION:
            logger.info(
                f"[KnowledgeBaseTool] Injection decision: mode=DIRECT_INJECTION, "
                f"estimated_tokens={total_estimated_tokens}, result=True (forced direct)"
            )
            return True

        # For HYBRID mode, decide based on context window capacity
        context_window = self.injection_strategy.context_window

        # Calculate available space (reserve 30% for conversation and output)
        available_for_kb = int(context_window * 0.3)

        # Use direct injection if estimated tokens fit in available space
        should_inject = total_estimated_tokens <= available_for_kb

        logger.info(
            f"[KnowledgeBaseTool] Injection decision: mode=HYBRID, "
            f"estimated_tokens={total_estimated_tokens}, "
            f"context_window={context_window}, "
            f"available_for_kb={available_for_kb}, "
            f"result={should_inject}"
        )

        return should_inject

    async def _get_kb_size_info(self) -> Dict[str, Any]:
        """Get size information for all knowledge bases.

        Returns:
            Dictionary with total_file_size and total_estimated_tokens
        """
        # Try to import from backend if available
        try:
            from app.services.knowledge_service import KnowledgeService

            total_file_size = 0
            total_estimated_tokens = 0

            for kb_id in self.knowledge_base_ids:
                try:
                    file_size = KnowledgeService.get_total_file_size(
                        self.db_session, kb_id
                    )
                    total_file_size += file_size
                    # Estimate tokens: approximately 4 characters per token
                    total_estimated_tokens += file_size // 4
                except Exception as e:
                    logger.warning(
                        f"[KnowledgeBaseTool] Failed to get size for KB {kb_id}: {e}"
                    )

            logger.info(
                f"[KnowledgeBaseTool] KB size info: total_file_size={total_file_size} bytes, "
                f"total_estimated_tokens={total_estimated_tokens}"
            )

            return {
                "total_file_size": total_file_size,
                "total_estimated_tokens": total_estimated_tokens,
            }

        except ImportError:
            # Backend not available, try HTTP fallback
            return await self._get_kb_size_info_via_http()

    async def _get_kb_size_info_via_http(self) -> Dict[str, Any]:
        """Get KB size information via HTTP API.

        Returns:
            Dictionary with total_file_size and total_estimated_tokens
        """
        import httpx

        from chat_shell.core.config import settings

        # Get backend API URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{backend_url}/api/internal/rag/kb-size",
                    json={"knowledge_base_ids": self.knowledge_base_ids},
                )

                if response.status_code == 200:
                    data = response.json()
                    logger.info(
                        f"[KnowledgeBaseTool] KB size info: "
                        f"total_file_size={data.get('total_file_size', 0)} bytes, "
                        f"total_estimated_tokens={data.get('total_estimated_tokens', 0)} "
                        f"(via HTTP)"
                    )
                    return data
                else:
                    logger.warning(
                        f"[KnowledgeBaseTool] HTTP KB size request failed: {response.status_code}, "
                        f"returning total_file_size=0, total_estimated_tokens=0"
                    )
                    return {"total_file_size": 0, "total_estimated_tokens": 0}

        except Exception as e:
            logger.warning(
                f"[KnowledgeBaseTool] HTTP KB size request error: {e}, "
                f"returning total_file_size=0, total_estimated_tokens=0"
            )
            return {"total_file_size": 0, "total_estimated_tokens": 0}

    async def _get_all_chunks_from_all_kbs(self) -> Dict[int, List[Dict[str, Any]]]:
        """Get all chunks from all knowledge bases for direct injection.

        Returns:
            Dictionary mapping KB IDs to their chunks
        """
        kb_chunks = {}

        # Try to import from backend if available
        try:
            from app.services.rag.retrieval_service import RetrievalService

            retrieval_service = RetrievalService()

            for kb_id in self.knowledge_base_ids:
                try:
                    chunks = await retrieval_service.get_all_chunks_from_knowledge_base(
                        knowledge_base_id=kb_id,
                        db=self.db_session,
                        max_chunks=10000,
                    )

                    logger.info(
                        f"[KnowledgeBaseTool] Retrieved all {len(chunks)} chunks from KB {kb_id}"
                    )

                    # Process chunks into the expected format
                    # Direct injection uses null score to indicate non-RAG retrieval
                    processed_chunks = []
                    for chunk in chunks:
                        processed_chunk = {
                            "content": chunk.get("content", ""),
                            "source": chunk.get("title", "Unknown"),
                            "score": None,  # null for direct injection (not RAG similarity)
                            "knowledge_base_id": kb_id,
                        }
                        processed_chunks.append(processed_chunk)

                    if processed_chunks:
                        kb_chunks[kb_id] = processed_chunks

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] Error getting all chunks from KB {kb_id}: {e}"
                    )
                    continue

        except ImportError:
            # Backend not available, try HTTP fallback
            kb_chunks = await self._get_all_chunks_via_http()

        return kb_chunks

    async def _get_all_chunks_via_http(self) -> Dict[int, List[Dict[str, Any]]]:
        """Get all chunks from RAG service via HTTP API.

        Returns:
            Dictionary mapping KB IDs to their chunks
        """
        import httpx

        from chat_shell.core.config import settings

        kb_chunks = {}

        # Get backend API URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        async with httpx.AsyncClient(timeout=60.0) as client:
            for kb_id in self.knowledge_base_ids:
                try:
                    response = await client.post(
                        f"{backend_url}/api/internal/rag/all-chunks",
                        json={"knowledge_base_id": kb_id, "max_chunks": 10000},
                    )

                    if response.status_code != 200:
                        logger.warning(
                            f"[KnowledgeBaseTool] HTTP all-chunks returned {response.status_code}"
                        )
                        continue

                    data = response.json()
                    chunks = data.get("chunks", [])

                    logger.info(
                        f"[KnowledgeBaseTool] HTTP retrieved all {len(chunks)} chunks from KB {kb_id}"
                    )

                    # Process chunks with null score for direct injection
                    processed_chunks = []
                    for chunk in chunks:
                        processed_chunk = {
                            "content": chunk.get("content", ""),
                            "source": chunk.get("title", "Unknown"),
                            "score": None,  # null for direct injection (not RAG similarity)
                            "knowledge_base_id": kb_id,
                        }
                        processed_chunks.append(processed_chunk)

                    if processed_chunks:
                        kb_chunks[kb_id] = processed_chunks

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] HTTP all-chunks failed for KB {kb_id}: {e}"
                    )
                    continue

        return kb_chunks

    async def _retrieve_chunks_from_all_kbs(
        self,
        query: str,
        max_results: int,
    ) -> Dict[int, List[Dict[str, Any]]]:
        """Retrieve chunks from all knowledge bases.

        Args:
            query: Search query
            max_results: Max results per KB

        Returns:
            Dictionary mapping KB IDs to their chunks
        """
        # Build metadata_condition for document filtering
        metadata_condition = self._build_document_filter()

        kb_chunks = {}

        # Try to import from backend if available (when running inside backend process)
        try:
            from app.services.rag.retrieval_service import RetrievalService

            retrieval_service = RetrievalService()

            for kb_id in self.knowledge_base_ids:
                try:
                    result = (
                        await retrieval_service.retrieve_from_knowledge_base_internal(
                            query=query,
                            knowledge_base_id=kb_id,
                            db=self.db_session,
                            metadata_condition=metadata_condition,
                        )
                    )

                    records = result.get("records", [])
                    logger.info(
                        f"[KnowledgeBaseTool] Retrieved {len(records)} chunks from KB {kb_id}"
                    )

                    # Process records into chunks
                    chunks = []
                    for record in records:
                        chunk = {
                            "content": record.get("content", ""),
                            "source": record.get("title", "Unknown"),
                            "score": record.get("score", 0.0),
                            "knowledge_base_id": kb_id,
                        }
                        chunks.append(chunk)

                    if chunks:
                        kb_chunks[kb_id] = chunks

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] Error retrieving from KB {kb_id}: {e}"
                    )
                    continue

        except ImportError:
            # Backend RAG service not available, try HTTP fallback
            kb_chunks = await self._retrieve_chunks_via_http(query, max_results)

        return kb_chunks

    async def _retrieve_chunks_via_http(
        self,
        query: str,
        max_results: int,
    ) -> Dict[int, List[Dict[str, Any]]]:
        """Retrieve chunks from RAG service via HTTP API.

        Args:
            query: Search query
            max_results: Max results per KB

        Returns:
            Dictionary mapping KB IDs to their chunks
        """
        import httpx

        from chat_shell.core.config import settings

        kb_chunks = {}

        # Get backend API URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        async with httpx.AsyncClient(timeout=30.0) as client:
            for kb_id in self.knowledge_base_ids:
                try:
                    payload = {
                        "query": query,
                        "knowledge_base_id": kb_id,
                        "max_results": max_results,
                    }
                    if self.document_ids:
                        payload["document_ids"] = self.document_ids

                    response = await client.post(
                        f"{backend_url}/api/internal/rag/retrieve",
                        json=payload,
                    )

                    if response.status_code != 200:
                        logger.warning(
                            f"[KnowledgeBaseTool] HTTP RAG returned {response.status_code}: {response.text}"
                        )
                        continue

                    data = response.json()
                    records = data.get("records", [])

                    logger.info(
                        f"[KnowledgeBaseTool] HTTP retrieved {len(records)} chunks from KB {kb_id}"
                    )

                    # Process records into chunks
                    chunks = []
                    for record in records:
                        chunk = {
                            "content": record.get("content", ""),
                            "source": record.get("title", "Unknown"),
                            "score": record.get("score", 0.0),
                            "knowledge_base_id": kb_id,
                        }
                        chunks.append(chunk)

                    if chunks:
                        kb_chunks[kb_id] = chunks

                except Exception as e:
                    logger.error(
                        f"[KnowledgeBaseTool] HTTP RAG failed for KB {kb_id}: {e}"
                    )
                    continue

        return kb_chunks

    def _build_document_filter(self) -> Optional[dict[str, Any]]:
        """Build metadata_condition for filtering by document IDs.

        Returns:
            Dify-style metadata_condition dict or None if no filtering needed
        """
        if not self.document_ids:
            return None

        # Convert document IDs to doc_ref format (document IDs are stored as strings)
        doc_refs = [str(doc_id) for doc_id in self.document_ids]

        # Build Dify-style metadata_condition
        # Uses "in" operator to match any of the document IDs
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

    def _build_extracted_data(
        self,
        chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        kb_id: int,
    ) -> str:
        """Build structured JSON for extracted_text field.

        Args:
            chunks: List of chunks with content and metadata
            source_references: List of source references
            kb_id: Knowledge base ID to filter by

        Returns:
            JSON string with structured data
        """
        # Filter chunks and sources for this KB
        kb_chunks = [c for c in chunks if c.get("knowledge_base_id") == kb_id]
        kb_sources = [s for s in source_references if s.get("kb_id") == kb_id]

        extracted_data = {
            "chunks": [
                {
                    "content": c.get("content", ""),
                    "source": c.get("source", "Unknown"),
                    "score": c.get("score"),  # None for direct injection
                    "knowledge_base_id": kb_id,
                    "source_index": c.get("source_index", 0),
                }
                for c in kb_chunks
            ],
            "sources": kb_sources,  # [{index, title, kb_id}, ...]
        }
        return json.dumps(extracted_data, ensure_ascii=False)

    def _format_direct_injection_result(
        self,
        injection_result: Dict[str, Any],
        query: str,
    ) -> str:
        """Format result for direct injection mode.

        Args:
            injection_result: Result from injection strategy
            query: Original search query

        Returns:
            JSON string with injection result
        """
        # Extract chunks used for persistence
        chunks_used = injection_result.get("chunks_used", [])

        # Build source references from chunks_used
        source_references = []
        seen_sources: dict[tuple[int, str], int] = {}
        source_index = 1

        for chunk in chunks_used:
            kb_id = chunk.get("knowledge_base_id")
            source_file = chunk.get("source", "Unknown")
            source_key = (kb_id, source_file)

            if source_key not in seen_sources:
                seen_sources[source_key] = source_index
                source_references.append(
                    {
                        "index": source_index,
                        "title": source_file,
                        "kb_id": kb_id,
                    }
                )
                source_index += 1

        # Persist RAG results if user_subtask_id is available
        if self.user_subtask_id and chunks_used:
            self._persist_rag_results_sync(chunks_used, query)

        return json.dumps(
            {
                "query": query,
                "mode": "direct_injection",
                "injected_content": injection_result["injected_content"],
                "chunks_used": len(chunks_used),
                "count": len(chunks_used),
                "sources": source_references,
                "decision_details": injection_result["decision_details"],
                "strategy_stats": self.injection_strategy.get_injection_statistics(),
                "message": "All knowledge base content has been fully injected above. "
                "No further retrieval is needed - you have access to the complete knowledge base. "
                "Please answer the user's question based on the injected content.",
            },
            ensure_ascii=False,
        )

    async def _format_rag_result(
        self,
        kb_chunks: Dict[int, List[Dict[str, Any]]],
        query: str,
        max_results: int,
    ) -> str:
        """Format result for RAG fallback mode.

        Args:
            kb_chunks: Dictionary mapping KB IDs to their chunks
            query: Original search query
            max_results: Maximum number of results

        Returns:
            JSON string with RAG result
        """
        # Flatten all chunks and sort by score
        all_chunks = []
        source_references = []
        source_index = 1
        seen_sources: dict[tuple[int, str], int] = {}

        for kb_id, chunks in kb_chunks.items():
            for chunk in chunks:
                source_file = chunk.get("source", "Unknown")
                source_key = (kb_id, source_file)

                if source_key not in seen_sources:
                    seen_sources[source_key] = source_index
                    source_references.append(
                        {
                            "index": source_index,
                            "title": source_file,
                            "kb_id": kb_id,
                        }
                    )
                    source_index += 1

                all_chunks.append(
                    {
                        "content": chunk["content"],
                        "source": source_file,
                        "source_index": seen_sources[source_key],
                        "score": chunk["score"],
                        "knowledge_base_id": kb_id,
                    }
                )

        # Sort by score (descending)
        all_chunks.sort(key=lambda x: x.get("score", 0.0) or 0.0, reverse=True)

        # Limit total results
        all_chunks = all_chunks[:max_results]

        logger.info(
            f"[KnowledgeBaseTool] RAG fallback: returning {len(all_chunks)} results with {len(source_references)} unique sources for query: {query}"
        )

        # Persist RAG results if user_subtask_id is available
        if self.user_subtask_id and all_chunks:
            await self._persist_rag_results(all_chunks, source_references, query)

        return json.dumps(
            {
                "query": query,
                "mode": "rag_retrieval",
                "results": all_chunks,
                "count": len(all_chunks),
                "sources": source_references,
                "strategy_stats": self.injection_strategy.get_injection_statistics(),
            },
            ensure_ascii=False,
        )

    async def _persist_rag_results(
        self,
        all_chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        query: str,
    ) -> None:
        """Persist RAG retrieval results to context database.

        This method saves the retrieved chunks to the SubtaskContext record
        so that subsequent conversations can include them in history.

        Supports both package mode (direct DB access) and HTTP mode (via API).

        Args:
            all_chunks: List of retrieved chunks with content and metadata
            source_references: List of source references with title and kb_id
            query: Original search query
        """
        # Group chunks by knowledge_base_id for per-KB persistence
        chunks_by_kb: Dict[int, List[Dict[str, Any]]] = {}
        for chunk in all_chunks:
            kb_id = chunk.get("knowledge_base_id")
            if kb_id is not None:
                if kb_id not in chunks_by_kb:
                    chunks_by_kb[kb_id] = []
                chunks_by_kb[kb_id].append(chunk)

        # Try package mode first (direct DB access)
        try:
            from app.services.context.context_service import context_service

            # Package mode: use context_service directly
            for kb_id, chunks in chunks_by_kb.items():
                await self._persist_rag_result_package_mode(
                    kb_id, chunks, source_references, query
                )
            return

        except ImportError:
            # HTTP mode: use HTTP API
            for kb_id, chunks in chunks_by_kb.items():
                await self._persist_rag_result_http_mode(
                    kb_id, chunks, source_references, query
                )

    async def _persist_rag_result_package_mode(
        self,
        kb_id: int,
        chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        query: str,
    ) -> None:
        """Persist RAG result using direct database access (package mode).

        Args:
            kb_id: Knowledge base ID
            chunks: Chunks from this knowledge base
            source_references: Source references
            query: Original search query
        """
        import asyncio

        from app.services.context.context_service import context_service

        # Build structured JSON for extracted_text
        extracted_text = self._build_extracted_data(chunks, source_references, kb_id)

        # Filter source references for this KB
        kb_sources = [s for s in source_references if s.get("kb_id") == kb_id]

        def _persist():
            # Find context record for this subtask and KB
            context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
                db=self.db_session,
                subtask_id=self.user_subtask_id,
                knowledge_id=kb_id,
            )

            if context is None:
                logger.warning(
                    f"[KnowledgeBaseTool] No context found for subtask_id={self.user_subtask_id}, kb_id={kb_id}"
                )
                return

            # Update context with RAG results
            context_service.update_knowledge_base_retrieval_result(
                db=self.db_session,
                context_id=context.id,
                extracted_text=extracted_text,
                sources=kb_sources,
            )

            logger.info(
                f"[KnowledgeBaseTool] Persisted RAG result: context_id={context.id}, "
                f"subtask_id={self.user_subtask_id}, kb_id={kb_id}, text_length={len(extracted_text)}"
            )

        # Run synchronous database operation in thread pool
        await asyncio.to_thread(_persist)

    async def _persist_rag_result_http_mode(
        self,
        kb_id: int,
        chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        query: str,
    ) -> None:
        """Persist RAG result via HTTP API (HTTP mode).

        Args:
            kb_id: Knowledge base ID
            chunks: Chunks from this knowledge base
            source_references: Source references
            query: Original search query
        """
        import httpx

        from chat_shell.core.config import settings

        # Build structured JSON for extracted_text
        extracted_text = self._build_extracted_data(chunks, source_references, kb_id)

        # Filter source references for this KB
        kb_sources = [s for s in source_references if s.get("kb_id") == kb_id]

        # Get backend API URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{backend_url}/api/internal/rag/save-result",
                    json={
                        "user_subtask_id": self.user_subtask_id,
                        "knowledge_base_id": kb_id,
                        "extracted_text": extracted_text,
                        "sources": kb_sources,
                    },
                )

                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        logger.info(
                            f"[KnowledgeBaseTool] Persisted RAG result via HTTP: "
                            f"context_id={data.get('context_id')}, subtask_id={self.user_subtask_id}, "
                            f"kb_id={kb_id}, text_length={len(extracted_text)}"
                        )
                    else:
                        logger.warning(
                            f"[KnowledgeBaseTool] Failed to persist RAG result: {data.get('message')}"
                        )
                else:
                    logger.warning(
                        f"[KnowledgeBaseTool] HTTP persist failed: status={response.status_code}, "
                        f"body={response.text[:200]}"
                    )

        except Exception as e:
            logger.warning(
                f"[KnowledgeBaseTool] HTTP persist error for kb_id={kb_id}: {e}"
            )

    def _persist_rag_results_sync(
        self,
        chunks_used: List[Dict[str, Any]],
        query: str,
    ) -> None:
        """Synchronous wrapper for RAG result persistence (used by direct injection).

        Since direct injection mode uses sync methods, we need to handle
        async persistence differently.

        Args:
            chunks_used: Chunks used in direct injection
            query: Original search query
        """
        import asyncio

        # Build source references from chunks
        source_references = []
        seen_sources: dict[tuple[int, str], int] = {}
        source_index = 1

        # Add source_index to each chunk
        chunks_with_index = []
        for chunk in chunks_used:
            kb_id = chunk.get("knowledge_base_id")
            source_file = chunk.get("source", "Unknown")
            source_key = (kb_id, source_file)

            if source_key not in seen_sources:
                seen_sources[source_key] = source_index
                source_references.append(
                    {
                        "index": source_index,
                        "title": source_file,
                        "kb_id": kb_id,
                    }
                )
                source_index += 1

            chunk_with_index = chunk.copy()
            chunk_with_index["source_index"] = seen_sources[source_key]
            chunks_with_index.append(chunk_with_index)

        # Helper callback to log exceptions from fire-and-forget tasks
        def _log_task_exception(task: asyncio.Task) -> None:
            if task.exception():
                logger.warning(
                    f"[KnowledgeBaseTool] RAG persistence failed: {task.exception()}"
                )

        # Try to run async persist in event loop
        try:
            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If event loop is running, create a task with exception handler
                task = asyncio.create_task(
                    self._persist_rag_results(
                        chunks_with_index, source_references, query
                    )
                )
                task.add_done_callback(_log_task_exception)
            else:
                # Run synchronously
                loop.run_until_complete(
                    self._persist_rag_results(
                        chunks_with_index, source_references, query
                    )
                )
        except RuntimeError:
            # No event loop, create a new one
            asyncio.run(
                self._persist_rag_results(chunks_with_index, source_references, query)
            )
