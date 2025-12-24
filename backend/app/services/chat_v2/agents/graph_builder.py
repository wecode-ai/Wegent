# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph graph builder for agent workflows.

This module provides a simplified LangGraph agent implementation using:
- LangGraph's prebuilt create_react_agent for ReAct workflow
- LangChain's convert_to_messages for message format conversion
- Streaming support with cancellation
- State checkpointing for resumability
"""

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any, Callable

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage
from langchain_core.messages.utils import convert_to_messages
from langchain_core.tools.base import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.prebuilt import create_react_agent

from ..tools.base import ToolRegistry

logger = logging.getLogger(__name__)


class LangGraphAgentBuilder:
    """Builder for LangGraph-based agent workflows using prebuilt ReAct agent."""

    def __init__(
        self,
        llm: BaseChatModel,
        tool_registry: ToolRegistry | None = None,
        max_iterations: int = 10,
        enable_checkpointing: bool = False,
    ):
        """Initialize agent builder.

        Args:
            llm: LangChain chat model instance
            tool_registry: Registry of available tools (optional)
            max_iterations: Maximum tool loop iterations
            enable_checkpointing: Enable state checkpointing for resumability
        """
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_iterations = max_iterations
        self.enable_checkpointing = enable_checkpointing
        self._agent = None

        # Get all LangChain tools from registry
        self.tools: list[BaseTool] = []
        if self.tool_registry:
            self.tools = self.tool_registry.get_all()

    def _build_agent(self):
        """Build the LangGraph ReAct agent lazily."""
        if self._agent is not None:
            return self._agent

        # Use LangGraph's prebuilt create_react_agent
        checkpointer = MemorySaver() if self.enable_checkpointing else None

        self._agent = create_react_agent(
            model=self.llm,
            tools=self.tools,
            checkpointer=checkpointer,
        )

        return self._agent

    async def execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> dict[str, Any]:
        """Execute agent workflow (non-streaming).

        Args:
            messages: Initial conversation messages (OpenAI format)
            config: Optional configuration (thread_id for checkpointing)
            cancel_event: Optional cancellation event (not used in non-streaming)

        Returns:
            Final agent state with response
        """
        agent = self._build_agent()

        # Use LangChain's built-in convert_to_messages
        lc_messages = convert_to_messages(messages)

        exec_config = {"configurable": config} if config else None

        # Execute with recursion limit for max iterations
        result = await agent.ainvoke(
            {"messages": lc_messages},
            config={
                **(exec_config or {}),
                "recursion_limit": self.max_iterations * 2 + 1,
            },
        )

        return result

    async def stream_execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncGenerator[dict[str, Any], None]:
        """Stream agent workflow execution.

        Args:
            messages: Initial conversation messages
            config: Optional configuration (thread_id for checkpointing)
            cancel_event: Optional cancellation event

        Yields:
            State updates as they occur
        """
        agent = self._build_agent()
        lc_messages = convert_to_messages(messages)

        exec_config = {"configurable": config} if config else None

        async for event in agent.astream(
            {"messages": lc_messages},
            config={
                **(exec_config or {}),
                "recursion_limit": self.max_iterations * 2 + 1,
            },
        ):
            # Check cancellation
            if cancel_event and cancel_event.is_set():
                logger.info("Streaming cancelled by user")
                return
            yield event

    async def stream_tokens(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
    ) -> AsyncGenerator[str, None]:
        """Stream tokens from agent execution.

        Uses LangGraph's astream_events API for token-level streaming.
        For models that don't support streaming, falls back to extracting
        final content from on_chain_end event.

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional callback for tool events (kind, event_data)

        Yields:
            Content tokens as they are generated
        """
        agent = self._build_agent()
        lc_messages = convert_to_messages(messages)

        exec_config = {"configurable": config} if config else None

        event_count = 0
        streamed_content = False  # Track if we've streamed any content
        final_content = ""  # Store final content for non-streaming fallback

        try:
            async for event in agent.astream_events(
                {"messages": lc_messages},
                config={
                    **(exec_config or {}),
                    "recursion_limit": self.max_iterations * 2 + 1,
                },
                version="v2",
            ):
                event_count += 1
                # Check cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info("Streaming cancelled by user")
                    return

                # Handle token streaming events
                kind = event.get("event", "")

                # Log all events for debugging (first 10 and every 100th)
                if event_count <= 10 or event_count % 100 == 0:
                    logger.info(
                        "[stream_tokens] Event #%d: kind=%s, name=%s",
                        event_count,
                        kind,
                        event.get("name", "N/A"),
                    )

                if kind == "on_chat_model_stream":
                    data = event.get("data", {})
                    chunk = data.get("chunk")

                    # Log chunk details for debugging
                    if chunk:
                        logger.debug(
                            "[stream_tokens] on_chat_model_stream: chunk_type=%s, has_content=%s, content_type=%s",
                            type(chunk).__name__,
                            hasattr(chunk, "content"),
                            (
                                type(chunk.content).__name__
                                if hasattr(chunk, "content")
                                else "N/A"
                            ),
                        )

                    if chunk and hasattr(chunk, "content"):
                        content = chunk.content
                        # Handle different content types
                        if isinstance(content, str) and content:
                            logger.debug(
                                "[stream_tokens] Yielding string content: %s...",
                                content[:50] if len(content) > 50 else content,
                            )
                            streamed_content = True
                            yield content
                        elif isinstance(content, list):
                            # Handle list content (e.g., multimodal or tool calls)
                            for part in content:
                                if isinstance(part, str) and part:
                                    logger.debug(
                                        "[stream_tokens] Yielding list string: %s...",
                                        part[:50] if len(part) > 50 else part,
                                    )
                                    streamed_content = True
                                    yield part
                                elif isinstance(part, dict):
                                    # Extract text from dict format
                                    text = part.get("text", "")
                                    if text:
                                        logger.debug(
                                            "[stream_tokens] Yielding dict text: %s...",
                                            text[:50] if len(text) > 50 else text,
                                        )
                                        streamed_content = True
                                        yield text
                        # Log when content is empty or unexpected type
                        elif content:
                            logger.debug(
                                "[stream_tokens] Unexpected content type: %s, value: %s",
                                type(content).__name__,
                                str(content)[:100],
                            )
                        # Log empty content case
                        else:
                            logger.debug("[stream_tokens] Empty content in chunk")

                elif kind == "on_chain_end" and event.get("name") == "LangGraph":
                    # Extract final content from the top-level LangGraph chain end
                    # This is useful for non-streaming models
                    data = event.get("data", {})
                    output = data.get("output", {})
                    messages_output = output.get("messages", [])

                    if messages_output:
                        # Get the last AI message
                        for msg in reversed(messages_output):
                            if isinstance(msg, AIMessage):
                                if isinstance(msg.content, str):
                                    final_content = msg.content
                                elif isinstance(msg.content, list):
                                    # Handle multimodal responses
                                    text_parts = []
                                    for part in msg.content:
                                        if (
                                            isinstance(part, dict)
                                            and part.get("type") == "text"
                                        ):
                                            text_parts.append(part.get("text", ""))
                                        elif isinstance(part, str):
                                            text_parts.append(part)
                                    final_content = "".join(text_parts)
                                break

                elif kind == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    # Get run_id to track tool execution pairs
                    run_id = event.get("run_id", "")
                    logger.info(
                        "[stream_tokens] Tool started: %s (run_id=%s)",
                        tool_name,
                        run_id,
                    )
                    # Notify callback if provided
                    if on_tool_event:
                        on_tool_event(
                            "tool_start",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": event.get("data", {}),
                            },
                        )

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    # Get run_id to match with tool_start
                    run_id = event.get("run_id", "")
                    logger.info(
                        "[stream_tokens] Tool completed: %s (run_id=%s)",
                        tool_name,
                        run_id,
                    )
                    # Notify callback if provided
                    if on_tool_event:
                        on_tool_event(
                            "tool_end",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": event.get("data", {}),
                            },
                        )

            # If no content was streamed but we have final content, yield it
            # This handles non-streaming models
            if not streamed_content and final_content:
                logger.info(
                    "[stream_tokens] No streaming content, yielding final content: len=%d",
                    len(final_content),
                )
                yield final_content

            logger.info(
                "[stream_tokens] Streaming completed: total_events=%d, streamed=%s",
                event_count,
                streamed_content,
            )

        except Exception:
            logger.exception("Error in stream_tokens")
            raise

    def get_final_content(self, state: dict[str, Any]) -> str:
        """Extract final content from agent state.

        Args:
            state: Final agent state from execute()

        Returns:
            Final response content
        """
        messages: list[BaseMessage] = state.get("messages", [])
        if not messages:
            return ""

        # Find the last AI message
        for msg in reversed(messages):
            if isinstance(msg, AIMessage):
                if isinstance(msg.content, str):
                    return msg.content
                elif isinstance(msg.content, list):
                    # Handle multimodal responses
                    text_parts = []
                    for part in msg.content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text_parts.append(part.get("text", ""))
                        elif isinstance(part, str):
                            text_parts.append(part)
                    return "".join(text_parts)

        return ""

    def has_tool_calls(self, state: dict[str, Any]) -> bool:
        """Check if state has pending tool calls.

        Args:
            state: Agent state

        Returns:
            True if there are pending tool calls
        """
        messages: list[BaseMessage] = state.get("messages", [])
        if not messages:
            return False

        last_message = messages[-1]
        return hasattr(last_message, "tool_calls") and bool(last_message.tool_calls)
