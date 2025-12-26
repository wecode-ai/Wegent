# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Core streaming logic for LangGraph Chat Service.

This module provides the unified streaming infrastructure that handles:
- Semaphore-based concurrency control
- Cancellation event management
- Periodic content saving (Redis and DB)
- Final result persistence
- Shutdown manager integration

Both SSE and WebSocket streaming use this core logic.
"""

import asyncio
import logging
import threading
from dataclasses import dataclass, field
from typing import Any

from langchain_core.tools.base import BaseTool

from app.core.config import settings

from ..storage import storage_handler
from .emitters import StreamEmitter

logger = logging.getLogger(__name__)

# Semaphore for concurrent chat limit (lazy initialized)
_chat_semaphore: asyncio.Semaphore | None = None
_semaphore_lock = threading.Lock()


def get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        with _semaphore_lock:
            if _chat_semaphore is None:
                _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


@dataclass
class StreamingState:
    """State container for a streaming session.

    Holds all the context needed during streaming, including
    identifiers, content accumulation, thinking steps, and timing information.
    """

    task_id: int
    subtask_id: int
    user_id: int
    user_name: str = ""
    is_group_chat: bool = False
    enable_web_search: bool = False
    search_engine: str | None = None
    extra_tools: list[BaseTool] = field(default_factory=list)
    message_id: int | None = None  # Message ID for ordering in frontend
    shell_type: str = (
        "Chat"  # Shell type (Chat, ClaudeCode, Agno, etc.) for frontend display
    )

    # Runtime state
    full_response: str = ""
    offset: int = 0
    last_redis_save: float = 0.0
    last_db_save: float = 0.0
    thinking: list[dict[str, Any]] = field(default_factory=list)  # Tool call steps
    sources: list[dict[str, Any]] = field(
        default_factory=list
    )  # Knowledge base sources for citation

    def append_content(self, token: str) -> None:
        """Append token to accumulated response."""
        self.full_response += token
        self.offset += len(token)

    def add_thinking_step(self, step: dict[str, Any]) -> None:
        """Add a thinking step (tool call)."""
        self.thinking.append(step)

    def add_sources(self, sources: list[dict[str, Any]]) -> None:
        """Add knowledge base sources for citation."""
        # Merge sources, avoiding duplicates based on (kb_id, title)
        # Skip sources with missing required fields to prevent incorrect deduplication
        existing_keys = {(s.get("kb_id"), s.get("title")) for s in self.sources}
        for source in sources:
            kb_id = source.get("kb_id")
            title = source.get("title")

            # Skip sources with missing required fields
            if kb_id is None or title is None:
                logger.warning(
                    "[STREAMING] Skipping source with missing kb_id or title: %s",
                    source,
                )
                continue

            key = (kb_id, title)
            if key not in existing_keys:
                self.sources.append(source)
                existing_keys.add(key)

    def get_current_result(self) -> dict[str, Any]:
        """Get current result with thinking steps and sources for WebSocket emission."""
        result: dict[str, Any] = {
            "value": self.full_response,
            "shell_type": self.shell_type,  # Include shell_type for frontend display
        }
        if self.thinking:
            result["thinking"] = self.thinking
        if self.sources:
            result["sources"] = self.sources  # Include sources for citation display
        return result


@dataclass
class StreamingConfig:
    """Configuration for streaming behavior."""

    redis_save_interval: float = field(
        default_factory=lambda: settings.STREAMING_REDIS_SAVE_INTERVAL
    )
    db_save_interval: float = field(
        default_factory=lambda: settings.STREAMING_DB_SAVE_INTERVAL
    )
    semaphore_timeout: float = 5.0


class StreamingCore:
    """Core streaming logic shared between SSE and WebSocket.

    This class encapsulates the common streaming workflow:
    1. Acquire semaphore for concurrency control
    2. Register stream for cancellation support
    3. Update status to RUNNING
    4. Stream tokens with periodic saves
    5. Save final result and update status
    6. Cleanup resources

    Usage:
        core = StreamingCore(emitter, state, config)
        async with core.streaming_context():
            async for token in agent.stream_tokens(messages, cancel_event=core.cancel_event):
                await core.process_token(token)
            await core.finalize()
    """

    def __init__(
        self,
        emitter: StreamEmitter,
        state: StreamingState,
        config: StreamingConfig | None = None,
    ):
        """Initialize streaming core.

        Args:
            emitter: Stream emitter for output (SSE or WebSocket)
            state: Streaming state container
            config: Optional streaming configuration
        """
        self.emitter = emitter
        self.state = state
        self.config = config or StreamingConfig()

        self._semaphore = get_chat_semaphore()
        self._acquired = False
        self._cancel_event: asyncio.Event | None = None
        self._mcp_client: Any = None

    @property
    def cancel_event(self) -> asyncio.Event | None:
        """Get the cancellation event."""
        return self._cancel_event

    async def acquire_resources(self) -> bool:
        """Acquire semaphore and register stream.

        Returns:
            True if resources acquired successfully, False otherwise
        """
        # Try to acquire semaphore with timeout
        try:
            self._acquired = await asyncio.wait_for(
                self._semaphore.acquire(),
                timeout=self.config.semaphore_timeout,
            )
        except asyncio.TimeoutError:
            await self.emitter.emit_error(
                self.state.subtask_id,
                "Too many concurrent chat requests",
            )
            await storage_handler.update_subtask_status(
                self.state.subtask_id,
                "FAILED",
                error="Too many concurrent chat requests",
            )
            return False

        # Register stream for cancellation
        self._cancel_event = await storage_handler.register_stream(
            self.state.subtask_id
        )

        # Update status to RUNNING
        await storage_handler.update_subtask_status(
            self.state.subtask_id,
            "RUNNING",
        )

        return True

    async def release_resources(self) -> None:
        """Release all acquired resources."""
        try:
            # Unregister stream
            await storage_handler.unregister_stream(self.state.subtask_id)

            # Delete streaming content cache
            await storage_handler.delete_streaming_content(self.state.subtask_id)

            # Disconnect MCP client if present
            if self._mcp_client:
                await self._mcp_client.disconnect()
                self._mcp_client = None
        finally:
            # Release semaphore
            if self._acquired:
                self._semaphore.release()
                self._acquired = False

    def is_cancelled(self) -> bool:
        """Check if streaming has been cancelled."""
        return self._cancel_event is not None and self._cancel_event.is_set()

    def is_shutting_down(self) -> bool:
        """Check if server is shutting down."""
        from app.core.shutdown import shutdown_manager

        return shutdown_manager.is_shutting_down

    async def process_token(self, token: str) -> bool:
        """Process a single token from the stream.

        Handles:
        - Content accumulation
        - Emitting chunk to client
        - Periodic saves to Redis and DB

        Args:
            token: The token to process

        Returns:
            True if processing should continue, False if cancelled/shutdown
        """
        logger.debug(
            "[STREAMING] process_token: subtask_id=%d, token_len=%d",
            self.state.subtask_id,
            len(token),
        )

        # Check for cancellation or shutdown
        if self.is_cancelled() or self.is_shutting_down():
            logger.info(
                "[STREAMING] Cancelled or shutting down: subtask_id=%d",
                self.state.subtask_id,
            )
            await self.emitter.emit_cancelled(self.state.subtask_id)
            await storage_handler.update_subtask_status(
                self.state.subtask_id,
                "CANCELLED",
            )
            return False

        # Accumulate content
        self.state.append_content(token)

        # Emit chunk to client with result data (including shell_type and thinking if available)
        # Always send result to include shell_type for frontend display logic
        result = self.state.get_current_result()
        await self.emitter.emit_chunk(
            token,
            self.state.offset - len(token),  # offset before this token
            self.state.subtask_id,
            result=result,  # Include result with shell_type for frontend display
        )

        # Periodic saves
        await self._periodic_save()

        return True

    async def _periodic_save(self) -> None:
        """Perform periodic saves to Redis and DB."""
        current_time = asyncio.get_event_loop().time()

        # Save to Redis
        if current_time - self.state.last_redis_save >= self.config.redis_save_interval:
            await storage_handler.save_streaming_content(
                self.state.subtask_id,
                self.state.full_response,
            )
            self.state.last_redis_save = current_time

        # Save to DB with thinking data
        if current_time - self.state.last_db_save >= self.config.db_save_interval:
            # Get current result with thinking steps (same as finalize)
            result = self.state.get_current_result()
            result["streaming"] = True
            # Use update_subtask_status to save the complete result
            await storage_handler.update_subtask_status(
                self.state.subtask_id,
                "RUNNING",
                result=result,
            )
            self.state.last_db_save = current_time

    async def finalize(self) -> dict[str, Any]:
        """Finalize streaming and save results.

        Returns:
            Result dictionary with the full response and thinking steps
        """
        result = self.state.get_current_result()

        # Save final content to Redis for streaming recovery
        await storage_handler.save_streaming_content(
            self.state.subtask_id,
            self.state.full_response,
        )

        # Publish done signal
        await storage_handler.publish_streaming_done(
            self.state.subtask_id,
            result,
        )

        # Update subtask status to COMPLETED (persists to DB)
        # Database is the single source of truth for chat history
        await storage_handler.update_subtask_status(
            self.state.subtask_id,
            "COMPLETED",
            result=result,
        )

        # Use message_id from state if available, otherwise fetch from DB
        message_id = self.state.message_id
        if message_id is None:
            message_id = await storage_handler.get_subtask_message_id(
                self.state.subtask_id
            )

        # Emit done event with message_id for proper ordering
        await self.emitter.emit_done(
            self.state.task_id,
            self.state.subtask_id,
            self.state.offset,
            result,
            message_id=message_id,
        )

        return result

    async def handle_error(self, error: Exception) -> None:
        """Handle streaming error.

        Args:
            error: The exception that occurred
        """
        logger.exception(
            "[STREAMING] subtask=%s error",
            self.state.subtask_id,
        )

        error_msg = str(error)

        # Emit chat:error first
        await self.emitter.emit_error(
            self.state.subtask_id,
            error_msg,
        )

        # Update subtask status to FAILED with error
        await storage_handler.update_subtask_status(
            self.state.subtask_id,
            "FAILED",
            error=error_msg,
        )

        # Get message_id for proper ordering
        message_id = self.state.message_id
        if message_id is None:
            message_id = await storage_handler.get_subtask_message_id(
                self.state.subtask_id
            )

        # CRITICAL: Also emit chat:done to signal stream completion
        # This ensures frontend knows the stream has ended and can properly order messages
        # The result.error field tells frontend to preserve error status
        result = {
            "value": self.state.full_response,  # Partial response if any
            "error": error_msg,  # Include error in result
            "shell_type": self.state.shell_type,
        }
        if self.state.thinking:
            result["thinking"] = self.state.thinking

        await self.emitter.emit_done(
            self.state.task_id,
            self.state.subtask_id,
            self.state.offset,
            result,
            message_id=message_id,
        )

        logger.info(
            f"[STREAMING] Emitted chat:error and chat:done for failed stream: "
            f"task={self.state.task_id} subtask={self.state.subtask_id} message_id={message_id}"
        )

    def set_mcp_client(self, client: Any) -> None:
        """Set MCP client for cleanup on release."""
        self._mcp_client = client


def truncate_list_keep_ends(items: list[Any], first_n: int, last_n: int) -> list[Any]:
    """Truncate a list keeping first N and last M items.

    Useful for chat history truncation to maintain context while limiting size.

    Args:
        items: List to truncate
        first_n: Number of items to keep from the start
        last_n: Number of items to keep from the end

    Returns:
        Truncated list, or original if len(items) <= first_n + last_n
    """
    if len(items) <= first_n + last_n:
        return items
    return items[:first_n] + items[-last_n:]
