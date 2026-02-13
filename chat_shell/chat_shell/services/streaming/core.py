# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Core streaming logic for Chat Shell Service.

This module provides the unified streaming infrastructure that handles:
- Semaphore-based concurrency control
- Cancellation event management via local asyncio.Event
- SSE response streaming
"""

import asyncio
import logging
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Optional, Protocol

from chat_shell.core.config import settings

from .emitters import StreamEmitter

logger = logging.getLogger(__name__)

# Constants for reasoning markers
REASONING_START = "__REASONING__"
REASONING_END = "__END_REASONING__"

# Constants for truncation markers (matching graph_builder.py)
TRUNCATED_START = "__TRUNCATED__"
TRUNCATED_END = "__END_TRUNCATED__"

# Bilingual truncation warning message
TRUNCATION_WARNING_MESSAGE = """

---
⚠️ Content Truncated: Model output reached token limit, response may be incomplete."""

# Semaphore for concurrent chat limit (lazy initialized)
_chat_semaphore: Optional[asyncio.Semaphore] = None
_semaphore_lock = threading.Lock()


def get_chat_semaphore() -> asyncio.Semaphore:
    """Get or create the chat semaphore for concurrency limiting."""
    global _chat_semaphore
    if _chat_semaphore is None:
        with _semaphore_lock:
            if _chat_semaphore is None:
                _chat_semaphore = asyncio.Semaphore(settings.MAX_CONCURRENT_CHATS)
    return _chat_semaphore


def should_display_tool_details(tool_name: str) -> bool:
    """Check if a tool should display detailed input/output based on whitelist.

    Uses substring matching - if any whitelist keyword is contained in the tool_name,
    the tool will display details. For example, "read" will match "read_file", "file_read", etc.

    Args:
        tool_name: Name of the tool to check

    Returns:
        True if tool should display details, False otherwise
    """
    whitelist = settings.TOOL_DISPLAY_WHITELIST.strip()

    # Empty string or "*" means all tools display details
    if not whitelist or whitelist == "*":
        return True

    # Check if any whitelist keyword is contained in tool_name
    whitelisted_keywords = [keyword.strip() for keyword in whitelist.split(",")]
    return any(keyword in tool_name for keyword in whitelisted_keywords if keyword)


class StorageHandlerProtocol(Protocol):
    """Protocol for storage handler operations."""

    async def register_stream(self, subtask_id: int) -> asyncio.Event:
        """Register a stream and return a cancellation event."""
        ...

    async def unregister_stream(self, subtask_id: int) -> None:
        """Unregister a stream."""
        ...


@dataclass
class StreamingState:
    """State container for a streaming session."""

    task_id: int
    subtask_id: int
    user_id: int
    user_name: str = ""
    is_group_chat: bool = False
    message_id: Optional[int] = None
    shell_type: str = "Chat"

    # Runtime state
    full_response: str = ""
    offset: int = 0
    sources: list = field(default_factory=list)
    reasoning_content: str = ""

    # TTFT tracking
    stream_start_time: Optional[float] = None
    first_token_received: bool = False

    # Silent exit state
    is_silent_exit: bool = False
    silent_exit_reason: str = ""

    # Truncation state (when model output reaches max_token limit)
    is_truncated: bool = False
    truncation_reason: str = ""

    # Loaded skills tracking (for persistence across conversation turns)
    loaded_skills: list = field(default_factory=list)

    def append_content(self, token: str) -> None:
        """Append token to accumulated response."""
        self.full_response += token
        self.offset += len(token)

    def append_reasoning(self, content: str) -> None:
        """Append reasoning content."""
        self.reasoning_content += content

    def add_sources(self, sources: list) -> None:
        """Add knowledge base sources for citation."""
        existing_keys = {(s.get("kb_id"), s.get("title")) for s in self.sources}
        for source in sources:
            kb_id = source.get("kb_id")
            title = source.get("title")
            if kb_id is None or title is None:
                continue
            key = (kb_id, title)
            if key not in existing_keys:
                self.sources.append(source)
                existing_keys.add(key)

    def add_loaded_skill(self, skill_name: str) -> None:
        """Add a loaded skill name for persistence across conversation turns.

        Args:
            skill_name: Name of the skill that was loaded via load_skill tool
        """
        if skill_name and skill_name not in self.loaded_skills:
            self.loaded_skills.append(skill_name)
            logger.info(
                "[StreamingState] Added loaded skill: %s (total: %d)",
                skill_name,
                len(self.loaded_skills),
            )

    def set_truncated(self, reason: str) -> None:
        """Mark the response as truncated due to max_token limit.

        Args:
            reason: The truncation reason from the model (e.g., "length", "max_tokens", "MAX_TOKENS")
        """
        self.is_truncated = True
        self.truncation_reason = reason
        logger.info(
            "[StreamingState] Response marked as truncated: reason=%s",
            reason,
        )

    def get_current_result(
        self,
        include_value: bool = True,
        include_sources: bool = True,
    ) -> dict:
        """Get current result with sources.

        Args:
            include_value: Include the full response value
            include_sources: Include knowledge base sources
        """
        result: dict = {"shell_type": self.shell_type}
        if include_value:
            result["value"] = self.full_response
        # Sources should be included for knowledge base citations
        if include_sources and self.sources:
            result["sources"] = self.sources
        if self.reasoning_content:
            result["reasoning_content"] = self.reasoning_content
        # Include silent exit flag if set
        if self.is_silent_exit:
            result["silent_exit"] = True
            if self.silent_exit_reason:
                result["silent_exit_reason"] = self.silent_exit_reason
        # Include truncation flag if set
        if self.is_truncated:
            result["truncated"] = True
            if self.truncation_reason:
                result["truncation_reason"] = self.truncation_reason
        # Include loaded skills for persistence across conversation turns
        # This is saved to result and used by restore_from_history
        if include_value and self.loaded_skills:
            result["loaded_skills"] = self.loaded_skills
        return result


@dataclass
class StreamingConfig:
    """Configuration for streaming behavior."""

    semaphore_timeout: float = 5.0


class StreamingCore:
    """Core streaming logic for SSE responses.

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
        config: Optional[StreamingConfig] = None,
        storage_handler: Optional[StorageHandlerProtocol] = None,
    ):
        """Initialize streaming core."""
        self.emitter = emitter
        self.state = state
        self.config = config or StreamingConfig()

        # Use provided storage handler or import default
        if storage_handler is None:
            from chat_shell.services.storage.session import session_manager

            self._storage = storage_handler
        else:
            self._storage = storage_handler

        self._semaphore = get_chat_semaphore()
        self._acquired = False
        self._cancel_event: Optional[asyncio.Event] = None
        self._mcp_client: Any = None

    @property
    def cancel_event(self) -> Optional[asyncio.Event]:
        """Get the cancellation event."""
        return self._cancel_event

    async def acquire_resources(self) -> bool:
        """Acquire semaphore and register stream."""
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
            return False

        # Register stream for cancellation
        if self._storage:
            self._cancel_event = await self._storage.register_stream(
                self.state.subtask_id
            )
        else:
            self._cancel_event = asyncio.Event()

        # Record stream start time for TTFT calculation
        self.state.stream_start_time = time.time()

        # Emit start event via emitter
        await self.emitter.emit_start(
            self.state.task_id,
            self.state.subtask_id,
            self.state.shell_type,
        )

        return True

    async def release_resources(self) -> None:
        """Release all acquired resources."""
        try:
            if self._storage:
                await self._storage.unregister_stream(self.state.subtask_id)

            if self._mcp_client:
                await self._mcp_client.disconnect()
                self._mcp_client = None
        finally:
            if self._acquired:
                self._semaphore.release()
                self._acquired = False

    def is_cancelled(self) -> bool:
        """Check if streaming has been cancelled."""
        return self._cancel_event is not None and self._cancel_event.is_set()

    async def process_token(self, token: str) -> bool:
        """Process a single token from the stream.

        Returns:
            True if processing should continue, False if cancelled
        """
        # Log TTFT (Time To First Token) for the first token
        if not self.state.first_token_received and self.state.stream_start_time:
            ttft_ms = (time.time() - self.state.stream_start_time) * 1000
            self.state.first_token_received = True
            logger.info(
                "[CHAT_SHELL_TTFT] First token received: subtask_id=%d, task_id=%d, "
                "ttft_ms=%.2f, token_len=%d",
                self.state.subtask_id,
                self.state.task_id,
                ttft_ms,
                len(token),
            )

        logger.debug(
            "[STREAMING] process_token: subtask_id=%d, token_len=%d",
            self.state.subtask_id,
            len(token),
        )

        # Check for cancellation
        if self.is_cancelled():
            logger.info(
                "[STREAMING] Cancelled: subtask_id=%d, response_len=%d",
                self.state.subtask_id,
                len(self.state.full_response),
            )
            await self.emitter.emit_cancelled(self.state.subtask_id)
            return False

        # Check for reasoning content marker
        if token.startswith(REASONING_START) and token.endswith(REASONING_END):
            reasoning_text = token[len(REASONING_START) : -len(REASONING_END)]
            self.state.append_reasoning(reasoning_text)

            result = self.state.get_current_result(include_value=False)
            result["reasoning_chunk"] = reasoning_text
            await self.emitter.emit_chunk(
                "",
                self.state.offset,
                self.state.subtask_id,
                result=result,
            )
            return True

        # Check for truncation marker
        if token.startswith(TRUNCATED_START) and token.endswith(TRUNCATED_END):
            truncation_reason = token[len(TRUNCATED_START) : -len(TRUNCATED_END)]
            self.state.set_truncated(truncation_reason)
            # Don't yield the marker itself as content, just record the state
            return True

        # Regular content
        self.state.append_content(token)

        result = self.state.get_current_result(include_value=False)

        await self.emitter.emit_chunk(
            token,
            self.state.offset - len(token),
            self.state.subtask_id,
            result=result,
        )

        return True

    async def finalize(self) -> dict:
        """Finalize streaming and return results."""
        # Handle truncation: append warning message and emit error event
        if self.state.is_truncated:
            # Append bilingual warning message to the response
            self.state.append_content(TRUNCATION_WARNING_MESSAGE)

            # Emit error event for truncation
            await self.emitter.emit_error(
                self.state.subtask_id,
                f"Content truncated due to max_token limit (reason: {self.state.truncation_reason})",
            )

        result = self.state.get_current_result(include_value=True)

        logger.debug(
            "[STREAMING] Finalize result: subtask=%d truncated=%s",
            self.state.subtask_id,
            self.state.is_truncated,
        )

        # Emit done event via emitter
        await self.emitter.emit_done(
            self.state.task_id,
            self.state.subtask_id,
            self.state.offset,
            result,
            message_id=self.state.message_id,
        )

        return result

    async def handle_error(self, error: Exception) -> None:
        """Handle streaming error."""
        logger.exception(
            "[STREAMING] subtask=%s error",
            self.state.subtask_id,
        )

        error_msg = str(error)
        await self.emitter.emit_error(self.state.subtask_id, error_msg)

        # Emit done event with error
        result = {
            "value": self.state.full_response,
            "error": error_msg,
            "shell_type": self.state.shell_type,
        }

        await self.emitter.emit_done(
            self.state.task_id,
            self.state.subtask_id,
            self.state.offset,
            result,
            message_id=self.state.message_id,
        )

    def set_mcp_client(self, client: Any) -> None:
        """Set MCP client for cleanup on release."""
        self._mcp_client = client
