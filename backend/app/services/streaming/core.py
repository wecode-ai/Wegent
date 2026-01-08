# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Core streaming logic for streaming services.

This module provides the unified streaming infrastructure that handles:
- Semaphore-based concurrency control
- Cancellation event management
- Periodic content saving (Redis and DB)
- Final result persistence
- Shutdown manager integration

Both SSE and WebSocket streaming use this core logic.
This is a generic streaming core that can be used by different services.
"""

import asyncio
import logging
import threading
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Protocol

from app.core.config import settings

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


class StorageHandlerProtocol(Protocol):
    """Protocol for storage handler operations.

    This protocol defines the interface that storage handlers must implement
    to work with StreamingCore. This allows for dependency injection and
    easier testing.
    """

    async def register_stream(self, subtask_id: int) -> asyncio.Event:
        """Register a stream and return a cancellation event."""
        ...

    async def unregister_stream(self, subtask_id: int) -> None:
        """Unregister a stream."""
        ...

    async def save_streaming_content(self, subtask_id: int, content: str) -> None:
        """Save streaming content to cache."""
        ...

    async def delete_streaming_content(self, subtask_id: int) -> None:
        """Delete streaming content from cache."""
        ...

    async def publish_streaming_done(
        self, subtask_id: int, result: dict[str, Any]
    ) -> None:
        """Publish streaming done signal."""
        ...

    async def update_subtask_status(
        self,
        subtask_id: int,
        status: str,
        result: dict[str, Any] | None = None,
        error: str | None = None,
    ) -> None:
        """Update subtask status in database."""
        ...

    async def get_subtask_message_id(self, subtask_id: int) -> int | None:
        """Get message ID for a subtask."""
        ...


@dataclass
class StreamingState:
    """State container for a streaming session.

    Holds all the context needed during streaming, including
    identifiers, content accumulation, thinking steps, and timing information.

    This is a generic state container that can be extended for specific use cases.
    """

    task_id: int
    subtask_id: int
    user_id: int
    user_name: str = ""
    is_group_chat: bool = False
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
    reasoning_content: str = ""  # Reasoning/thinking content from DeepSeek R1 etc.

    def append_content(self, token: str) -> None:
        """Append token to accumulated response."""
        self.full_response += token
        self.offset += len(token)

    def append_reasoning(self, content: str) -> None:
        """Append reasoning content (from DeepSeek R1 and similar models)."""
        self.reasoning_content += content

    def add_thinking_step(self, step: dict[str, Any]) -> None:
        """Add a thinking step (tool call)."""
        self.thinking.append(step)

    def add_sources(self, sources: list[dict[str, Any]]) -> None:
        """Add knowledge base sources for citation.

        Only accepts knowledge base sources with kb_id and title.
        URL sources from web search are currently not supported by frontend.
        """
        # Merge sources, avoiding duplicates based on (kb_id, title)
        existing_keys = {(s.get("kb_id"), s.get("title")) for s in self.sources}
        for source in sources:
            # Skip URL type sources (not supported by frontend yet)
            if source.get("type") == "url":
                continue

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

    def get_current_result(
        self,
        include_value: bool = True,
        include_thinking: bool = True,
        slim_thinking: bool = False,
    ) -> dict[str, Any]:
        """Get current result with thinking steps and sources for WebSocket emission.

        Args:
            include_value: Whether to include full_response as 'value' field.
                          Set to False for chunk events to reduce data size.
                          Set to True for done events and periodic DB saves.
            include_thinking: Whether to include thinking steps and sources.
                             Set to False for Chat mode chunk events (only need token).
                             Set to True for Code mode or done events.
            slim_thinking: Whether to slim down thinking data for Chat mode.
                          When True, removes large fields like input/output details
                          that frontend doesn't need for simple display.

        Returns:
            Result dictionary with shell_type, and optionally value, thinking, sources.
        """
        result: dict[str, Any] = {
            "shell_type": self.shell_type,  # Include shell_type for frontend display
        }
        if include_value:
            result["value"] = self.full_response
        if include_thinking:
            if self.thinking:
                if slim_thinking:
                    # For Chat mode: slim down thinking data to reduce payload size
                    # Frontend SimpleThinkingView only needs: title, run_id, details.type,
                    # details.status, details.tool_name, and optionally count for web_search
                    result["thinking"] = self._slim_thinking_data(self.thinking)
                else:
                    result["thinking"] = self.thinking
            if self.sources:
                result["sources"] = self.sources  # Include sources for citation display
        # Include reasoning_content if present (DeepSeek R1 and similar reasoning models)
        if self.reasoning_content:
            result["reasoning_content"] = self.reasoning_content
        return result

    def _slim_thinking_data(
        self, thinking: list[dict[str, Any]]
    ) -> list[dict[str, Any]]:
        """Slim down thinking data for Chat mode to reduce payload size.

        Frontend SimpleThinkingView only needs minimal fields for display.
        This removes large fields like full input/output that aren't displayed.
        """
        slimmed = []
        for step in thinking:
            slim_step: dict[str, Any] = {
                "title": step.get("title", ""),
                "next_action": step.get("next_action", "continue"),
            }
            # Include run_id for matching start/end pairs
            if "run_id" in step:
                slim_step["run_id"] = step["run_id"]

            # Slim down details
            details = step.get("details", {})
            if details:
                slim_details: dict[str, Any] = {
                    "type": details.get("type"),
                    "status": details.get("status"),
                    "tool_name": details.get("tool_name") or details.get("name"),
                }

                # For web_search tool_use, keep only query from input
                if (
                    details.get("type") == "tool_use"
                    and slim_details["tool_name"] == "web_search"
                ):
                    input_data = details.get("input", {})
                    if isinstance(input_data, dict) and "query" in input_data:
                        slim_details["input"] = {"query": input_data["query"]}

                # For web_search tool_result, keep only count from output
                if (
                    details.get("type") == "tool_result"
                    and slim_details["tool_name"] == "web_search"
                ):
                    output = details.get("output") or details.get("content")
                    if output:
                        try:
                            import json

                            if isinstance(output, str):
                                output_data = json.loads(output)
                            else:
                                output_data = output
                            if isinstance(output_data, dict) and "count" in output_data:
                                slim_details["output"] = {"count": output_data["count"]}
                        except (json.JSONDecodeError, TypeError):
                            pass

                slim_step["details"] = slim_details

            slimmed.append(slim_step)
        return slimmed


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
        core = StreamingCore(emitter, state, config, storage_handler)
        if await core.acquire_resources():
            async for token in agent.stream_tokens(messages, cancel_event=core.cancel_event):
                if not await core.process_token(token):
                    break
            await core.finalize()
        await core.release_resources()
    """

    def __init__(
        self,
        emitter: StreamEmitter,
        state: StreamingState,
        config: StreamingConfig | None = None,
        storage_handler: StorageHandlerProtocol | None = None,
    ):
        """Initialize streaming core.

        Args:
            emitter: Stream emitter for output (SSE or WebSocket)
            state: Streaming state container
            config: Optional streaming configuration
            storage_handler: Storage handler for persistence operations.
                           If None, uses the default chat storage handler.
        """
        self.emitter = emitter
        self.state = state
        self.config = config or StreamingConfig()

        # Use provided storage handler or import default
        if storage_handler is None:
            from app.services.chat.storage import storage_handler as default_handler

            self._storage = default_handler
        else:
            self._storage = storage_handler

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
        logger.info(
            f"[StreamingCore] acquire_resources called for task_id={self.state.task_id}, "
            f"subtask_id={self.state.subtask_id}, user_id={self.state.user_id}"
        )

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
            await self._storage.update_subtask_status(
                self.state.subtask_id,
                "FAILED",
                error="Too many concurrent chat requests",
            )
            return False

        # Register stream for cancellation
        self._cancel_event = await self._storage.register_stream(self.state.subtask_id)

        # Set task-level streaming status in Redis for fast lookup
        # This is checked by get_active_streaming() when client reconnects
        from app.services.chat.storage import session_manager

        logger.info(
            f"[StreamingCore] Setting task_streaming_status in Redis: "
            f"task_id={self.state.task_id}, subtask_id={self.state.subtask_id}, "
            f"user_id={self.state.user_id}, user_name={self.state.user_name}"
        )
        set_result = await session_manager.set_task_streaming_status(
            task_id=self.state.task_id,
            subtask_id=self.state.subtask_id,
            user_id=self.state.user_id,
            username=self.state.user_name,
        )
        logger.info(f"[StreamingCore] set_task_streaming_status result: {set_result}")

        # Verify the status was set correctly
        verify_status = await session_manager.get_task_streaming_status(
            self.state.task_id
        )
        logger.info(
            f"[StreamingCore] Verified task_streaming_status after set: {verify_status}"
        )

        # Update status to RUNNING
        await self._storage.update_subtask_status(
            self.state.subtask_id,
            "RUNNING",
        )

        logger.info(
            f"[StreamingCore] acquire_resources completed successfully for task_id={self.state.task_id}"
        )
        return True

    async def release_resources(self) -> None:
        """Release all acquired resources."""
        logger.info(
            f"[StreamingCore] release_resources called for task_id={self.state.task_id}, "
            f"subtask_id={self.state.subtask_id}"
        )
        try:
            # Unregister stream
            await self._storage.unregister_stream(self.state.subtask_id)

            # Delete streaming content cache
            await self._storage.delete_streaming_content(self.state.subtask_id)

            # Clear task-level streaming status from Redis
            from app.services.chat.storage import session_manager

            logger.info(
                f"[StreamingCore] Clearing task_streaming_status for task_id={self.state.task_id}"
            )
            await session_manager.clear_task_streaming_status(self.state.task_id)

            # Disconnect MCP client if present
            if self._mcp_client:
                await self._mcp_client.disconnect()
                self._mcp_client = None
        finally:
            # Release semaphore
            if self._acquired:
                self._semaphore.release()
                self._acquired = False
        logger.info(
            f"[StreamingCore] release_resources completed for task_id={self.state.task_id}"
        )

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
        - Reasoning content extraction (DeepSeek R1 format)
        - Emitting chunk to client
        - Periodic saves to Redis and DB

        Args:
            token: The token to process

        Returns:
            True if processing should continue, False if cancelled
        """
        logger.debug(
            "[STREAMING] process_token: subtask_id=%d, token_len=%d",
            self.state.subtask_id,
            len(token),
        )

        # Check for cancellation (user-initiated or shutdown)
        # When cancelled, we treat it as completed with partial response
        # This is consistent with update_subtask_on_cancel in cancel.py
        if self.is_cancelled():
            logger.info(
                "[STREAMING] Cancelled: subtask_id=%d, response_len=%d",
                self.state.subtask_id,
                len(self.state.full_response),
            )
            await self.emitter.emit_cancelled(self.state.subtask_id)
            # Use COMPLETED status to ensure Task status is properly updated
            # The partial response is preserved in the result
            is_chat_mode = self.state.shell_type == "Chat"
            result = self.state.get_current_result(
                include_value=True,
                include_thinking=True,
                slim_thinking=is_chat_mode,
            )
            await self._storage.update_subtask_status(
                self.state.subtask_id,
                "COMPLETED",
                result=result,
            )
            return False

        # Check for reasoning content marker (DeepSeek R1 format)
        # Format: __REASONING__<content>__END_REASONING__
        reasoning_start = "__REASONING__"
        reasoning_end = "__END_REASONING__"

        if token.startswith(reasoning_start) and token.endswith(reasoning_end):
            # Extract reasoning content
            reasoning_text = token[len(reasoning_start) : -len(reasoning_end)]
            self.state.append_reasoning(reasoning_text)

            # Emit reasoning chunk to client
            is_chat_mode = self.state.shell_type == "Chat"
            result = self.state.get_current_result(
                include_value=False,
                include_thinking=not is_chat_mode,
            )
            # Add reasoning_chunk flag to indicate this is reasoning content
            result["reasoning_chunk"] = reasoning_text
            await self.emitter.emit_chunk(
                "",  # No content chunk for reasoning
                self.state.offset,
                self.state.subtask_id,
                result=result,
            )

            # Periodic saves
            await self._periodic_save()
            return True

        # Regular content - Accumulate content
        self.state.append_content(token)

        # Emit chunk to client with result data
        # - include_value=False: avoid sending full response in every chunk (reduces data size)
        # - include_thinking: only for Code mode (ClaudeCode, Agno), Chat mode only needs token
        # Frontend accumulates content from individual chunks, doesn't need full value
        is_chat_mode = self.state.shell_type == "Chat"
        result = self.state.get_current_result(
            include_value=False,
            include_thinking=not is_chat_mode,  # Chat mode doesn't need thinking in chunks
        )
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
            await self._storage.save_streaming_content(
                self.state.subtask_id,
                self.state.full_response,
            )
            self.state.last_redis_save = current_time

        # Save to DB with thinking data
        if current_time - self.state.last_db_save >= self.config.db_save_interval:
            # For Chat mode with tools, use slim_thinking to reduce payload size
            is_chat_mode = self.state.shell_type == "Chat"
            result = self.state.get_current_result(
                include_value=True,
                include_thinking=True,  # Always include thinking (may have tool calls)
                slim_thinking=is_chat_mode,  # Slim down for Chat mode
            )
            result["streaming"] = True
            # Use update_subtask_status to save the complete result
            await self._storage.update_subtask_status(
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
        # For Chat mode with tools, use slim_thinking to reduce payload size
        # For Chat mode without tools, thinking will be empty anyway
        is_chat_mode = self.state.shell_type == "Chat"
        result = self.state.get_current_result(
            include_value=True,
            include_thinking=True,  # Always include thinking (may have tool calls)
            slim_thinking=is_chat_mode,  # Slim down for Chat mode
        )

        # Save final content to Redis for streaming recovery
        await self._storage.save_streaming_content(
            self.state.subtask_id,
            self.state.full_response,
        )

        # Publish done signal
        await self._storage.publish_streaming_done(
            self.state.subtask_id,
            result,
        )

        # Update subtask status to COMPLETED (persists to DB)
        # Database is the single source of truth for chat history
        await self._storage.update_subtask_status(
            self.state.subtask_id,
            "COMPLETED",
            result=result,
        )

        # Use message_id from state if available, otherwise fetch from DB
        message_id = self.state.message_id
        if message_id is None:
            message_id = await self._storage.get_subtask_message_id(
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
        from shared.telemetry.context import TelemetryEventNames, record_stream_error

        logger.exception(
            "[STREAMING] subtask=%s error",
            self.state.subtask_id,
        )

        error_msg = str(error)

        # Record error in OpenTelemetry trace using unified function
        record_stream_error(
            error=error,
            event_name=TelemetryEventNames.STREAM_ERROR,
            task_id=self.state.task_id,
            subtask_id=self.state.subtask_id,
            extra_attributes={
                "shell_type": self.state.shell_type,
                "response_length": len(self.state.full_response),
                "thinking_steps": len(self.state.thinking),
            },
        )

        # Emit chat:error first
        await self.emitter.emit_error(
            self.state.subtask_id,
            error_msg,
        )

        # Update subtask status to FAILED with error
        await self._storage.update_subtask_status(
            self.state.subtask_id,
            "FAILED",
            error=error_msg,
        )

        # Get message_id for proper ordering
        message_id = self.state.message_id
        if message_id is None:
            message_id = await self._storage.get_subtask_message_id(
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
