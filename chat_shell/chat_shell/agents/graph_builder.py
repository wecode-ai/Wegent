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
import time
from collections.abc import AsyncGenerator
from typing import Any, Callable

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.messages.utils import convert_to_messages
from langchain_core.tools.base import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.prebuilt import create_react_agent
from opentelemetry import trace as otel_trace
from shared.telemetry.decorators import add_span_event, trace_sync

from ..tools.base import ToolRegistry

logger = logging.getLogger(__name__)

# Message to send to model when tool call limit is reached
TOOL_LIMIT_REACHED_MESSAGE = """[SYSTEM NOTICE] Tool call limit reached. You have made too many tool calls in this conversation.

Please provide your final response to the user based on the information you have gathered so far. Do NOT attempt to call any more tools - simply summarize your findings and provide a helpful response."""


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

        # Automatically detect PromptModifierTool instances from registered tools
        self._prompt_modifier_tools = self._find_prompt_modifier_tools()

    def _find_prompt_modifier_tools(self) -> list[Any]:
        """Find all tools that implement the PromptModifierTool protocol.

        Returns:
            List of tools that have get_prompt_modification method
        """
        from ..tools.base import PromptModifierTool

        modifier_tools = []
        for tool in self.tools:
            if isinstance(tool, PromptModifierTool):
                modifier_tools.append(tool)
                logger.debug(
                    "[LangGraphAgentBuilder] Found PromptModifierTool: %s",
                    tool.name,
                )
        return modifier_tools

    def _create_prompt_modifier(self) -> Callable | None:
        """Create a prompt modifier function for dynamic prompt injection.

        This function is called before each model invocation to inject
        prompt modifications from all PromptModifierTool instances.

        Returns:
            A callable that modifies the messages, or None if no modifier tools
        """
        if not self._prompt_modifier_tools:
            return None

        modifier_tools = self._prompt_modifier_tools

        def prompt_modifier(state: dict[str, Any]) -> list[BaseMessage]:
            """Modify messages to inject prompt modifications into system message.

            This function is called by LangGraph's create_react_agent before each
            model invocation. It collects prompt modifications from all
            PromptModifierTool instances and appends them to the system message.
            """
            messages = state.get("messages", [])
            if not messages:
                return messages

            # Collect prompt modifications from all modifier tools
            combined_modification = ""
            for tool in modifier_tools:
                modification = tool.get_prompt_modification()
                if modification:
                    combined_modification += modification

            if not combined_modification:
                # No modifications, return messages unchanged
                return messages

            # Find and update the system message
            new_messages = []
            system_updated = False

            for msg in messages:
                if isinstance(msg, SystemMessage) and not system_updated:
                    # Append modifications to existing system message
                    original_content = (
                        msg.content
                        if isinstance(msg.content, str)
                        else str(msg.content)
                    )
                    updated_content = original_content + combined_modification
                    new_messages.append(SystemMessage(content=updated_content))
                    system_updated = True

                else:
                    new_messages.append(msg)

            # If no system message found, prepend one with modifications
            if not system_updated:
                new_messages.insert(0, SystemMessage(content=combined_modification))
                logger.debug(
                    "[prompt_modifier] Created new system message with modifications, len=%d",
                    len(combined_modification),
                )

            return new_messages

        return prompt_modifier

    @trace_sync(
        span_name="agent_builder.build_agent",
        tracer_name="chat_shell.agents",
        extract_attributes=lambda self, *args, **kwargs: {
            "agent.tools_count": len(self.tools),
            "agent.max_iterations": self.max_iterations,
            "agent.enable_checkpointing": self.enable_checkpointing,
        },
    )
    def _build_agent(self):
        """Build the LangGraph ReAct agent lazily."""
        if self._agent is not None:
            add_span_event("agent_already_built")
            return self._agent

        add_span_event("building_new_agent")

        # Use LangGraph's prebuilt create_react_agent
        checkpointer = MemorySaver() if self.enable_checkpointing else None
        add_span_event(
            "checkpointer_created", {"has_checkpointer": checkpointer is not None}
        )

        # Create prompt modifier for dynamic skill prompt injection
        prompt_modifier = self._create_prompt_modifier()
        add_span_event(
            "prompt_modifier_created",
            {"has_modifier": prompt_modifier is not None},
        )

        # Build agent with optional prompt modifier for dynamic system prompt updates
        self._agent = create_react_agent(
            model=self.llm,
            tools=self.tools,
            checkpointer=checkpointer,
            prompt=prompt_modifier,
        )
        add_span_event("react_agent_created")

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
        add_span_event("stream_tokens_started", {"message_count": len(messages)})

        add_span_event("building_agent_started")
        agent = self._build_agent()
        add_span_event("building_agent_completed")

        add_span_event("convert_to_messages_started", {"message_count": len(messages)})
        lc_messages = convert_to_messages(messages)
        add_span_event(
            "convert_to_messages_completed", {"lc_message_count": len(lc_messages)}
        )

        exec_config = {"configurable": config} if config else None

        event_count = 0
        streamed_content = False  # Track if we've streamed any content
        final_content = ""  # Store final content for non-streaming fallback

        # TTFT tracking variables
        first_token_received = False
        llm_request_start_time: float | None = None
        ttft_ms: float | None = None  # Time to first token in milliseconds

        # Get tracer for LLM request span
        tracer = otel_trace.get_tracer("chat_shell.agents")

        add_span_event("astream_events_starting")
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

                # Track LLM request start
                if kind == "on_chat_model_start":
                    llm_request_start_time = time.perf_counter()
                    first_token_received = False
                    add_span_event(
                        "llm_request_started",
                        {"model_name": event.get("name", "unknown")},
                    )

                # Log streaming completion event (much less verbose)
                if kind == "on_chat_model_stream":
                    # Calculate TTFT on first token
                    if not first_token_received and llm_request_start_time is not None:
                        ttft_ms = (time.perf_counter() - llm_request_start_time) * 1000
                        first_token_received = True
                        add_span_event(
                            "first_token_received",
                            {"ttft_ms": round(ttft_ms, 2)},
                        )
                        logger.info(
                            "[stream_tokens] TTFT: %.2fms",
                            ttft_ms,
                        )

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

                    # Check for reasoning_content (DeepSeek R1 and similar reasoning models)
                    # reasoning_content may be in additional_kwargs or as a direct attribute
                    if chunk:
                        reasoning_content = None
                        # Try additional_kwargs first (LangChain's standard location for extra data)
                        if hasattr(chunk, "additional_kwargs"):
                            reasoning_content = chunk.additional_kwargs.get(
                                "reasoning_content"
                            )
                        # Also check direct attribute (some providers may use this)
                        if not reasoning_content and hasattr(
                            chunk, "reasoning_content"
                        ):
                            reasoning_content = chunk.reasoning_content

                        if reasoning_content:
                            logger.debug(
                                "[stream_tokens] Yielding reasoning_content: %s...",
                                (
                                    reasoning_content[:50]
                                    if len(reasoning_content) > 50
                                    else reasoning_content
                                ),
                            )
                            # Use special prefix to mark reasoning content
                            # Format: __REASONING__<content>__END_REASONING__
                            yield f"__REASONING__{reasoning_content}__END_REASONING__"

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

                elif kind == "on_chat_model_end":
                    # Track LLM request completion
                    if llm_request_start_time is not None:
                        total_llm_time_ms = (
                            time.perf_counter() - llm_request_start_time
                        ) * 1000
                        add_span_event(
                            "llm_request_completed",
                            {
                                "total_time_ms": round(total_llm_time_ms, 2),
                                "ttft_ms": round(ttft_ms, 2) if ttft_ms else None,
                            },
                        )
                        logger.info(
                            "[stream_tokens] LLM request completed: total=%.2fms, ttft=%.2fms",
                            total_llm_time_ms,
                            ttft_ms or 0,
                        )
                        # Reset for potential next LLM call (e.g., after tool execution)
                        llm_request_start_time = None

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
                    logger.info("[TOOL] %s started", tool_name)
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
                        # Yield empty string to trigger _emit_pending_events() in chat_service
                        # This ensures tool events are sent immediately instead of being buffered
                        yield ""

                elif kind == "on_tool_end":
                    tool_name = event.get("name", "unknown")
                    # Get run_id to match with tool_start
                    run_id = event.get("run_id", "")
                    # Get tool output for logging
                    tool_data = event.get("data", {})
                    logger.info("[TOOL] %s completed", tool_name)
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
                        # Yield empty string to trigger _emit_pending_events() in chat_service
                        # This ensures tool events are sent immediately instead of being buffered
                        yield ""

            # If no content was streamed but we have final content, yield it
            # This handles non-streaming models
            if not streamed_content and final_content:
                logger.debug(
                    "[stream_tokens] No streaming content, yielding final content: len=%d",
                    len(final_content),
                )
                yield final_content

            logger.debug(
                "[stream_tokens] Streaming completed: total_events=%d, streamed=%s",
                event_count,
                streamed_content,
            )

        except GraphRecursionError as e:
            # Tool call limit reached - ask model to provide final response
            logger.warning(
                "[stream_tokens] GraphRecursionError: Tool call limit reached (max_iterations=%d). "
                "Asking model to provide final response.",
                self.max_iterations,
            )

            # Build messages with the limit reached notice
            # Add a human message to prompt the model to provide final response
            limit_messages = list(lc_messages) + [
                HumanMessage(content=TOOL_LIMIT_REACHED_MESSAGE)
            ]

            # Call the LLM directly (without tools) to get final response
            try:
                async for chunk in self.llm.astream(limit_messages):
                    if hasattr(chunk, "content"):
                        content = chunk.content
                        if isinstance(content, str) and content:
                            yield content
                        elif isinstance(content, list):
                            for part in content:
                                if isinstance(part, str) and part:
                                    yield part
                                elif isinstance(part, dict):
                                    text = part.get("text", "")
                                    if text:
                                        yield text

                logger.info(
                    "[stream_tokens] Final response generated after tool limit reached"
                )
            except Exception as recovery_error:
                logger.exception(
                    "Error generating final response after tool limit reached"
                )
                raise

        except Exception as e:
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
                    logger.info("[TOOL] %s started", tool_name)
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
                    logger.info("[TOOL] %s completed", tool_name)
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

            logger.debug(
                "[stream_events_with_state] Completed: total_events=%d",
                len(all_events),
            )

            return final_state, all_events

        except GraphRecursionError:
            # Tool call limit reached - ask model to provide final response
            logger.warning(
                "[stream_events_with_state] GraphRecursionError: Tool call limit reached (max_iterations=%d). "
                "Asking model to provide final response.",
                self.max_iterations,
            )

            # Build messages with the limit reached notice
            limit_messages = list(lc_messages) + [
                HumanMessage(content=TOOL_LIMIT_REACHED_MESSAGE)
            ]

            # Call the LLM directly (without tools) to get final response
            try:
                response = await self.llm.ainvoke(limit_messages)
                final_content = ""
                if hasattr(response, "content"):
                    if isinstance(response.content, str):
                        final_content = response.content
                    elif isinstance(response.content, list):
                        text_parts = []
                        for part in response.content:
                            if isinstance(part, str):
                                text_parts.append(part)
                            elif isinstance(part, dict) and part.get("type") == "text":
                                text_parts.append(part.get("text", ""))
                        final_content = "".join(text_parts)

                # Create a final state with the response
                final_state = {
                    "messages": list(lc_messages) + [AIMessage(content=final_content)]
                }

                logger.debug(
                    "[stream_events_with_state] Final response generated after tool limit reached"
                )
                return final_state, all_events

            except Exception:
                logger.exception(
                    "Error generating final response after tool limit reached"
                )
                raise

        except Exception:
            logger.exception("Error in stream_events_with_state")
            raise
