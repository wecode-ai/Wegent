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
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
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
        load_skill_tool: Any | None = None,
    ):
        """Initialize agent builder.

        Args:
            llm: LangChain chat model instance
            tool_registry: Registry of available tools (optional)
            max_iterations: Maximum tool loop iterations
            enable_checkpointing: Enable state checkpointing for resumability
            load_skill_tool: Optional LoadSkillTool instance for dynamic skill prompt injection
        """
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_iterations = max_iterations
        self.enable_checkpointing = enable_checkpointing
        self._agent = None
        self._load_skill_tool = load_skill_tool

        # Get all LangChain tools from registry
        self.tools: list[BaseTool] = []
        if self.tool_registry:
            self.tools = self.tool_registry.get_all()

    def _create_prompt_modifier(self) -> Callable | None:
        """Create a prompt modifier function for dynamic skill prompt injection.

        This function is called before each model invocation to inject loaded skill
        prompts into the messages.

        Returns:
            A callable that modifies the messages, or None if no load_skill_tool
        """
        if not self._load_skill_tool:
            return None

        load_skill_tool = self._load_skill_tool

        def prompt_modifier(state: dict[str, Any]) -> list[BaseMessage]:
            """Modify messages to inject loaded skill prompts into system message.

            This function is called by LangGraph's create_react_agent before each
            model invocation. It returns the modified messages list.
            """
            messages = state.get("messages", [])
            if not messages:
                logger.info("[prompt_modifier] Called with empty messages")
                return messages

            # Log all messages being sent to model (FULL content, no truncation)
            logger.info("[prompt_modifier] ========== MODEL INPUT START ==========")
            logger.info("[prompt_modifier] Total messages: %d", len(messages))
            for i, msg in enumerate(messages):
                msg_type = type(msg).__name__
                content = msg.content if hasattr(msg, "content") else str(msg)
                content_str = content if isinstance(content, str) else str(content)
                # Print FULL content without truncation
                # logger.info("[prompt_modifier] " + content_str)

            logger.info("[prompt_modifier] ========== MODEL INPUT END ==========")

            # Get combined skill prompt from the tool
            skill_prompt = load_skill_tool.get_combined_skill_prompt()

            if not skill_prompt:
                # No skills loaded, return messages unchanged
                logger.info(
                    "[prompt_modifier] No skill prompt to inject, returning original messages"
                )
                return messages

            # Find and update the system message
            new_messages = []
            system_updated = False

            for msg in messages:
                if isinstance(msg, SystemMessage) and not system_updated:
                    # Append skill prompt to existing system message
                    original_content = (
                        msg.content
                        if isinstance(msg.content, str)
                        else str(msg.content)
                    )
                    updated_content = original_content + skill_prompt
                    new_messages.append(SystemMessage(content=updated_content))
                    system_updated = True

                else:
                    new_messages.append(msg)

            # If no system message found, prepend one with skill prompt
            if not system_updated:
                new_messages.insert(0, SystemMessage(content=skill_prompt))
                logger.info(
                    "[prompt_modifier] Created new system message with skill prompts, len=%d, content:\n%s",
                    len(skill_prompt),
                    skill_prompt,
                )

            return new_messages

        return prompt_modifier

    def _build_agent(self):
        """Build the LangGraph ReAct agent lazily."""
        if self._agent is not None:
            return self._agent

        # Use LangGraph's prebuilt create_react_agent
        checkpointer = MemorySaver() if self.enable_checkpointing else None

        # Create prompt modifier for dynamic skill prompt injection
        prompt_modifier = self._create_prompt_modifier()

        # Build agent with optional prompt modifier for dynamic system prompt updates
        self._agent = create_react_agent(
            model=self.llm,
            tools=self.tools,
            checkpointer=checkpointer,
            prompt=prompt_modifier,
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
                    # Get tool output for logging
                    tool_data = event.get("data", {})
                    tool_output = tool_data.get("output", "")
                    # Log tool output, especially for load_skill
                    if tool_name == "load_skill":
                        logger.info(
                            "[stream_tokens] load_skill completed (run_id=%s), output length=%d, output preview:\n---\n%s\n---",
                            run_id,
                            len(str(tool_output)),
                            (
                                str(tool_output)[:500] + "..."
                                if len(str(tool_output)) > 500
                                else str(tool_output)
                            ),
                        )
                    else:
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
                                "data": tool_data,
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

    async def stream_events_with_state(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
    ) -> tuple[dict[str, Any], list[dict[str, Any]]]:
        """Stream events and return final state with all events.

        This method is designed for scenarios like correction evaluation where:
        1. We need to capture tool events for progress updates
        2. We need the final state to extract structured results
        3. We want to avoid executing the agent twice

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional async callback for tool events (kind, event_data)

        Returns:
            Tuple of (final_state, all_events)
        """
        agent = self._build_agent()
        lc_messages = convert_to_messages(messages)

        exec_config = {"configurable": config} if config else None

        all_events: list[dict[str, Any]] = []
        final_state: dict[str, Any] = {}

        try:
            async for event in agent.astream_events(
                {"messages": lc_messages},
                config={
                    **(exec_config or {}),
                    "recursion_limit": self.max_iterations * 2 + 1,
                },
                version="v2",
            ):
                # Check cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info("Streaming cancelled by user")
                    break

                all_events.append(event)
                kind = event.get("event", "")

                # Handle tool events
                if kind == "on_tool_start":
                    tool_name = event.get("name", "unknown")
                    run_id = event.get("run_id", "")
                    logger.info(
                        "[stream_events_with_state] Tool started: %s (run_id=%s)",
                        tool_name,
                        run_id,
                    )
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
                    run_id = event.get("run_id", "")
                    logger.info(
                        "[stream_events_with_state] Tool completed: %s (run_id=%s)",
                        tool_name,
                        run_id,
                    )
                    if on_tool_event:
                        on_tool_event(
                            "tool_end",
                            {
                                "name": tool_name,
                                "run_id": run_id,
                                "data": event.get("data", {}),
                            },
                        )

                # Capture final state from LangGraph chain end
                elif kind == "on_chain_end" and event.get("name") == "LangGraph":
                    data = event.get("data", {})
                    output = data.get("output", {})
                    if output:
                        final_state = output

            logger.info(
                "[stream_events_with_state] Completed: total_events=%d",
                len(all_events),
            )

            return final_state, all_events

        except Exception:
            logger.exception("Error in stream_events_with_state")
            raise
