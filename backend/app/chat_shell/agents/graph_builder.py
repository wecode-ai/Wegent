# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph graph builder for agent workflows.

This module provides a simplified LangGraph agent implementation using:
- LangGraph's prebuilt create_react_agent for ReAct workflow
- LangChain's convert_to_messages for message format conversion
- Streaming support with cancellation
- State checkpointing for resumability
- Dynamic tool filtering for gemini_search (removed after first use)
"""

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any, Callable

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_core.messages.utils import convert_to_messages
from langchain_core.runnables import Runnable
from langchain_core.tools.base import BaseTool
from langchain_google_genai import ChatGoogleGenerativeAI
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.prebuilt import create_react_agent

from ..tools.base import ToolRegistry
from ..tools.builtin.web_search import WebSearchTool
from ..tools.gemini_search import GeminiSearchTool, create_gemini_search_tool

logger = logging.getLogger(__name__)

# Message to send to model when tool call limit is reached
TOOL_LIMIT_REACHED_MESSAGE = """[SYSTEM NOTICE] Tool call limit reached. You have made too many tool calls in this conversation.

Please provide your final response to the user based on the information you have gathered so far. Do NOT attempt to call any more tools - simply summarize your findings and provide a helpful response."""


# SystemMessage content to inject after gemini_search has been called
# This strongly instructs the model to stop calling tools and provide a final answer
GEMINI_SEARCH_COMPLETE_INSTRUCTION = """[SYSTEM INSTRUCTION - RESEARCH COMPLETE]

You have ALREADY called the heavy research tool `gemini_search` in THIS conversation turn.
The research results are now available in the conversation above.

⛔ CRITICAL: You MUST NOT call ANY tools again in this turn.

✅ YOUR TASK NOW:
1. Carefully read the research results already present in the conversation
2. Synthesize the information into a comprehensive, well-structured answer
3. Write your final response in Chinese (中文)
4. Include all relevant findings, data points, and context from the research

