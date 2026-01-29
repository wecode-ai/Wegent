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
    thinking: list = field(default_factory=list)
    sources: list = field(default_factory=list)
    reasoning_content: str = ""
    blocks: list = field(
        default_factory=list
    )  # Message blocks for mixed content rendering
    current_text_block_id: Optional[str] = (
        None  # Track current text block for streaming
    )

    # TTFT tracking
    stream_start_time: Optional[float] = None
    first_token_received: bool = False

    # Silent exit state
    is_silent_exit: bool = False
    silent_exit_reason: str = ""

    def append_content(self, token: str) -> None:
        """Append token to accumulated response."""
        self.full_response += token
        self.offset += len(token)

    def append_reasoning(self, content: str) -> None:
        """Append reasoning content."""
        self.reasoning_content += content

    def add_thinking_step(self, step: dict) -> None:
        """Add a thinking step (tool call)."""
        self.thinking.append(step)

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

    def add_block(self, block: dict) -> None:
        """Add a message block (text or tool)."""
        self.blocks.append(block)

    def update_block(self, block_id: str, updates: dict) -> None:
        """Update an existing block by ID."""
        found = False
        for block in self.blocks:
            if block.get("id") == block_id:
                block.update(updates)
                found = True
                break
        if not found:
            import logging

            logger = logging.getLogger(__name__)
            logger.warning(
                "[BLOCK] update_block failed: block_id=%s not found in %d blocks",
                block_id,
                len(self.blocks),
            )

    def get_current_result(
        self,
        include_value: bool = True,
        include_thinking: bool = True,
        slim_thinking: bool = False,
        include_sources: bool = True,
        include_blocks: bool = True,
    ) -> dict:
        """Get current result with thinking steps, sources, and blocks.

        Args:
            include_value: Include the full response value
            include_thinking: Include thinking steps (tool calls)
            slim_thinking: Use slimmed down thinking data (for Chat mode)
            include_sources: Include knowledge base sources (independent of thinking)
            include_blocks: Include message blocks for mixed content rendering
        """
        result: dict = {"shell_type": self.shell_type}
        if include_value:
            result["value"] = self.full_response
        if include_thinking:
            if self.thinking:
                if slim_thinking:
                    result["thinking"] = self._slim_thinking_data(self.thinking)
                else:
                    result["thinking"] = self.thinking
        # Sources should be included independently of thinking steps
        # This ensures knowledge base citations are always available
        if include_sources and self.sources:
            result["sources"] = self.sources
        # Include blocks for mixed content rendering
        if include_blocks and self.blocks:
            result["blocks"] = self.blocks
        if self.reasoning_content:
            result["reasoning_content"] = self.reasoning_content
        # Include silent exit flag if set
        if self.is_silent_exit:
            result["silent_exit"] = True
            if self.silent_exit_reason:
                result["silent_exit_reason"] = self.silent_exit_reason
        return result

    def _slim_thinking_data(self, thinking: list) -> list:
        """Slim down thinking data for Chat mode."""
        slimmed = []
        for step in thinking:
            slim_step: dict = {
                "title": step.get("title", ""),
                "next_action": step.get("next_action", "continue"),
            }
            if "run_id" in step:
                slim_step["run_id"] = step["run_id"]
            # Preserve tool_use_id for tool matching
            if "tool_use_id" in step:
                slim_step["tool_use_id"] = step["tool_use_id"]

            details = step.get("details", {})
            if details:
                slim_details: dict = {
                    "type": details.get("type"),
                    "status": details.get("status"),
                    "tool_name": details.get("tool_name") or details.get("name"),
                }
                # Preserve input for tool_use (tool parameters like file_path)
                if details.get("input"):
                    slim_details["input"] = details["input"]
                # Preserve output/content for tool_result (tool execution results)
                if details.get("output"):
                    slim_details["output"] = details["output"]
                if details.get("content"):
                    slim_details["content"] = details["content"]
                # Preserve is_error for error handling
                if details.get("is_error"):
                    slim_details["is_error"] = details["is_error"]
                # Preserve error field for failed status
                if details.get("error"):
                    slim_details["error"] = details["error"]
                slim_step["details"] = slim_details
            slimmed.append(slim_step)
        return slimmed


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

        # Use provided storage handler or set to None
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

    async def emit_text_block(self, text: str) -> None:
        """Create or update text block for streaming content.

        Args:
            text: Text content to add to the current text block
        """
        import uuid

        if self.state.current_text_block_id is None:
            # Create new text block
            block_id = str(uuid.uuid4())
            block = {
                "id": block_id,
                "type": "text",
                "content": text,
                "status": "streaming",
                "timestamp": time.time(),
            }
            self.state.add_block(block)
            self.state.current_text_block_id = block_id

            logger.debug(
                "[BLOCK] Created text block: block_id=%s subtask=%d content_len=%d",
                block_id,
                self.state.subtask_id,
                len(text),
            )
        else:
            # Update existing text block by appending content
            for block in self.state.blocks:
                if block.get("id") == self.state.current_text_block_id:
                    block["content"] = block.get("content", "") + text
                    break

    async def finalize_text_block(self) -> None:
        """Mark current text block as complete."""
        if self.state.current_text_block_id:
            self.state.update_block(
                self.state.current_text_block_id, {"status": "done"}
            )
            self.state.current_text_block_id = None

    async def emit_tool_block(
        self,
        tool_use_id: str,
        tool_name: str,
        tool_input: dict,
    ) -> None:
        """Create tool block when tool call starts.

        Args:
            tool_use_id: Unique identifier for the tool call
            tool_name: Name of the tool being called
            tool_input: Input parameters for the tool
        """
        # Finalize current text block before starting tool
        await self.finalize_text_block()

        block = {
            "id": tool_use_id,
            "type": "tool",
            "tool_use_id": tool_use_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
            "status": "pending",
            "timestamp": time.time(),
        }
        self.state.add_block(block)

        logger.debug(
            "[BLOCK] Created tool block: tool=%s tool_use_id=%s subtask=%d",
            tool_name,
            tool_use_id,
            self.state.subtask_id,
        )

    async def update_tool_block(
        self,
        tool_use_id: str,
        tool_output: Any = None,
        status: str = "done",
        is_error: bool = False,
    ) -> None:
        """Update tool block when tool execution completes.

        Args:
            tool_use_id: Unique identifier for the tool call
            tool_output: Output result from the tool
            status: Block status ('done' or 'error')
            is_error: Whether the tool execution failed
        """
        updates = {
            "tool_output": tool_output,
            "status": status,
        }

        if is_error:
            updates["type"] = "error"

        logger.debug(
            "[BLOCK] Updating tool block: tool_use_id=%s, has_output=%s, status=%s, existing_blocks=%d",
            tool_use_id,
            tool_output is not None,
            status,
            len(self.state.blocks),
        )
        self.state.update_block(tool_use_id, updates)

        # Verify update was successful
        block_found = any(b.get("id") == tool_use_id for b in self.state.blocks)
        if block_found:
            updated_block = next(
                b for b in self.state.blocks if b.get("id") == tool_use_id
            )
            logger.debug(
                "[BLOCK] Tool block updated successfully: id=%s, status=%s, has_tool_output=%s",
                tool_use_id,
                updated_block.get("status"),
                "tool_output" in updated_block,
            )
        else:
            logger.error(
                "[BLOCK] Tool block update FAILED: id=%s not found in blocks",
                tool_use_id,
            )

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

            is_chat_mode = self.state.shell_type == "Chat"
            result = self.state.get_current_result(
                include_value=False,
                include_thinking=not is_chat_mode,
            )
            result["reasoning_chunk"] = reasoning_text
            await self.emitter.emit_chunk(
                "",
                self.state.offset,
                self.state.subtask_id,
                result=result,
            )
            return True

        # Regular content
        self.state.append_content(token)

        # Create or update text block for mixed content rendering
        await self.emit_text_block(token)

        is_chat_mode = self.state.shell_type == "Chat"
        result = self.state.get_current_result(
            include_value=False,
            include_thinking=not is_chat_mode,
            include_blocks=True,  # Include blocks for mixed content rendering
        )
        await self.emitter.emit_chunk(
            token,
            self.state.offset - len(token),
            self.state.subtask_id,
            result=result,
        )

        return True

    async def finalize(self) -> dict:
        """Finalize streaming and return results."""
        # Finalize any remaining text block
        await self.finalize_text_block()

        is_chat_mode = self.state.shell_type == "Chat"
        result = self.state.get_current_result(
            include_value=True,
            include_thinking=True,
            slim_thinking=is_chat_mode,
            include_blocks=True,  # Include blocks for mixed content rendering
        )

        logger.debug(
            "[BLOCK] Finalize result: subtask=%d blocks_count=%d",
            self.state.subtask_id,
            len(result.get("blocks", [])),
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
        if self.state.thinking:
            result["thinking"] = self.state.thinking

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
