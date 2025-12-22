"""LangGraph Chat Service - main service entry point with real LangGraph agent."""

import json
import uuid
from collections.abc import AsyncIterator
from typing import Any

from langchain_core.messages import AIMessage

from .agents.graph_builder import LangGraphAgentBuilder
from .config import config
from .providers.langchain_models import LangChainModelFactory
from .tools import SkillsRegistry, ToolRegistry, WebSearchTool
from .tools.mcp import MCPSessionManager


def extract_usage_from_response(response: Any) -> dict[str, int]:
    """Extract token usage from LangChain response.

    Args:
        response: LangChain response object or message

    Returns:
        Dict with prompt_tokens, completion_tokens, total_tokens
    """
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    # Check for usage_metadata (LangChain >= 0.1.0)
    if hasattr(response, "usage_metadata") and response.usage_metadata:
        metadata = response.usage_metadata
        usage["prompt_tokens"] = getattr(metadata, "input_tokens", 0)
        usage["completion_tokens"] = getattr(metadata, "output_tokens", 0)
        usage["total_tokens"] = getattr(metadata, "total_tokens", 0)
        return usage

    # Check for response_metadata (older LangChain or provider-specific)
    if hasattr(response, "response_metadata") and response.response_metadata:
        metadata = response.response_metadata
        # OpenAI format
        if "token_usage" in metadata:
            token_usage = metadata["token_usage"]
            usage["prompt_tokens"] = token_usage.get("prompt_tokens", 0)
            usage["completion_tokens"] = token_usage.get("completion_tokens", 0)
            usage["total_tokens"] = token_usage.get("total_tokens", 0)
            return usage
        # Anthropic format
        if "usage" in metadata:
            anthropic_usage = metadata["usage"]
            usage["prompt_tokens"] = anthropic_usage.get("input_tokens", 0)
            usage["completion_tokens"] = anthropic_usage.get("output_tokens", 0)
            usage["total_tokens"] = usage["prompt_tokens"] + usage["completion_tokens"]
            return usage

    # Fallback: return zeros
    return usage


class StreamChunk:
    """Stream chunk response."""

    def __init__(
        self,
        delta: dict[str, Any],
        finish_reason: str | None = None,
        usage: dict[str, int] | None = None,
    ):
        self.delta = delta
        self.finish_reason = finish_reason
        self.usage = usage


