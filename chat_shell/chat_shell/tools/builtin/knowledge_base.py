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
from pydantic import BaseModel, Field, PrivateAttr

from .knowledge_base_abc import KnowledgeBaseToolABC
from ..knowledge_content_cleaner import get_content_cleaner
from ..knowledge_injection_strategy import InjectionMode, InjectionStrategy

logger = logging.getLogger(__name__)

# Token thresholds for call limit enforcement (hardcoded, not configurable)
TOKEN_WARNING_THRESHOLD = 0.70  # 70%: Strong warning but allow
TOKEN_REJECT_THRESHOLD = 0.90  # 90%: Reject call

# Token estimation heuristic (characters per token for ASCII text)
TOKEN_CHARS_PER_TOKEN = 4  # ~4 chars/token for English, 1-2 for CJK

# Default configuration values (used when KB spec doesn't specify)
DEFAULT_MAX_CALLS_PER_CONVERSATION = 10
DEFAULT_EXEMPT_CALLS_BEFORE_CHECK = 5


class KnowledgeBaseInput(BaseModel):
    """Input schema for knowledge base retrieval tool."""

    query: str = Field(
        description="Search query to find relevant information in the knowledge base"
    )
    max_results: int = Field(
        default=20,
        description="Maximum number of results to return. Increased from 5 to 20 for better RAG coverage.",
    )


