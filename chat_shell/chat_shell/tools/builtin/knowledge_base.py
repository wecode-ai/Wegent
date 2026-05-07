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

from shared.models.knowledge import KnowledgeBaseToolAccessMode

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
DEFAULT_RESERVED_OUTPUT_TOKENS = 4096


class KnowledgeBaseInput(BaseModel):
    """Input schema for knowledge base retrieval tool."""

    query: str = Field(
        description="Search query to find relevant information in the knowledge base"
    )
    max_results: int = Field(
        default=20,
        description="Maximum number of results to return. Increased from 5 to 20 for better RAG coverage.",
    )
    document_ids: list[int] = Field(
        default_factory=list,
        description="Optional document IDs to restrict retrieval scope.",
    )
    document_names: list[str] = Field(
        default_factory=list,
        description="Optional exact document names to restrict retrieval scope when document IDs are not known.",
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
    document_names: list[str] = Field(default_factory=list)

    # User ID for access control
    user_id: int = 0

    # User name for embedding API custom headers (placeholder replacement)
    user_name: Optional[str] = None

    # User JWT for backend internal API calls that require authentication
    auth_token: str = ""

    # Database session (will be set when tool is created)
    # Accepts both sync Session (backend) and AsyncSession (chat_shell HTTP mode)
    # In HTTP mode, db_session is not used - retrieval goes through HTTP API
    db_session: Optional[Any] = None

    # User subtask ID for persisting RAG results to context database
    # This is the subtask_id of the user message that triggered the AI response
    user_subtask_id: Optional[int] = None

    # Model ID for token counting and context window calculation
    model_id: str = "claude-3-5-sonnet"
    current_model_name: Optional[str] = None
    current_model_namespace: str = "default"

    # Context window size from Model CRD (required for injection strategy)
    context_window: Optional[int] = None

    # Injection strategy configuration
    injection_mode: str = (
        InjectionMode.HYBRID
    )  # Default: auto-decide based on token count
    tool_access_mode: str = KnowledgeBaseToolAccessMode.FULL
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

    def _is_restricted_search_only(self) -> bool:
        """Whether the tool should expose only redacted search results."""
        return (
            self.tool_access_mode == KnowledgeBaseToolAccessMode.RESTRICTED_SEARCH_ONLY
        )

    def _display_source_title(self, source_title: str, source_index: int) -> str:
        """Return a source label safe for tool output and persistence."""
        if self._is_restricted_search_only():
            return f"Source {source_index}"
        return source_title

    def _build_mediation_context(self) -> Optional[Dict[str, Any]]:
        """Build the model identity sent to Backend restricted mediation."""
        if not self.current_model_name:
            return None

        return {
            "current_model_name": self.current_model_name,
            "current_model_namespace": self.current_model_namespace,
        }

    def _get_kb_info_sync(self) -> Dict[str, Any]:
        """Get KB info synchronously.

        IMPORTANT:
        - Do NOT perform network I/O (HTTP) in synchronous code paths.
        - The async entrypoint `_arun()` is responsible for fetching KB info and
          populating the per-instance cache.

        This keeps sync helpers deterministic and avoids unexpected blocking.

        Returns:
            KB info dict from cache if available, otherwise an empty default.
        """
        if self._kb_info_cache is not None:
            return self._kb_info_cache

        logger.debug(
            "[KnowledgeBaseTool] KB info cache not populated in sync path, using defaults"
        )
        return {"items": []}

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

    def _resolve_scoped_filters(
        self,
        document_ids: Optional[list[int]] = None,
        document_names: Optional[list[str]] = None,
    ) -> tuple[list[int], list[str]]:
        """Resolve per-call filters without mutating tool instance state."""
        effective_document_ids = (
            self.document_ids if document_ids is None else document_ids
        )
        effective_document_names = (
            self.document_names if document_names is None else document_names
        )
        return effective_document_ids, effective_document_names

    async def _arun(
        self,
        query: str,
        max_results: int = 20,
        document_ids: Optional[list[int]] = None,
        document_names: Optional[list[str]] = None,
        run_manager: CallbackManagerForToolRun | None = None,
    ) -> str:
        """Execute knowledge base search with optional per-call scoped filters."""
        effective_document_ids, effective_document_names = self._resolve_scoped_filters(
            document_ids=document_ids,
            document_names=document_names,
        )
        return await self._arun_impl(
            query,
            max_results,
            run_manager,
            document_ids=effective_document_ids,
            document_names=effective_document_names,
        )

    async def _arun_impl(
        self,
        query: str,
        max_results: int = 20,
        run_manager: CallbackManagerForToolRun | None = None,
        document_ids: Optional[list[int]] = None,
        document_names: Optional[list[str]] = None,
    ) -> str:
        """Execute knowledge base search with intelligent injection strategy.

        The strategy is:
        0. Fetch KB info (size, config, name) and populate cache if not already fetched
        1. Check call limits (count and token thresholds)
        2. If rejected, return rejection message
        3. Ask Backend internal retrieve to choose the coarse route
        4. If Backend selects direct injection, run the local fit check against
           the current conversation and fall back to RAG if needed
        5. Format the final result and update call statistics

        Args:
            query: Search query
            max_results: Maximum number of results per knowledge base
            run_manager: Callback manager

        Returns:
            JSON string with search results or injected content
        """
        try:
            effective_document_ids = document_ids or []
            effective_document_names = document_names or []
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
                if self._is_restricted_search_only():
                    return json.dumps(
                        {
                            "status": "error",
                            "error_code": "rag_not_configured_search_only",
                            "message": "RAG retrieval is not available for this knowledge base in restricted search-only mode because no retriever is configured.",
                            "suggestion": "This restricted session only supports knowledge_base_search. Ask an administrator to enable a retriever for this knowledge base if search is required.",
                            "knowledge_base_ids": self.knowledge_base_ids,
                        },
                        ensure_ascii=False,
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
                    f", filtering by {len(effective_document_ids)} documents"
                    if effective_document_ids
                    else ""
                )
            )

            preferred_route_mode = "auto"
            if self.injection_mode == InjectionMode.RAG_ONLY:
                preferred_route_mode = "rag_retrieval"
            elif self.injection_mode == InjectionMode.DIRECT_INJECTION:
                preferred_route_mode = "direct_injection"

            route_mode, raw_result = await self._retrieve_with_strategy_from_all_kbs(
                query=query,
                max_results=max_results,
                route_mode=preferred_route_mode,
                document_ids=effective_document_ids,
                document_names=effective_document_names,
            )

            logger.info(
                "[KnowledgeBaseTool] Backend route result: mode=%s, record_count=%d",
                route_mode,
                len(raw_result.get("records", [])),
            )

            if route_mode == "restricted_safe_summary":
                return json.dumps(raw_result, ensure_ascii=False)

            kb_chunks = self._group_retrieved_records_by_kb(
                raw_result.get("records", [])
            )
            if not kb_chunks:
                default_message = (
                    "No documents found in the knowledge base."
                    if route_mode == InjectionMode.DIRECT_INJECTION
                    else "No relevant information found in the knowledge base for this query."
                )
                message = raw_result.get("message") or default_message
                return json.dumps(
                    {
                        "query": query,
                        "results": [],
                        "count": 0,
                        "sources": [],
                        "message": message,
                    },
                    ensure_ascii=False,
                )

            if route_mode == InjectionMode.DIRECT_INJECTION:
                injection_result = self._build_backend_direct_injection_result(
                    kb_chunks=kb_chunks
                )
                logger.info(
                    "[KnowledgeBaseTool] Backend-approved direct injection: %d chunks",
                    len(injection_result.get("chunks_used", [])),
                )
                return await self._format_direct_injection_result(
                    injection_result, query, warning_level
                )

            return await self._format_rag_result(
                kb_chunks, query, max_results, warning_level
            )

        except Exception as e:
            logger.error(f"[KnowledgeBaseTool] Search failed: {e}", exc_info=True)
            return json.dumps({"error": f"Knowledge base search failed: {str(e)}"})

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
                headers = {}
                auth_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "") or self.auth_token
                if auth_token:
                    headers["Authorization"] = f"Bearer {auth_token}"

                response = await client.post(
                    f"{backend_url}/api/internal/rag/kb-size",
                    json={"knowledge_base_ids": self.knowledge_base_ids},
                    headers=headers,
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

    def _group_retrieved_records_by_kb(
        self,
        records: List[Dict[str, Any]],
    ) -> Dict[int, List[Dict[str, Any]]]:
        """Group Backend retrieve records by knowledge base ID."""
        kb_chunks: Dict[int, List[Dict[str, Any]]] = {}
        for record in records:
            kb_id = record.get("knowledge_base_id")
            if kb_id is None:
                if len(self.knowledge_base_ids) == 1:
                    kb_id = self.knowledge_base_ids[0]
                else:
                    logger.warning(
                        "[KnowledgeBaseTool] Missing knowledge_base_id in multi-KB response"
                    )
                    continue

            kb_chunks.setdefault(kb_id, []).append(
                {
                    "content": record.get("content", ""),
                    "source": record.get("title", "Unknown"),
                    "score": record.get("score"),
                    "knowledge_base_id": kb_id,
                }
            )
        return kb_chunks

    def _get_used_context_tokens(self) -> int:
        """Calculate approximate tokens already used by the current conversation."""
        return self.injection_strategy.token_counter.count_messages(
            self.current_messages
        )

    def _build_runtime_context(
        self,
        reserved_output_tokens: int = DEFAULT_RESERVED_OUTPUT_TOKENS,
    ) -> Dict[str, Any]:
        """Build runtime context budget for Backend-side routing."""
        return {
            "context_window": self._get_effective_context_window(),
            "used_context_tokens": self._get_used_context_tokens(),
            "reserved_output_tokens": reserved_output_tokens,
            "context_buffer_ratio": self.context_buffer_ratio,
            "max_direct_chunks": self.max_direct_chunks,
        }

    def _build_persistence_context(self) -> Optional[Dict[str, Any]]:
        """Build persistence context for Backend-owned SubtaskContext updates."""
        if not self.user_subtask_id:
            return None

        return {
            "user_subtask_id": self.user_subtask_id,
            "user_id": self.user_id,
            "restricted_mode": self._is_restricted_search_only(),
        }

    def _build_backend_direct_injection_result(
        self,
        kb_chunks: Dict[int, List[Dict[str, Any]]],
    ) -> Dict[str, Any]:
        """Build direct injection payload from Backend-approved chunks."""
        all_chunks: List[Dict[str, Any]] = []
        for kb_id, chunks in kb_chunks.items():
            for chunk in chunks:
                prepared_chunk = chunk.copy()
                prepared_chunk["knowledge_base_id"] = prepared_chunk.get(
                    "knowledge_base_id", kb_id
                )
                all_chunks.append(prepared_chunk)

        prepared_chunks = self.injection_strategy.prepare_chunks_for_injection(
            all_chunks,
            max_chunks=self.max_direct_chunks,
        )
        injected_content = self.injection_strategy.format_chunks_for_injection(
            prepared_chunks
        )

        return {
            "mode": InjectionMode.DIRECT_INJECTION,
            "injected_content": injected_content,
            "chunks_used": prepared_chunks,
            "decision_details": {
                "reason": "backend_routed_direct_injection",
                "chunk_count": len(prepared_chunks),
                "runtime_context": self._build_runtime_context(),
            },
        }

    async def _retrieve_with_strategy_from_all_kbs(
        self,
        query: str,
        max_results: int,
        route_mode: str = "auto",
        document_ids: Optional[list[int]] = None,
        document_names: Optional[list[str]] = None,
    ) -> tuple[str, Dict[str, Any]]:
        """Retrieve KB data using Backend-side route selection."""
        if self.db_session is None:
            result = await self._retrieve_with_strategy_via_http(
                query=query,
                max_results=max_results,
                route_mode=route_mode,
                document_ids=document_ids,
                document_names=document_names,
            )
        else:
            try:
                resolved_document_ids = document_ids or None
                if not resolved_document_ids and document_names:
                    from app.services.knowledge import KnowledgeService

                    resolved_document_ids = (
                        KnowledgeService.resolve_document_ids_by_names(
                            db=self.db_session,
                            knowledge_base_ids=self.knowledge_base_ids,
                            document_names=document_names,
                        )
                        or None
                    )
                    if not resolved_document_ids:
                        result = {
                            "mode": InjectionMode.RAG_ONLY,
                            "records": [],
                            "total": 0,
                            "total_estimated_tokens": 0,
                            "message": "Document names not found in the selected knowledge bases. Use kb_ls to inspect available documents first.",
                        }
                        mode = result.get("mode", InjectionMode.RAG_ONLY)
                        logger.info(
                            "[KnowledgeBaseTool] Retrieved %d records via Backend route mode=%s",
                            len(result.get("records", [])),
                            mode,
                        )
                        return mode, result

                from app.services.rag.retrieval_service import RetrievalService

                retrieval_service = RetrievalService()
                result = await retrieval_service.retrieve_with_routing(
                    query=query,
                    knowledge_base_ids=self.knowledge_base_ids,
                    db=self.db_session,
                    max_results=max_results,
                    document_ids=resolved_document_ids,
                    user_name=self.user_name,
                    route_mode=route_mode,
                    user_id=self.user_id,
                    context_window=self._get_effective_context_window(),
                    used_context_tokens=self._get_used_context_tokens(),
                    reserved_output_tokens=DEFAULT_RESERVED_OUTPUT_TOKENS,
                    context_buffer_ratio=self.context_buffer_ratio,
                    max_direct_chunks=self.max_direct_chunks,
                    restricted_mode=self._is_restricted_search_only(),
                )

                if self.user_subtask_id:
                    from app.services.knowledge.retrieval_persistence import (
                        retrieval_persistence_service,
                    )

                    retrieval_persistence_service.persist_retrieval_result(
                        db=self.db_session,
                        user_subtask_id=self.user_subtask_id,
                        user_id=self.user_id,
                        query=query,
                        mode=result.get("mode", InjectionMode.RAG_ONLY),
                        records=result.get("records", []),
                        restricted_mode=self._is_restricted_search_only(),
                    )

                if self._is_restricted_search_only():
                    from app.services.knowledge.protected_mediation import (
                        protected_knowledge_mediator,
                    )

                    mediated_result = await protected_knowledge_mediator.transform(
                        db=self.db_session,
                        query=query,
                        retrieval_mode=result.get("mode", InjectionMode.RAG_ONLY),
                        records=result.get("records", []),
                        mediation_context=self._build_mediation_context(),
                        knowledge_base_ids=self.knowledge_base_ids,
                        total_estimated_tokens=result.get("total_estimated_tokens", 0),
                        user_id=self.user_id,
                        user_name=self.user_name or "system",
                    )
                    result = mediated_result.model_dump()
            except ImportError:
                result = await self._retrieve_with_strategy_via_http(
                    query=query,
                    max_results=max_results,
                    route_mode=route_mode,
                )

        mode = result.get("mode", InjectionMode.RAG_ONLY)
        logger.info(
            "[KnowledgeBaseTool] Retrieved %d records via Backend route mode=%s",
            len(result.get("records", [])),
            mode,
        )
        return mode, result

    async def _retrieve_with_strategy_via_http(
        self,
        query: str,
        max_results: int,
        route_mode: str = "auto",
        document_ids: Optional[list[int]] = None,
        document_names: Optional[list[str]] = None,
    ) -> Dict[str, Any]:
        """Retrieve KB data from Backend internal retrieve endpoint."""
        import httpx

        from chat_shell.core.config import settings

        remote_url = getattr(settings, "REMOTE_STORAGE_URL", "")
        if remote_url:
            backend_url = remote_url.replace("/api/internal", "")
        else:
            backend_url = getattr(settings, "BACKEND_API_URL", "http://localhost:8000")

        payload = {
            "query": query,
            "knowledge_base_ids": self.knowledge_base_ids,
            "max_results": max_results,
            "route_mode": route_mode,
            "runtime_context": self._build_runtime_context(),
        }
        persistence_context = self._build_persistence_context()
        if persistence_context:
            payload["persistence_context"] = persistence_context
        mediation_context = self._build_mediation_context()
        if mediation_context:
            payload["mediation_context"] = mediation_context
        if document_ids:
            payload["document_ids"] = document_ids
        if document_names:
            payload["document_names"] = document_names
        if self.user_name is not None:
            payload["user_name"] = self.user_name

        headers = {}
        auth_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", "") or self.auth_token
        if auth_token:
            headers["Authorization"] = f"Bearer {auth_token}"

        async with httpx.AsyncClient(timeout=60.0) as client:
            response = await client.post(
                f"{backend_url}/api/internal/rag/retrieve",
                json=payload,
                headers=headers,
            )

            if response.status_code != 200:
                logger.warning(
                    "[KnowledgeBaseTool] HTTP internal retrieve returned %s: %s",
                    response.status_code,
                    response.text,
                )
                return {
                    "mode": InjectionMode.RAG_ONLY,
                    "records": [],
                    "total": 0,
                }

            data = response.json()
            logger.info(
                "[KnowledgeBaseTool] HTTP internal retrieve mode=%s records=%d",
                data.get("mode"),
                len(data.get("records", [])),
            )
            return data

    async def _format_direct_injection_result(
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
        # Extract chunks used for source references and formatted output
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
                        "title": self._display_source_title(source_file, source_index),
                        "kb_id": kb_id,
                    }
                )
                source_index += 1

        injected_content = injection_result.get("injected_content", "")
        self._accumulated_tokens += self._estimate_tokens_from_content(injected_content)

        # Build call statistics header
        stats_header = self._build_call_statistics_header(
            warning_level, len(chunks_used)
        )

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
                "message": (
                    "All knowledge base content has been fully injected above. "
                    "No further retrieval is needed - you have access to the complete knowledge base. "
                    "Please answer the user's question based on the injected content."
                ),
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
                            "title": self._display_source_title(
                                source_file, source_index
                            ),
                            "kb_id": kb_id,
                        }
                    )
                    source_index += 1

                all_chunks.append(
                    {
                        "content": chunk["content"],
                        "source": self._display_source_title(
                            source_file, seen_sources[source_key]
                        ),
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

        total_content = "\n".join([chunk["content"] for chunk in all_chunks])
        self._accumulated_tokens += self._estimate_tokens_from_content(total_content)

        # Build call statistics header
        stats_header = self._build_call_statistics_header(
            warning_level, len(all_chunks)
        )

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