DO NOT request more research. DO NOT call any tools again. Just provide your final answer based on the research results above."""


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
        # Track tools with return_direct=True for direct output handling
        self._return_direct_tools: set[str] = set()
        # Store GeminiSearchTool reference for streaming support
        self._gemini_search_tool: GeminiSearchTool | None = None

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

    def _create_gemini_prompt_modifier(
        self, gemini_search_tool: GeminiSearchTool
    ) -> Callable:
        """Create a prompt modifier that wraps skill injection and adds gemini_search constraints.

        This function creates a prompt modifier that:
        1. First applies skill prompt injection (if load_skill_tool exists)
        2. Then injects a constraint SystemMessage after gemini_search has been called

        Args:
            gemini_search_tool: GeminiSearchTool instance for checking call state

        Returns:
            A callable that modifies the messages
        """
        base_modifier = self._create_prompt_modifier()
        captured_gemini_tool = gemini_search_tool

        def gemini_prompt_modifier(state: dict[str, Any]) -> list[BaseMessage]:
            """Modify messages with skill prompts and gemini_search constraints."""
            # First apply base modifier (skill injection) if it exists
            if base_modifier:
                messages = base_modifier(state)
            else:
                messages = list(state.get("messages", []))

            if not messages:
                return messages

            # Then handle gemini_search constraint injection
            # If gemini_search has been called, append a strong constraint SystemMessage
            # This tells the model to stop calling tools and provide a final answer
            if captured_gemini_tool.has_been_called():
                logger.info(
                    "[gemini_prompt_modifier] gemini_search has been called, injecting "
                    "constraint SystemMessage to stop further tool calls"
                )
                messages.append(
                    SystemMessage(content=GEMINI_SEARCH_COMPLETE_INSTRUCTION)
                )

            return messages

        return gemini_prompt_modifier

    def _build_agent(self):
        """Build the LangGraph ReAct agent lazily."""
        if self._agent is not None:
            return self._agent

        # Use LangGraph's prebuilt create_react_agent
        checkpointer = MemorySaver() if self.enable_checkpointing else None

        # Create prompt modifier for dynamic skill prompt injection
        prompt_modifier = self._create_prompt_modifier()

        # Track GeminiSearchTool instance for dynamic filtering
        gemini_search_tool: GeminiSearchTool | None = None

        # Add llm built-in search tool if supported
        model_with_tools: BaseChatModel | Callable = self.llm
        if isinstance(self.llm, ChatGoogleGenerativeAI):
            # For Gemini models, create a GeminiSearchTool instead of directly binding
            # google_search. This is because Gemini server forbids using google_search
            # and other tools simultaneously.
            # Note: GeminiSearchTool uses its own internal system prompt optimized for
            # comprehensive web search, not the main agent's system prompt.
            gemini_search_tool = create_gemini_search_tool(self.llm)
            # Store reference for streaming support
            self._gemini_search_tool = gemini_search_tool
            # Use gemini-specific prompt modifier that wraps skill injection
            prompt_modifier = self._create_gemini_prompt_modifier(gemini_search_tool)
            self.tools.append(gemini_search_tool)

            logger.info(
                "[LangGraphAgentBuilder] Created GeminiSearchTool for Google model, "
                "tools count: %d, return_direct: %s",
                len(self.tools),
                gemini_search_tool.return_direct,
            )

            # Create a dynamic model callable that manages search tool visibility
            # This uses LangGraph's native dynamic model support to control which
            # search tools are available at different stages of the conversation.
            #
            # Search tool management strategy for Gemini models:
            # - First call (gemini_search not yet called):
            #   - Show gemini_search (Gemini's native search)
            #   - Hide other search tools (e.g., web_search) to avoid confusion
            # - After gemini_search is called:
            #   - Hide gemini_search (already used, one-time per turn)
            #   - Show other search tools (if any) as fallback options
            #
            # Why dynamic model instead of tool-level filtering:
            # - Tool-level filtering (_called_this_turn) only returns an error message
            # - The model still sees the tool and may try to call it repeatedly
            # - Dynamic model filtering completely removes the tool from the model's view
            # - This prevents wasted tokens and model confusion
            base_llm = self.llm
            all_tools = list(self.tools)

            # Identify search tools: GeminiSearchTool and WebSearchTool
            other_search_tools = [t for t in all_tools if isinstance(t, WebSearchTool)]

            # Tools for first call: all tools except other search tools (only gemini_search for search)
            tools_with_gemini_only = [
                t for t in all_tools if not isinstance(t, WebSearchTool)
            ]

            # Tools after gemini_search is called: all tools except gemini_search
            # (includes other search tools if any)
            tools_without_gemini = [
                t for t in all_tools if not isinstance(t, GeminiSearchTool)
            ]

            captured_gemini_tool = gemini_search_tool
            has_other_search_tools = len(other_search_tools) > 0

            def gemini_model_callable(state: dict[str, Any], runtime: Any) -> Runnable:
                """Dynamic model that manages search tool visibility for Gemini.

                This callable is invoked before each LLM call. It manages search tools:
                - If gemini_search not called: show only gemini_search (hide other search tools)
                - If gemini_search called: hide gemini_search, show other search tools (if any)

                This ensures:
                1. Gemini uses its native search first (better integration)
                2. Other search tools are available as fallback after gemini_search is used
                3. No duplicate search capabilities confuse the model
                """
                if captured_gemini_tool.has_been_called():
                    # GeminiSearchTool has been called, filter it out and restore other search tools
                    logger.info(
                        "[LangGraphAgentBuilder] gemini_search already called, "
                        "returning model without gemini_search. "
                        "Other search tools available: %s, Remaining tools: %d",
                        has_other_search_tools,
                        len(tools_without_gemini),
                    )
                    return base_llm.bind_tools(tools_without_gemini)
                else:
                    # First call, include gemini_search but hide other search tools
                    logger.debug(
                        "[LangGraphAgentBuilder] gemini_search not yet called, "
                        "returning model with gemini_search only (hiding %d other search tools). "
                        "Total tools: %d",
                        len(other_search_tools),
                        len(tools_with_gemini_only),
                    )
                    return base_llm.bind_tools(tools_with_gemini_only)

            model_with_tools = gemini_model_callable

        self._agent = create_react_agent(
            model=model_with_tools,
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
                    tool_input_data = event.get("data", {})
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
                                "data": tool_input_data,
                            },
                        )

                    # Special handling for gemini_search: intercept and stream directly
                    # This provides real-time streaming output instead of waiting for
                    # the tool to complete and returning all at once.
                    # gemini_search acts as a sub-agent that receives the full conversation
                    # context and performs web search using Gemini with google_search.
                    if tool_name == "gemini_search" and self._gemini_search_tool:
                        logger.info(
                            "[stream_tokens] Intercepting gemini_search for streaming, "
                            "forwarding full conversation context (%d messages) (run_id=%s)",
                            len(lc_messages),
                            run_id,
                        )
                        # Stream the search results directly with full conversation context
                        # The sub-agent will receive all messages and perform search
                        async for (
                            chunk
                        ) in self._gemini_search_tool.astream_with_context(lc_messages):
                            if chunk:
                                streamed_content = True
                                yield chunk

                        # Notify tool_end callback
                        if on_tool_event:
                            on_tool_event(
                                "tool_end",
                                {
                                    "name": tool_name,
                                    "run_id": run_id,
                                    "data": {"output": "[Streamed directly]"},
                                },
                            )

                        logger.info(
                            "[stream_tokens] gemini_search streaming completed, "
                            "returning early (return_direct=True)"
                        )
                        # Return early since gemini_search has return_direct=True
                        return

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
                    elif tool_name == "gemini_search":
                        # If we reach here, it means the streaming interception didn't work
                        # (e.g., _gemini_search_tool was None). Fall back to non-streaming output.
                        logger.info(
                            "[stream_tokens] gemini_search completed (fallback non-streaming), "
                            "yielding output directly as final response (run_id=%s), output length=%d",
                            run_id,
                            len(str(tool_output)),
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
                        # Yield the tool output directly as the final response
                        if tool_output:
                            streamed_content = True
                            yield str(tool_output)
                        # Return early to stop the agent loop since return_direct=True
                        # means we should use the tool output as the final response
                        return
                    else:
                        logger.info(
                            "[stream_tokens] Tool completed: %s (run_id=%s)",
                            tool_name,
                            run_id,
                        )
                    # Notify callback if provided (for non-gemini_search tools)
                    if tool_name != "gemini_search" and on_tool_event:
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

        except GraphRecursionError as e:
            # Tool call limit reached - ask model to provide final response
            from shared.telemetry.context import (
                TelemetryEventNames,
                add_span_event,
                record_stream_error,
                set_span_error,
            )

            logger.warning(
                "[stream_tokens] GraphRecursionError: Tool call limit reached (max_iterations=%d). "
                "Asking model to provide final response.",
                self.max_iterations,
            )

            # Record recursion limit error in OpenTelemetry trace using unified function
            add_span_event(
                TelemetryEventNames.RECURSION_LIMIT_ERROR,
                {
                    "max_iterations": self.max_iterations,
                    "recursion_limit": self.max_iterations * 2 + 1,
                    "event_count": event_count,
                    "streamed_content": streamed_content,
                    "error.message": str(e),
                },
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
                # Record recovery failure in trace
                set_span_error(
                    recovery_error,
                    description="Failed to generate final response after recursion limit",
                )
                add_span_event(
                    TelemetryEventNames.AGENT_ERROR,
                    {
                        "error.type": type(recovery_error).__name__,
                        "error.message": str(recovery_error),
                        "context": "recursion_limit_recovery",
                    },
                )
                raise

        except Exception as e:
            from shared.telemetry.context import (
                TelemetryEventNames,
                record_stream_error,
            )

            logger.exception("Error in stream_tokens")

            # Record error in OpenTelemetry trace using unified function
            record_stream_error(
                error=e,
                event_name=TelemetryEventNames.AGENT_ERROR,
                extra_attributes={
                    "event_count": event_count,
                    "streamed_content": streamed_content,
                },
            )
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

                logger.info(
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