class KnowledgeBaseTool(KnowledgeBaseToolABC, BaseTool):
    """Knowledge base retrieval tool with intelligent context injection.

    This tool implements smart injection strategy that automatically chooses
    between direct injection and RAG retrieval based on context window capacity.
    When model context window can fit all KB content, it injects chunks directly.
    When space is insufficient, it falls back to traditional RAG retrieval.

    Inherits from KnowledgeBaseToolABC to ensure consistent persistence behavior.
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

    # User name for embedding API custom headers (placeholder replacement)
    user_name: Optional[str] = None

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
    _injection_strategy: Optional[InjectionStrategy] = PrivateAttr(default=None)

    # Tool call limit tracking (per conversation)
    # These are instance variables that persist across multiple tool calls in the same conversation
    _call_count: int = PrivateAttr(default=0)
    _accumulated_tokens: int = PrivateAttr(default=0)

    # Cache for KB info (fetched once per conversation)
    _kb_info_cache: Optional[Dict[str, Any]] = PrivateAttr(default=None)

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

    def _get_effective_context_window(self) -> int:
        """Get effective context window size, using default if not provided.

        Returns:
            Context window size (uses InjectionStrategy.DEFAULT_CONTEXT_WINDOW if None)
        """
        return self.context_window or InjectionStrategy.DEFAULT_CONTEXT_WINDOW

    def _get_kb_info_sync(self) -> Dict[str, Any]:
        """Get KB info synchronously, using cache or fetching if needed.

        This is a helper method for sync methods that need KB info.
        It handles async/sync boundary by checking event loop state.

        Returns:
            KB info dict from cache or HTTP API

        Note:
            This method assumes cache is populated by _arun() at the start.
            If cache is empty, it will attempt to fetch synchronously as fallback.
        """
        # Fast path: return cached data if available
        if self._kb_info_cache is not None:
            return self._kb_info_cache

        # Slow path: cache not populated, need to fetch
        # This should rarely happen if _arun() called _get_kb_info() first
        logger.warning(
            "[KnowledgeBaseTool] KB info cache not populated, fetching synchronously"
        )

        try:
            import asyncio

            loop = asyncio.get_event_loop()
            if loop.is_running():
                # If event loop is running, we can't block
                # Return empty dict and log warning
                logger.warning(
                    "[KnowledgeBaseTool] Cannot fetch KB info in running event loop, using defaults"
                )
                return {"items": []}
            else:
                # No running loop, fetch synchronously
                return loop.run_until_complete(self._get_kb_info())
        except RuntimeError:
            # No event loop, create a new one
            return asyncio.run(self._get_kb_info())

    def _get_kb_limits(self) -> tuple[int, int]:
        """Get (max_calls, exempt_calls) for knowledge base tool calls.

        Returns limits for the first knowledge base in the list. If multiple KBs
        are configured, we use the first one's limits to keep behavior simple.

        Configuration is fetched from Backend API via _get_kb_info() and cached
        for the lifetime of the tool instance.

        Returns:
            Tuple of (max_calls_per_conversation, exempt_calls_before_check)
        """
        if not self.knowledge_base_ids:
            return DEFAULT_MAX_CALLS_PER_CONVERSATION, DEFAULT_EXEMPT_CALLS_BEFORE_CHECK

        # Get KB info using helper method
        kb_info = self._get_kb_info_sync()

        # Extract config for first KB
        first_kb_id = self.knowledge_base_ids[0]
        items = kb_info.get("items", [])

        for item in items:
            if item.get("id") == first_kb_id:
                max_calls = item.get(
                    "max_calls_per_conversation", DEFAULT_MAX_CALLS_PER_CONVERSATION
                )
                exempt_calls = item.get(
                    "exempt_calls_before_check", DEFAULT_EXEMPT_CALLS_BEFORE_CHECK
                )

                # Validate config
                if exempt_calls >= max_calls:
                    logger.warning(
                        f"[KnowledgeBaseTool] Invalid KB config for KB {first_kb_id}: "
                        f"exempt_calls={exempt_calls} >= max_calls={max_calls}. Using defaults."
                    )
                    return (
                        DEFAULT_MAX_CALLS_PER_CONVERSATION,
                        DEFAULT_EXEMPT_CALLS_BEFORE_CHECK,
                    )

                return max_calls, exempt_calls

        # KB not found in response, use defaults
        logger.debug(
            "[KnowledgeBaseTool] No config found for KB %d, using default limits",
            first_kb_id,
        )
        return DEFAULT_MAX_CALLS_PER_CONVERSATION, DEFAULT_EXEMPT_CALLS_BEFORE_CHECK

    def _estimate_tokens_from_content(self, content: str) -> int:
        """Estimate tokens from text content.

        Uses the simple heuristic: ~4 characters per token for ASCII text.
        Note: This may underestimate for CJK (Chinese/Japanese/Korean) text
        where the ratio is ~1-2 characters per token.

        Args:
            content: Text content

        Returns:
            Estimated token count
        """
        # Simple heuristic - could be improved with tiktoken for better accuracy
        # or by detecting CJK characters and adjusting the ratio
        return len(content) // TOKEN_CHARS_PER_TOKEN

    def _check_call_limits(
        self, query: str
    ) -> tuple[bool, Optional[str], Optional[str]]:
        """Check if the tool call should be allowed based on limits.

        Args:
            query: Search query

        Returns:
            Tuple of (should_allow, rejection_reason, warning_level)
            - should_allow: True if call should proceed
            - rejection_reason: Reason string if rejected, None otherwise
            - warning_level: "strong" if warning needed, None otherwise
        """
        max_calls, exempt_calls = self._get_kb_limits()
        kb_name = self._get_kb_name()

        # Increment call count (do this before checks so logging is accurate)
        current_call = self._call_count + 1

        # Check 1: Hard limit (max calls exceeded)
        if current_call > max_calls:
            logger.warning(
                "[KnowledgeBaseTool] Call REJECTED | Reason: max_calls_exceeded | "
                "Call count: %d/%d | KB: %s",
                current_call,
                max_calls,
                kb_name,
            )
            return (
                False,
                "max_calls_exceeded",
                None,
            )

        # Check 2: Token threshold (only after exempt period)
        if current_call > exempt_calls:
            # Calculate current token usage percentage
            effective_context_window = self._get_effective_context_window()
            usage_percent = self._accumulated_tokens / effective_context_window

            # Token >= 90%: Reject (most severe)
            if usage_percent >= TOKEN_REJECT_THRESHOLD:
                logger.warning(
                    "[KnowledgeBaseTool] Call REJECTED | Reason: token_limit_exceeded | "
                    "Call count: %d/%d | Token usage: %.1f%% | KB: %s",
                    current_call,
                    max_calls,
                    usage_percent * 100,
                    kb_name,
                )
                return False, "token_limit_exceeded", None

            # Token >= 70%: Strong warning (stricter than default warning)
            elif usage_percent >= TOKEN_WARNING_THRESHOLD:
                logger.warning(
                    "[KnowledgeBaseTool] Call %d/%d (check period, high token usage) | KB: %s | Query: %s | "
                    "Token: %d/%d (%.1f%%, threshold: 70%%) | Status: allowed_with_strong_warning",
                    current_call,
                    max_calls,
                    kb_name,
                    query[:50],
                    self._accumulated_tokens,
                    effective_context_window,
                    usage_percent * 100,
                )
                return True, None, "strong"

            # Token < 70%: Default warning for check period (gentler warning)
            else:
                logger.info(
                    "[KnowledgeBaseTool] Call %d/%d (check period, normal token usage) | KB: %s | Query: %s | "
                    "Token: %d/%d (%.1f%%) | Status: allowed_with_warning",
                    current_call,
                    max_calls,
                    kb_name,
                    query[:50],
                    self._accumulated_tokens,
                    effective_context_window,
                    usage_percent * 100,
                )
                return (
                    True,
                    None,
                    "normal",
                )  # Return "normal" warning level instead of None

        # Exempt period: Allow without checks
        logger.info(
            "[KnowledgeBaseTool] Call %d/%d (exempt period) | KB: %s | Query: %s",
            current_call,
            max_calls,
            kb_name,
            query[:50],
        )
        return True, None, None

    def _get_kb_name(self) -> str:
        """Get the name of the first knowledge base.

        Fetches from Backend API via _get_kb_info() (cached).

        Returns:
            KB name or "KB-{id}" as fallback
        """
        if not self.knowledge_base_ids:
            return "Unknown"

        first_kb_id = self.knowledge_base_ids[0]

        # Get KB info using helper method
        kb_info = self._get_kb_info_sync()

        # Extract name for first KB
        items = kb_info.get("items", [])
        for item in items:
            if item.get("id") == first_kb_id:
                return item.get("name", f"KB-{first_kb_id}")

        # Fallback to ID-based name
        return f"KB-{first_kb_id}"

    def _format_rejection_message(self, rejection_reason: str, max_calls: int) -> str:
        """Format rejection message based on reason.

        Args:
            rejection_reason: "max_calls_exceeded" or "token_limit_exceeded"
            max_calls: Maximum calls configured

        Returns:
            JSON string with rejection message
        """
        effective_context_window = self._get_effective_context_window()
        usage_percent = (self._accumulated_tokens / effective_context_window) * 100

        if rejection_reason == "max_calls_exceeded":
            message = (
                f"🚫 Call Rejected: Maximum call limit ({max_calls}) reached for this conversation.\n"
                f"You have made {self._call_count} successful calls. "
                f"Please use the information you've already gathered to provide your response."
            )
        else:  # token_limit_exceeded
            message = (
                f"🚫 Call Rejected: Knowledge base content has already consumed {usage_percent:.1f}% "
                f"of the context window.\n"
                f"You have made {self._call_count} successful calls. "
                f"Please use the information you've gathered to provide your response."
            )

        return json.dumps(
            {
                "status": "rejected",
                "reason": rejection_reason,
                "message": message,
                "call_count": self._call_count,
                "max_calls": max_calls,
                "token_usage_percent": usage_percent,
            },
            ensure_ascii=False,
        )

    def _build_call_statistics_header(
        self, warning_level: Optional[str], chunks_count: int
    ) -> str:
        """Build call statistics header with optional warning.

        NOTE: This method should be called AFTER incrementing self._call_count,
        as it uses the updated count to display the current call number.

        Args:
            warning_level: "normal" for default check period warning,
                          "strong" for high token usage warning,
                          None for exempt period
            chunks_count: Number of chunks retrieved

        Returns:
            Formatted header string (prepended to search results)
        """
        max_calls, exempt_calls = self._get_kb_limits()
        # Use self._call_count directly (caller already incremented it)
        current_call = self._call_count

        header = f"[Knowledge Base Search - Call {current_call}/{max_calls}]\n"
        header += f"Retrieved {chunks_count} chunks from knowledge base.\n"

        if warning_level == "strong":
            # Strong warning: Token >= 70%
            effective_context_window = self._get_effective_context_window()
            usage_percent = (self._accumulated_tokens / effective_context_window) * 100
            header += (
                f"\n🚨 Strong Warning: Knowledge base content has consumed {usage_percent:.1f}% "
                f"of the context window.\n"
                f"Please prioritize using existing information to answer the user's question.\n"
            )
        elif warning_level == "normal":
            # Normal warning: Entered check period but token < 70%
            header += (
                f"\n⚠️ Note: You are now in the check period (calls {exempt_calls + 1}-{max_calls}). "
                f"Consider using the information you've already gathered before making additional searches.\n"
            )

        return header

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
        0. Fetch KB info (size, config, name) and populate cache if not already fetched
        1. Check call limits (count and token thresholds)
        2. If rejected, return rejection message
        3. Get the total file size of all knowledge bases
        4. Estimate token count from file size
        5. If estimated tokens fit in context window, get all chunks and inject directly
        6. Otherwise, use RAG retrieval to get relevant chunks
        7. Update call count and accumulated tokens

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

            # Step 0: Fetch KB info to populate cache (if not already fetched)
            # This ensures _get_kb_limits() and _get_kb_name() can access cached data
            kb_info = await self._get_kb_info()

            # Step 0.5: Check if any KB has RAG enabled
            # If no KB has RAG configured, return helpful error message
            items = kb_info.get("items", [])
            rag_enabled_kbs = [item for item in items if item.get("rag_enabled", False)]

            if not rag_enabled_kbs:
                kb_names = [item.get("name", f"KB-{item.get('id')}") for item in items]
                logger.warning(
                    f"[KnowledgeBaseTool] RAG not configured for any KB. KBs: {kb_names}"
                )
                return json.dumps(
                    {
                        "status": "error",
                        "error_code": "rag_not_configured",
                        "message": "RAG retrieval is not available for this knowledge base. "
                        "The knowledge base was created without a retriever configuration. "
                        "Please use kb_ls to list documents and kb_head to read document contents instead.",
                        "suggestion": f"Use kb_ls(knowledge_base_id={self.knowledge_base_ids[0]}) to list available documents, "
                        "then use kb_head(document_ids=[...]) to read specific documents.",
                        "knowledge_base_ids": self.knowledge_base_ids,
                    },
                    ensure_ascii=False,
                )

            # Step 1: Check call limits BEFORE executing search
            max_calls, _exempt_calls = self._get_kb_limits()
            should_allow, rejection_reason, warning_level = self._check_call_limits(
                query
            )

            if not should_allow:
                # Return rejection message without incrementing call count
                return self._format_rejection_message(rejection_reason, max_calls)

            # Increment call count IMMEDIATELY after passing limit check
            # This ensures accurate counting even if the search operation fails later
            self._call_count += 1

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

            # Step 2: Get knowledge base info to decide strategy (already cached from Step 0)
            # kb_info is already fetched at Step 0, no need to fetch again
            total_estimated_tokens = kb_info.get("total_estimated_tokens", 0)

            # Step 3: Decide strategy based on estimated tokens vs context window
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
                # Step 4a: Get all chunks and inject directly
                kb_chunks = await self._get_all_chunks_from_all_kbs(query)

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
                    return self._format_direct_injection_result(
                        injection_result, query, warning_level
                    )
                else:
                    # Fallback to RAG if injection strategy decides not to inject
                    logger.info(
                        "[KnowledgeBaseTool] Injection strategy decided to use RAG fallback"
                    )
                    kb_chunks = await self._retrieve_chunks_from_all_kbs(
                        query, max_results
                    )
                    return await self._format_rag_result(
                        kb_chunks, query, max_results, warning_level
                    )
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

                return await self._format_rag_result(
                    kb_chunks, query, max_results, warning_level
                )

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

    async def _get_kb_info(self) -> Dict[str, Any]:
        """Get complete knowledge base information (cached).

        Fetches KB size, configuration, and metadata from Backend API.
        Results are cached for the lifetime of the tool instance (one conversation).

        Returns:
            Dictionary with:
                - total_file_size: Total file size in bytes
                - total_estimated_tokens: Estimated token count
                - items: List of KB info dicts with id, size, config, name
        """
        # Return cached result if available
        if self._kb_info_cache is not None:
            return self._kb_info_cache

        # Fetch via HTTP API (only mode supported)
        self._kb_info_cache = await self._get_kb_info_via_http()
        return self._kb_info_cache

    async def _get_kb_info_via_http(self) -> Dict[str, Any]:
        """Get KB information via HTTP API.

        Returns:
            Dictionary with total_file_size, total_estimated_tokens, and items list
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
                        f"[KnowledgeBaseTool] KB info fetched: "
                        f"total_file_size={data.get('total_file_size', 0)} bytes, "
                        f"total_estimated_tokens={data.get('total_estimated_tokens', 0)} "
                        f"(via HTTP)"
                    )
                    return data
                else:
                    logger.warning(
                        f"[KnowledgeBaseTool] HTTP KB info request failed: {response.status_code}, "
                        f"returning defaults"
                    )
                    return {
                        "total_file_size": 0,
                        "total_estimated_tokens": 0,
                        "items": [],
                    }

        except Exception as e:
            logger.warning(
                f"[KnowledgeBaseTool] HTTP KB info request error: {e}, "
                f"returning defaults"
            )
            return {"total_file_size": 0, "total_estimated_tokens": 0, "items": []}

    async def _get_all_chunks_from_all_kbs(
        self, query: Optional[str] = None
    ) -> Dict[int, List[Dict[str, Any]]]:
        """Get all chunks from all knowledge bases for direct injection.

        Args:
            query: Optional query string for logging purposes

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
                        query=query,
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
            kb_chunks = await self._get_all_chunks_via_http(query)

        return kb_chunks

    async def _get_all_chunks_via_http(
        self, query: Optional[str] = None
    ) -> Dict[int, List[Dict[str, Any]]]:
        """Get all chunks from RAG service via HTTP API.

        Args:
            query: Optional query string for logging purposes

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
                    payload = {"knowledge_base_id": kb_id, "max_chunks": 10000}
                    if query:
                        payload["query"] = query

                    response = await client.post(
                        f"{backend_url}/api/internal/rag/all-chunks",
                        json=payload,
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
                            user_name=self.user_name,
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
                    if self.user_name is not None:
                        payload["user_name"] = self.user_name

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
        warning_level: Optional[str] = None,
    ) -> str:
        """Format result for direct injection mode.

        Args:
            injection_result: Result from injection strategy
            query: Original search query
            warning_level: "strong" if warning needed, None otherwise

        Returns:
            JSON string with injection result
        """
        # Extract chunks used for persistence
        chunks_used = injection_result.get("chunks_used", [])

        # Update accumulated tokens (call count already incremented in _arun)
        injected_content = injection_result.get("injected_content", "")
        self._accumulated_tokens += self._estimate_tokens_from_content(injected_content)

        # Build call statistics header
        stats_header = self._build_call_statistics_header(
            warning_level, len(chunks_used)
        )

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
            self._persist_rag_results_sync(chunks_used, query, "direct_injection")

        return json.dumps(
            {
                "query": query,
                "mode": "direct_injection",
                "stats_header": stats_header,
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
        warning_level: Optional[str] = None,
    ) -> str:
        """Format result for RAG fallback mode.

        Args:
            kb_chunks: Dictionary mapping KB IDs to their chunks
            query: Original search query
            max_results: Maximum number of results
            warning_level: "strong" if warning needed, None otherwise

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

        # Update accumulated tokens (call count already incremented in _arun)
        total_content = "\n".join([chunk["content"] for chunk in all_chunks])
        self._accumulated_tokens += self._estimate_tokens_from_content(total_content)

        # Build call statistics header
        stats_header = self._build_call_statistics_header(
            warning_level, len(all_chunks)
        )

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
                "stats_header": stats_header,
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
        injection_mode: str = "rag_retrieval",
    ) -> None:
        """Persist RAG retrieval results to context database.

        This method saves the retrieved chunks to the SubtaskContext record
        so that subsequent conversations can include them in history.

        Supports both package mode (direct DB access) and HTTP mode (via API).

        Args:
            all_chunks: List of retrieved chunks with content and metadata
            source_references: List of source references with title and kb_id
            query: Original search query
            injection_mode: "direct_injection" or "rag_retrieval"
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
                    kb_id, chunks, source_references, query, injection_mode
                )
            return

        except ImportError:
            # HTTP mode: use HTTP API
            for kb_id, chunks in chunks_by_kb.items():
                await self._persist_rag_result_http_mode(
                    kb_id, chunks, source_references, query, injection_mode
                )

    async def _persist_rag_result_package_mode(
        self,
        kb_id: int,
        chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        query: str,
        injection_mode: str = "rag_retrieval",
    ) -> None:
        """Persist RAG result using direct database access (package mode).

        Args:
            kb_id: Knowledge base ID
            chunks: Chunks from this knowledge base
            source_references: Source references
            query: Original search query
            injection_mode: "direct_injection" or "rag_retrieval"
        """
        import asyncio

        from app.services.context.context_service import context_service

        # Build structured JSON for extracted_text (only for rag_retrieval mode)
        if injection_mode == "direct_injection":
            extracted_text = ""
        else:
            extracted_text = self._build_extracted_data(chunks, source_references, kb_id)

        # Filter source references for this KB
        kb_sources = [s for s in source_references if s.get("kb_id") == kb_id]
        chunks_count = len(chunks)

        def _persist():
            # Find context record for this subtask and KB
            context = context_service.get_knowledge_base_context_by_subtask_and_kb_id(
                db=self.db_session,
                subtask_id=self.user_subtask_id,
                knowledge_id=kb_id,
            )

            if context is None:
                # Context doesn't exist - create with result in one operation
                logger.info(
                    f"[KnowledgeBaseTool] Context not found, creating new for "
                    f"subtask_id={self.user_subtask_id}, kb_id={kb_id}"
                )
                context = context_service.create_knowledge_base_context_with_result(
                    db=self.db_session,
                    subtask_id=self.user_subtask_id,
                    knowledge_id=kb_id,
                    user_id=self.user_id,
                    tool_type="rag",
                    result_data={
                        "extracted_text": extracted_text,
                        "sources": kb_sources,
                        "injection_mode": injection_mode,
                        "query": query,
                        "chunks_count": chunks_count,
                    },
                )
                logger.info(
                    f"[KnowledgeBaseTool] Created new context with RAG result: "
                    f"context_id={context.id}, subtask_id={self.user_subtask_id}, kb_id={kb_id}"
                )
                return

            # Update context with RAG results
            context_service.update_knowledge_base_retrieval_result(
                db=self.db_session,
                context_id=context.id,
                extracted_text=extracted_text,
                sources=kb_sources,
                injection_mode=injection_mode,
                query=query,
                chunks_count=chunks_count,
            )

            logger.info(
                f"[KnowledgeBaseTool] Persisted RAG result: context_id={context.id}, "
                f"subtask_id={self.user_subtask_id}, kb_id={kb_id}, "
                f"injection_mode={injection_mode}, chunks_count={chunks_count}"
            )

        # Run synchronous database operation in thread pool
        await asyncio.to_thread(_persist)

    async def _persist_rag_result_http_mode(
        self,
        kb_id: int,
        chunks: List[Dict[str, Any]],
        source_references: List[Dict[str, Any]],
        query: str,
        injection_mode: str = "rag_retrieval",
    ) -> None:
        """Persist RAG result via HTTP API (HTTP mode).

        Args:
            kb_id: Knowledge base ID
            chunks: Chunks from this knowledge base
            source_references: Source references
            query: Original search query
            injection_mode: "direct_injection" or "rag_retrieval"
        """
        import httpx

        from chat_shell.core.config import settings

        # Build structured JSON for extracted_text (only for rag_retrieval mode)
        if injection_mode == "direct_injection":
            extracted_text = ""
        else:
            extracted_text = self._build_extracted_data(chunks, source_references, kb_id)

        # Filter source references for this KB
        kb_sources = [s for s in source_references if s.get("kb_id") == kb_id]
        chunks_count = len(chunks)

        # Get backend API URL
        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                response = await client.post(
                    f"{backend_url}/api/internal/rag/save-tool-result",
                    json={
                        "user_subtask_id": self.user_subtask_id,
                        "knowledge_base_id": kb_id,
                        "user_id": self.user_id,
                        "tool_type": "rag",
                        "extracted_text": extracted_text,
                        "sources": kb_sources,
                        "injection_mode": injection_mode,
                        "query": query,
                        "chunks_count": chunks_count,
                    },
                )

                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        logger.info(
                            f"[KnowledgeBaseTool] Persisted RAG result via HTTP: "
                            f"context_id={data.get('context_id')}, subtask_id={self.user_subtask_id}, "
                            f"kb_id={kb_id}, injection_mode={injection_mode}, chunks_count={chunks_count}"
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
        injection_mode: str = "direct_injection",
    ) -> None:
        """Synchronous wrapper for RAG result persistence (used by direct injection).

        Since direct injection mode uses sync methods, we need to handle
        async persistence differently.

        Args:
            chunks_used: Chunks used in direct injection
            query: Original search query
            injection_mode: "direct_injection" or "rag_retrieval"
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
                        chunks_with_index, source_references, query, injection_mode
                    )
                )
                task.add_done_callback(_log_task_exception)
            else:
                # Run synchronously
                loop.run_until_complete(
                    self._persist_rag_results(
                        chunks_with_index, source_references, query, injection_mode
                    )
                )
        except RuntimeError:
            # No event loop, create a new one
            asyncio.run(
                self._persist_rag_results(
                    chunks_with_index, source_references, query, injection_mode
                )
            )

    async def _persist_result(
        self,
        kb_id: int,
        result_data: Dict[str, Any],
    ) -> None:
        """Implement abstract method from KnowledgeBaseToolABC.

        Delegates to the existing _persist_rag_results implementation which
        handles grouping by KB ID and routing to the appropriate persistence mode.

        Args:
            kb_id: Knowledge base ID for this result
            result_data: Tool-specific result data containing:
                - chunks: List of retrieved chunks
                - source_references: List of source references
                - query: Original search query
                - injection_mode: "direct_injection" or "rag_retrieval"
        """
        chunks = result_data.get("chunks", [])
        source_references = result_data.get("source_references", [])
        query = result_data.get("query", "")
        injection_mode = result_data.get("injection_mode", "rag_retrieval")

        # Filter chunks for this KB
        kb_chunks = [c for c in chunks if c.get("knowledge_base_id") == kb_id]

        if not kb_chunks:
            return

        # Use HTTP mode for single KB persistence
        await self._persist_rag_result_http_mode(
            kb_id, kb_chunks, source_references, query, injection_mode
        )