class CompletionResponse:
    """Chat completion response."""

    def __init__(
        self,
        content: str,
        tool_calls: list[dict[str, Any]] | None = None,
        finish_reason: str = "stop",
        usage: dict[str, int] | None = None,
    ):
        self.content = content
        self.tool_calls = tool_calls
        self.finish_reason = finish_reason
        self.usage = usage or {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    Uses LangChain/LangGraph framework for agent orchestration with:
    - Real LangGraph state management
    - Tool binding via LangChain
    - OpenAI/Google/Anthropic SDK integration through LangChain
    - Multi-step reasoning with tool loops
    - MCP integration
    - Skills for large file handling
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_mcp: bool = False,
        enable_skills: bool = True,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize LangGraph Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_mcp: Enable MCP tool integration
            enable_skills: Enable built-in skills
            enable_web_search: Enable web search tool
            enable_checkpointing: Enable state checkpointing for resumability
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()
        self.enable_checkpointing = enable_checkpointing

        # Initialize MCP if enabled
        self.mcp_manager: MCPSessionManager | None = None
        if enable_mcp and config.CHAT_MCP_ENABLED:
            mcp_config = config.get_mcp_servers_config()
            if mcp_config:
                self.mcp_manager = MCPSessionManager(mcp_config)

        # Initialize Skills if enabled
        self.skills_registry: SkillsRegistry | None = None
        if enable_skills and config.SKILLS_ENABLED:
            self.skills_registry = SkillsRegistry(workspace_root)
            # Register skills to global registry
            for skill in self.skills_registry.get_all_skills():
                self.tool_registry.register(skill)

        # Initialize web search if enabled
        if enable_web_search:
            self.tool_registry.register(WebSearchTool())

    async def initialize(self) -> None:
        """Initialize async components (MCP connections)."""
        if self.mcp_manager:
            try:
                await self.mcp_manager.connect_all()
                # Register MCP tools
                for tool in self.mcp_manager.get_tools():
                    self.tool_registry.register(tool)
            except Exception as e:
                # Log error with context and re-raise
                import logging

                logger = logging.getLogger(__name__)
                logger.exception(
                    "Failed to initialize MCP manager: %s. Service will continue without MCP tools.",
                    str(e),
                )
                # Clear MCP manager to prevent partial state
                self.mcp_manager = None
                raise

    async def shutdown(self) -> None:
        """Shutdown service and cleanup resources."""
        if self.mcp_manager:
            try:
                await self.mcp_manager.disconnect_all()
            except Exception as e:
                # Log error but don't prevent shutdown
                import logging

                logger = logging.getLogger(__name__)
                logger.exception(
                    "Error during MCP manager shutdown: %s. Continuing with cleanup.",
                    str(e),
                )

    async def chat_completion(
        self,
        model: str,
        messages: list[dict[str, Any]],
        stream: bool = False,
        tools: list[dict[str, Any]] | None = None,
        tool_choice: str = "auto",
        user_id: int | None = None,
        namespace: str = "default",
        deep_thinking: bool = False,
        max_tool_iterations: int = 10,
        thread_id: str | None = None,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute chat completion with LangGraph agent.

        Args:
            model: Model identifier (e.g., gpt-4o, claude-3-5-sonnet, gemini-2.0-flash)
            messages: Conversation messages
            stream: Whether to stream response
            tools: Optional custom tools (added to built-in tools)
            tool_choice: Tool selection strategy (currently not used, agent uses all registered tools)
            user_id: User ID for isolation
            namespace: Namespace for resource isolation
            deep_thinking: Enable multi-step reasoning with tool loops (uses LangGraph)
            max_tool_iterations: Maximum tool call iterations
            thread_id: Thread ID for checkpointing
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        import logging

        logger = logging.getLogger(__name__)

        try:
            # Create LangChain model instance
            lc_model = LangChainModelFactory.create_model(model, **kwargs)
        except Exception as e:
            logger.exception(
                "Failed to create model %s for user_id=%s, namespace=%s: %s",
                model,
                user_id,
                namespace,
                str(e),
            )
            raise ValueError(f"Failed to create model '{model}': {str(e)}") from e

        try:
            # Build LangGraph agent
            agent_builder = LangGraphAgentBuilder(
                llm=lc_model,
                tool_registry=self.tool_registry,
                max_iterations=max_tool_iterations,
                enable_checkpointing=self.enable_checkpointing,
            )
        except Exception as e:
            logger.exception(
                "Failed to build LangGraph agent for model %s, user_id=%s, namespace=%s, thread_id=%s: %s",
                model,
                user_id,
                namespace,
                thread_id,
                str(e),
            )
            raise ValueError(f"Failed to build agent: {str(e)}") from e

        # Prepare config for checkpointing
        config_dict = {
            "thread_id": thread_id or f"thread-{uuid.uuid4()}",
            "user_id": user_id,
            "namespace": namespace,
        }

        # Decide whether to use agent or direct LLM:
        # - Use agent if deep_thinking is enabled (multi-step reasoning requested)
        # - OR if there are any registered tools available
        # NOTE: tool_choice parameter is intentionally not used here as the agent
        # automatically uses all registered tools. To support tool_choice strategies,
        # this would need to be passed to the agent builder or tool registry.
        has_tools = len(self.tool_registry.get_all_tools()) > 0

        if deep_thinking or has_tools:
            # Use LangGraph agent for tool calling and multi-step reasoning
            if stream:
                return self._stream_agent_execution(
                    agent_builder, messages, config_dict
                )
            else:
                return await self._execute_agent(agent_builder, messages, config_dict)
        else:
            # Direct LLM call without tools
            if stream:
                return self._stream_direct_llm(lc_model, messages)
            else:
                return await self._execute_direct_llm(lc_model, messages)

    async def _execute_agent(
        self,
        agent_builder: LangGraphAgentBuilder,
        messages: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> CompletionResponse:
        """Execute LangGraph agent workflow.

        Args:
            agent_builder: LangGraph agent builder
            messages: Conversation messages
            config: Execution configuration

        Returns:
            CompletionResponse with final answer
        """
        # Execute agent
        final_state = await agent_builder.execute(messages, config)

        # Extract final message
        final_messages = final_state["messages"]
        last_message = final_messages[-1]

        # Extract usage from final message or accumulate from all AI messages
        usage = extract_usage_from_response(last_message)
        if usage["total_tokens"] == 0:
            # Accumulate usage from all AI messages in the state
            for msg in final_messages:
                if isinstance(msg, AIMessage):
                    msg_usage = extract_usage_from_response(msg)
                    if msg_usage["total_tokens"] > 0:
                        usage["prompt_tokens"] += msg_usage["prompt_tokens"]
                        usage["completion_tokens"] += msg_usage["completion_tokens"]
                        usage["total_tokens"] += msg_usage["total_tokens"]

        # Convert to CompletionResponse
        if isinstance(last_message, AIMessage):
            content = (
                last_message.content if isinstance(last_message.content, str) else ""
            )
            tool_calls = None

            if hasattr(last_message, "tool_calls") and last_message.tool_calls:
                # Convert LangChain tool calls to OpenAI format
                tool_calls = [
                    {
                        "id": tc.get("id", f"call-{uuid.uuid4()}"),
                        "type": "function",
                        "function": {
                            "name": tc["name"],
                            "arguments": json.dumps(tc["args"]),
                        },
                    }
                    for tc in last_message.tool_calls
                ]

            return CompletionResponse(
                content=content,
                tool_calls=tool_calls,
                finish_reason="stop",
                usage=usage,
            )
        else:
            # Fallback for non-AI messages
            return CompletionResponse(
                content=(
                    str(last_message.content)
                    if hasattr(last_message, "content")
                    else ""
                ),
                tool_calls=None,
                finish_reason="stop",
                usage=usage,
            )

    async def _stream_agent_execution(
        self,
        agent_builder: LangGraphAgentBuilder,
        messages: list[dict[str, Any]],
        config: dict[str, Any],
    ) -> AsyncIterator[StreamChunk]:
        """Stream LangGraph agent execution.

        Args:
            agent_builder: LangGraph agent builder
            messages: Conversation messages
            config: Execution configuration

        Yields:
            StreamChunk for each state update
        """
        # Accumulate usage across all messages
        accumulated_usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

        async for event in agent_builder.stream_execute(messages, config):
            # Extract messages from event
            for node_name, state in event.items():
                if "messages" in state:
                    messages_list = state["messages"]
                    for msg in messages_list:
                        if isinstance(msg, AIMessage):
                            # Stream AI message content
                            if msg.content:
                                yield StreamChunk(
                                    delta={"content": msg.content}, finish_reason=None
                                )

                            # Stream tool calls
                            if hasattr(msg, "tool_calls") and msg.tool_calls:
                                tool_calls_formatted = [
                                    {
                                        "id": tc.get("id", f"call-{uuid.uuid4()}"),
                                        "type": "function",
                                        "function": {
                                            "name": tc["name"],
                                            "arguments": json.dumps(tc["args"]),
                                        },
                                    }
                                    for tc in msg.tool_calls
                                ]
                                yield StreamChunk(
                                    delta={"tool_calls": tool_calls_formatted},
                                    finish_reason=None,
                                )

                            # Accumulate usage from this message
                            msg_usage = extract_usage_from_response(msg)
                            if msg_usage["total_tokens"] > 0:
                                accumulated_usage["prompt_tokens"] += msg_usage[
                                    "prompt_tokens"
                                ]
                                accumulated_usage["completion_tokens"] += msg_usage[
                                    "completion_tokens"
                                ]
                                accumulated_usage["total_tokens"] += msg_usage[
                                    "total_tokens"
                                ]

        # Final chunk with accumulated usage
        yield StreamChunk(
            delta={},
            finish_reason="stop",
            usage=accumulated_usage,
        )

    async def _execute_direct_llm(
        self,
        lc_model,
        messages: list[dict[str, Any]],
    ) -> CompletionResponse:
        """Execute direct LLM call without tools.

        Args:
            lc_model: LangChain model instance
            messages: Conversation messages

        Returns:
            CompletionResponse
        """
        from langchain_core.messages import AIMessage as LCAIMessage
        from langchain_core.messages import (
            HumanMessage,
            SystemMessage,
        )

        # Convert to LangChain messages
        lc_messages = []
        for msg in messages:
            role = msg["role"]
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_messages.append(LCAIMessage(content=content))

        # Invoke model
        response = await lc_model.ainvoke(lc_messages)

        # Extract usage from response
        usage = extract_usage_from_response(response)

        return CompletionResponse(
            content=response.content if isinstance(response.content, str) else "",
            tool_calls=None,
            finish_reason="stop",
            usage=usage,
        )

    async def _stream_direct_llm(
        self,
        lc_model,
        messages: list[dict[str, Any]],
    ) -> AsyncIterator[StreamChunk]:
        """Stream direct LLM call without tools.

        Args:
            lc_model: LangChain model instance
            messages: Conversation messages

        Yields:
            StreamChunk
        """
        from langchain_core.messages import AIMessage as LCAIMessage
        from langchain_core.messages import (
            HumanMessage,
            SystemMessage,
        )

        # Convert to LangChain messages
        lc_messages = []
        for msg in messages:
            role = msg["role"]
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_messages.append(LCAIMessage(content=content))

        # Accumulate usage across chunks
        accumulated_usage = {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        }

        # Stream model response
        async for chunk in lc_model.astream(lc_messages):
            if chunk.content:
                yield StreamChunk(delta={"content": chunk.content}, finish_reason=None)

            # Accumulate usage from each chunk if available
            chunk_usage = extract_usage_from_response(chunk)
            if chunk_usage["total_tokens"] > 0:
                accumulated_usage = chunk_usage

        # Final chunk with accumulated usage
        yield StreamChunk(
            delta={},
            finish_reason="stop",
            usage=accumulated_usage,
        )

    def list_available_tools(self) -> list[dict[str, Any]]:
        """List all available tools.

        Returns:
            List of tool definitions in OpenAI format
        """
        return self.tool_registry.to_openai_format()

    def get_tool_registry(self) -> ToolRegistry:
        """Get tool registry instance.

        Returns:
            ToolRegistry
        """
        return self.tool_registry
