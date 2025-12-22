# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph graph builder for agent workflows.

This module provides the core LangGraph agent implementation with:
- Model node for LLM invocation
- Tools node for tool execution
- Conditional edges for tool loop control
- Streaming support with cancellation
- State checkpointing for resumability
"""

import asyncio
import json
import logging
from collections.abc import AsyncGenerator
from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, AIMessageChunk, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools.base import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from ..tools.base import ToolRegistry
from .state import AgentState

logger = logging.getLogger(__name__)


class LangGraphAgentBuilder:
    """Builder for LangGraph-based agent workflows with tool calling and streaming."""

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
        self._graph = None

        # Get all LangChain tools from registry
        self.langchain_tools: list[BaseTool] = []
        if self.tool_registry:
            self.langchain_tools = self.tool_registry.get_all()

        # Bind tools to LLM if available
        if self.langchain_tools:
            self.llm_with_tools = self.llm.bind_tools(self.langchain_tools)
        else:
            self.llm_with_tools = self.llm

    async def invoke_model(self, state: AgentState) -> AgentState:
        """Node: Call LLM with current messages and tools.

        Args:
            state: Current agent state

        Returns:
            Updated state with LLM response
        """
        # Check cancellation
        cancel_event = state.get("cancel_event")
        if cancel_event and cancel_event.is_set():
            return {
                **state,
                "error": "Cancelled by user",
            }

        messages = state["messages"]

        try:
            # Call LLM with tools
            response = await self.llm_with_tools.ainvoke(messages)

            # Update accumulated content
            content = response.content if isinstance(response.content, str) else ""
            accumulated = state.get("accumulated_content", "") + content

            return {
                **state,
                "messages": [response],
                "accumulated_content": accumulated,
            }
        except Exception as e:
            logger.exception("Error invoking model")
            return {
                **state,
                "error": str(e),
            }

    async def invoke_tools(self, state: AgentState) -> AgentState:
        """Node: Execute tool calls from LLM response.

        Args:
            state: Current agent state with tool calls

        Returns:
            Updated state with tool results
        """
        # Check cancellation
        cancel_event = state.get("cancel_event")
        if cancel_event and cancel_event.is_set():
            return {
                **state,
                "error": "Cancelled by user",
            }

        messages = state["messages"]
        last_message = messages[-1]

        tool_results = []
        tool_messages = []

        # Execute each tool call
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            for tool_call in last_message.tool_calls:
                tool_name = tool_call["name"]
                tool_args = tool_call["args"]
                tool_call_id = tool_call["id"]

                try:
                    # Execute tool via registry
                    if self.tool_registry:
                        result = await self.tool_registry.invoke_tool(
                            tool_name, **tool_args
                        )
                    else:
                        result = f"Tool {tool_name} not available"

                    # Store result
                    tool_results.append({
                        "tool_call_id": tool_call_id,
                        "tool_name": tool_name,
                        "result": (
                            result.model_dump()
                            if hasattr(result, "model_dump")
                            else {"output": result}
                        ),
                    })

                    # Convert result to string
                    if isinstance(result, str):
                        content = result
                    else:
                        try:
                            content = json.dumps(result, ensure_ascii=False)
                        except (TypeError, ValueError):
                            content = str(result)

                    tool_message = ToolMessage(
                        content=content,
                        tool_call_id=tool_call_id,
                        name=tool_name,
                    )
                    tool_messages.append(tool_message)

                except Exception as e:
                    logger.exception("Error executing tool %s", tool_name)
                    error_message = ToolMessage(
                        content=f"Error executing tool: {str(e)}",
                        tool_call_id=tool_call_id,
                        name=tool_name,
                    )
                    tool_messages.append(error_message)

        # Update iteration count
        new_iteration = state.get("iteration", 0) + 1

        return {
            **state,
            "messages": tool_messages,
            "tool_results": state.get("tool_results", []) + tool_results,
            "iteration": new_iteration,
        }

    def should_continue(self, state: AgentState) -> str:
        """Conditional edge: Determine if agent should continue or end.

        Args:
            state: Current agent state

        Returns:
            "continue" to execute tools, "end" to finish
        """
        # Check for errors
        if state.get("error"):
            return "end"

        # Check cancellation
        cancel_event = state.get("cancel_event")
        if cancel_event and cancel_event.is_set():
            return "end"

        messages = state["messages"]
        if not messages:
            return "end"

        last_message = messages[-1]

        # Check if max iterations reached
        if state.get("iteration", 0) >= state.get("max_iterations", self.max_iterations):
            logger.warning("Max iterations reached: %d", state.get("iteration", 0))
            return "end"

        # Check if LLM made tool calls
        if hasattr(last_message, "tool_calls") and last_message.tool_calls:
            return "continue"

        return "end"

    def build_graph(self) -> StateGraph:
        """Build LangGraph workflow graph.

        Returns:
            Compiled StateGraph ready for execution
        """
        if self._graph is not None:
            return self._graph

        # Create graph
        workflow = StateGraph(AgentState)

        # Add nodes
        workflow.add_node("model", self.invoke_model)
        workflow.add_node("tools", self.invoke_tools)

        # Set entry point
        workflow.set_entry_point("model")

        # Add conditional edges
        workflow.add_conditional_edges(
            "model",
            self.should_continue,
            {
                "continue": "tools",
                "end": END,
            },
        )

        # Add edge from tools back to model
        workflow.add_edge("tools", "model")

        # Compile graph
        if self.enable_checkpointing:
            memory = MemorySaver()
            self._graph = workflow.compile(checkpointer=memory)
        else:
            self._graph = workflow.compile()

        return self._graph

    def _convert_messages(self, messages: list[dict[str, Any]]) -> list:
        """Convert OpenAI-style messages to LangChain format.

        Args:
            messages: List of message dicts

        Returns:
            List of LangChain messages
        """
        lc_messages = []
        for msg in messages:
            role = msg.get("role", "")
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                # Handle vision messages (content can be a list)
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                tool_calls = msg.get("tool_calls")
                if tool_calls:
                    lc_messages.append(AIMessage(content=content, tool_calls=tool_calls))
                else:
                    lc_messages.append(AIMessage(content=content))
            elif role == "tool":
                lc_messages.append(ToolMessage(
                    content=content,
                    tool_call_id=msg.get("tool_call_id", ""),
                    name=msg.get("name", ""),
                ))

        return lc_messages

    def _create_initial_state(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AgentState:
        """Create initial agent state.

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event

        Returns:
            Initial AgentState
        """
        lc_messages = self._convert_messages(messages)

        return AgentState(
            messages=lc_messages,
            tool_results=[],
            iteration=0,
            max_iterations=self.max_iterations,
            final_answer=None,
            error=None,
            metadata=config or {},
            cancel_event=cancel_event,
            accumulated_content="",
        )

    async def execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AgentState:
        """Execute agent workflow (non-streaming).

        Args:
            messages: Initial conversation messages
            config: Optional configuration (thread_id for checkpointing)
            cancel_event: Optional cancellation event

        Returns:
            Final agent state with response
        """
        initial_state = self._create_initial_state(messages, config, cancel_event)
        graph = self.build_graph()

        exec_config = {"configurable": config} if config else None
        final_state = await graph.ainvoke(initial_state, config=exec_config)

        return final_state

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
        initial_state = self._create_initial_state(messages, config, cancel_event)
        graph = self.build_graph()

        exec_config = {"configurable": config} if config else None
        async for event in graph.astream(initial_state, config=exec_config):
            yield event

    async def stream_tokens(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
        cancel_event: asyncio.Event | None = None,
    ) -> AsyncGenerator[str, None]:
        """Stream tokens from agent execution.

        This method provides token-level streaming by using
        LangChain's astream_events API.

        Args:
            messages: Initial conversation messages
            config: Optional configuration
            cancel_event: Optional cancellation event

        Yields:
            Content tokens as they are generated
        """
        initial_state = self._create_initial_state(messages, config, cancel_event)
        graph = self.build_graph()

        exec_config = {"configurable": config} if config else None

        try:
            async for event in graph.astream_events(initial_state, config=exec_config, version="v2"):
                # Check cancellation
                if cancel_event and cancel_event.is_set():
                    logger.info("Streaming cancelled by user")
                    return

                # Handle different event types
                kind = event.get("event", "")

                if kind == "on_chat_model_stream":
                    # Token-level streaming from LLM
                    data = event.get("data", {})
                    chunk = data.get("chunk")
                    if chunk and hasattr(chunk, "content") and chunk.content:
                        yield chunk.content

                elif kind == "on_tool_start":
                    # Tool execution started
                    tool_name = event.get("name", "unknown")
                    logger.debug("Tool started: %s", tool_name)

                elif kind == "on_tool_end":
                    # Tool execution completed
                    tool_name = event.get("name", "unknown")
                    logger.debug("Tool completed: %s", tool_name)

        except Exception as e:
            logger.exception("Error in stream_tokens")
            raise

    def get_final_content(self, state: AgentState) -> str:
        """Extract final content from agent state.

        Args:
            state: Final agent state

        Returns:
            Final response content
        """
        messages = state.get("messages", [])
        if not messages:
            return state.get("accumulated_content", "")

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

        return state.get("accumulated_content", "")

    def has_tool_calls(self, state: AgentState) -> bool:
        """Check if state has pending tool calls.

        Args:
            state: Agent state

        Returns:
            True if there are pending tool calls
        """
        messages = state.get("messages", [])
        if not messages:
            return False

        last_message = messages[-1]
        return hasattr(last_message, "tool_calls") and bool(last_message.tool_calls)
