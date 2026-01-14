# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Agent - agent creation and execution logic.

This module provides the ChatAgent class which handles:
- LangGraph agent creation and configuration
- Tool registry management
- Agent execution (both streaming and non-streaming)
- Automatic message compression when context limits are exceeded

The ChatAgent is decoupled from streaming infrastructure, making it easier
to test and maintain. Streaming is handled by the streaming module.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from langchain_core.tools.base import BaseTool
from shared.telemetry.decorators import (
    add_span_event,
    trace_async_generator,
    trace_sync,
)

from chat_shell.core.config import settings

from .agents import LangGraphAgentBuilder
from .compression import MessageCompressor
from .messages import MessageConverter
from .models import LangChainModelFactory
from .tools import ToolRegistry
from .tools.builtin import WebSearchTool

logger = logging.getLogger(__name__)


@dataclass
class AgentConfig:
    """Configuration for agent creation.

    This dataclass holds all the parameters needed to create and configure
    a chat agent, keeping the creation logic clean and type-safe.

    Note: Tools that implement PromptModifierTool protocol (e.g., LoadSkillTool)
    should be included in extra_tools. The LangGraphAgentBuilder will automatically
    detect and use them for dynamic prompt modification.
    """

    model_config: dict[str, Any]
    system_prompt: str = ""
    max_iterations: int = 10  # Default, can be overridden by settings
    extra_tools: list[BaseTool] | None = None
    streaming: bool = True
    # Prompt enhancement options (handled internally by ChatAgent)
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    skills: list[dict[str, Any]] | None = None  # All skill configs (with preload field)


class ChatAgent:
    """Agent for chat completions using LangGraph.

    This class handles agent-related logic only:
    - Creating LangGraph agents with proper configuration
    - Managing tool registry
    - Executing agent workflows
    - Processing tool outputs

    Streaming infrastructure is handled separately by the streaming module.

    Usage:
        agent = ChatAgent()

        # Non-streaming
        result = await agent.execute(messages, agent_config)

        # Streaming (returns async generator)
        async for token in agent.stream(messages, agent_config, cancel_event, on_tool_event):
            print(token)
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_skills: bool = False,
        enable_web_search: bool = False,
        enable_checkpointing: bool = False,
    ):
        """Initialize Chat Agent.

        Args:
            workspace_root: Root directory for file operations
            enable_skills: Enable built-in file skills
            enable_web_search: Enable web search tool (global default)
            enable_checkpointing: Enable state checkpointing
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()
        self.enable_checkpointing = enable_checkpointing
        self._enable_web_search_default = enable_web_search

        # Register built-in skills
        # if enable_skills:
        # from .tools.builtin import FileListSkill, FileReaderSkill

        # self.tool_registry.register(FileReaderSkill(workspace_root=workspace_root))
        # self.tool_registry.register(FileListSkill(workspace_root=workspace_root))

        # Register web search if enabled globally
        web_search_enabled = getattr(settings, "WEB_SEARCH_ENABLED", False)
        if enable_web_search and web_search_enabled:
            default_max_results = getattr(settings, "WEB_SEARCH_DEFAULT_MAX_RESULTS", 5)
            self.tool_registry.register(
                WebSearchTool(default_max_results=default_max_results)
            )

    @trace_sync(
        span_name="chat_agent.create_agent_builder",
        tracer_name="chat_shell.agent",
        extract_attributes=lambda self, config, *args, **kwargs: {
            "agent.model_id": config.model_config.get("model_id", "unknown"),
            "agent.extra_tools_count": (
                len(config.extra_tools) if config.extra_tools else 0
            ),
            "agent.max_iterations": config.max_iterations,
            "agent.streaming": config.streaming,
        },
    )
    def create_agent_builder(self, config: AgentConfig) -> LangGraphAgentBuilder:
        """Create a LangGraph agent builder with the given configuration.

        Args:
            config: Agent configuration

        Returns:
            Configured LangGraphAgentBuilder instance
        """
        # Create LangChain model from config with streaming enabled
        add_span_event("creating_llm_started")
        llm = LangChainModelFactory.create_from_config(
            config.model_config, streaming=config.streaming
        )
        add_span_event("creating_llm_completed")

        # Create a temporary registry with extra tools
        add_span_event("creating_tool_registry")
        tool_registry = ToolRegistry()

        # Copy existing tools
        for tool in self.tool_registry.get_all():
            tool_registry.register(tool)

        # Add extra tools (including PromptModifierTool instances like LoadSkillTool)
        # LangGraphAgentBuilder will automatically detect PromptModifierTool instances
        if config.extra_tools:
            for tool in config.extra_tools:
                tool_registry.register(tool)
        add_span_event(
            "tool_registry_built",
            {"total_tools": len(tool_registry.get_all())},
        )

        # Create agent builder - it will auto-detect PromptModifierTool from registry
        add_span_event("creating_langgraph_agent_builder")
        builder = LangGraphAgentBuilder(
            llm=llm,
            tool_registry=tool_registry,
            max_iterations=config.max_iterations,
            enable_checkpointing=self.enable_checkpointing,
        )
        add_span_event("langgraph_agent_builder_created")
        return builder

    async def execute(
        self,
        messages: list[dict[str, Any]],
        config: AgentConfig,
    ) -> dict[str, Any]:
        """Execute agent in non-streaming mode.

        Args:
            messages: List of message dictionaries
            config: Agent configuration

        Returns:
            Dict with content, tool_results, iterations

        Raises:
            RuntimeError: If agent execution fails
        """
        agent = self.create_agent_builder(config)
        final_state = await agent.execute(messages)

        content = agent.get_final_content(final_state)
        error = final_state.get("error")

        if error:
            raise RuntimeError(error)

        return {
            "content": content,
            "tool_results": final_state.get("tool_results", []),
            "iterations": final_state.get("iteration", 0),
        }

    @trace_async_generator(
        span_name="chat_agent.stream",
        tracer_name="chat_shell.agent",
        extract_attributes=lambda self, messages, config, *args, **kwargs: {
            "stream.message_count": len(messages),
            "stream.model_id": config.model_config.get("model_id", "unknown"),
        },
    )
    async def stream(
        self,
        messages: list[dict[str, Any]],
        config: AgentConfig,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
        agent_builder: LangGraphAgentBuilder | None = None,
    ):
        """Stream tokens from agent execution.

        This is a generator that yields tokens from the agent.
        Tool events are handled via the on_tool_event callback.

        Args:
            messages: List of message dictionaries
            config: Agent configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional callback for tool events (kind, event_data)
            agent_builder: Optional pre-created agent builder to reuse (avoids duplicate creation)

        Yields:
            Tokens from the agent
        """
        if agent_builder is None:
            add_span_event("stream_creating_agent_builder")
            agent_builder = self.create_agent_builder(config)
            add_span_event("stream_agent_builder_created")
        else:
            add_span_event("stream_reusing_agent_builder")

        add_span_event("stream_tokens_starting")
        async for token in agent_builder.stream_tokens(
            messages,
            cancel_event=cancel_event,
            on_tool_event=on_tool_event,
        ):
            yield token

    @staticmethod
    def process_tool_output(
        tool_name: str, serializable_output: Any
    ) -> tuple[str, list[dict[str, Any]]]:
        """Process tool output and extract metadata like sources.

        This method handles tool-specific output processing in a unified way:
        - Parses JSON output if needed
        - Extracts metadata (sources, count, etc.)
        - Returns a friendly title and extracted sources

        Args:
            tool_name: Name of the tool
            serializable_output: Tool output (string or dict)

        Returns:
            Tuple of (friendly title, list of sources)
        """
        # Default title
        title = f"Tool completed: {tool_name}"
        sources: list[dict[str, Any]] = []

        if not serializable_output:
            return title, sources

        try:
            # Parse output to dict if it's a JSON string
            # Only attempt JSON parsing if the string looks like JSON (starts with { or [)
            output_data = serializable_output
            if isinstance(serializable_output, str):
                stripped = serializable_output.strip()
                if stripped.startswith("{") or stripped.startswith("["):
                    try:
                        output_data = json.loads(serializable_output)
                    except json.JSONDecodeError:
                        # Not valid JSON, keep as string
                        pass

            if not isinstance(output_data, dict):
                return title, sources

            # Extract common fields
            count = output_data.get("count", 0)
            extracted_sources = output_data.get("sources", [])

            # Add sources if present (for knowledge base and similar tools)
            if extracted_sources:
                sources = extracted_sources
                logger.info(
                    "[TOOL_OUTPUT] Extracted %d sources from %s",
                    len(sources),
                    tool_name,
                )

            # Build tool-specific friendly titles
            if tool_name == "web_search":
                if count > 0:
                    title = f"Found {count} search results"
                else:
                    title = "No search results found"
            elif tool_name == "knowledge_base_search":
                if count > 0:
                    title = f"Retrieved {count} items from knowledge base"
                else:
                    title = "No relevant information found in knowledge base"
            else:
                # Generic title for other tools with count
                if count > 0:
                    title = f"{tool_name}: {count} results"

        except Exception as e:
            logger.warning(
                "[TOOL_OUTPUT] Failed to process output for %s: %s", tool_name, str(e)
            )

        return title, sources

    def build_messages(
        self,
        history: list[dict[str, Any]],
        current_message: str | dict[str, Any],
        system_prompt: str,
        username: str | None = None,
        config: AgentConfig | None = None,
        model_id: str | None = None,
        inject_datetime: bool | None = None,
    ) -> list[dict[str, Any]]:
        """Build messages for agent execution.

        Args:
            history: Chat history
            current_message: Current user message
            system_prompt: Base system prompt (will be enhanced if config is provided)
            username: Optional username for group chat
            config: Optional AgentConfig for prompt enhancements
            model_id: Optional model ID for compression configuration
            inject_datetime: Whether to inject current datetime into user message.
                            If None, uses config.enable_deep_thinking value.
                            If config is also None, defaults to True for backward compatibility.

        Returns:
            List of message dictionaries ready for agent
        """
        # Build final system prompt with enhancements if config is provided
        final_prompt = system_prompt
        if config:
            from .prompts import build_system_prompt

            final_prompt = build_system_prompt(
                base_prompt=system_prompt,
                enable_clarification=config.enable_clarification,
                enable_deep_thinking=config.enable_deep_thinking,
                skills=config.skills,
            )

        # Determine inject_datetime value:
        # - If explicitly provided, use it
        # - If config is provided, follow enable_deep_thinking (web behavior controlled by this flag)
        # - Otherwise default to True for backward compatibility
        if inject_datetime is None:
            if config is not None:
                inject_datetime = config.enable_deep_thinking
            else:
                inject_datetime = True

        messages = MessageConverter.build_messages(
            history,
            current_message,
            final_prompt,
            username=username,
            inject_datetime=inject_datetime,
        )

        # Apply message compression if enabled and model_id is provided
        compression_enabled = getattr(settings, "MESSAGE_COMPRESSION_ENABLED", False)
        if model_id and compression_enabled:
            # Pass model_config to compressor for context window configuration
            model_config_for_compression = config.model_config if config else None
            compressor = MessageCompressor(
                model_id,
                model_config=model_config_for_compression,
            )
            result = compressor.compress_if_needed(messages)

            if result.was_compressed:
                logger.info(
                    "[ChatAgent] Messages compressed: %d -> %d tokens (saved %d), "
                    "strategies: %s",
                    result.original_tokens,
                    result.compressed_tokens,
                    result.tokens_saved,
                    ", ".join(result.strategies_applied),
                )
                messages = result.messages

        return messages

    def list_tools(self) -> list[dict[str, Any]]:
        """List available tools in OpenAI format."""
        return [
            {
                "type": "function",
                "function": {
                    "name": tool.name,
                    "description": tool.description,
                    "parameters": (
                        tool.args_schema.model_json_schema() if tool.args_schema else {}
                    ),
                },
            }
            for tool in self.tool_registry.get_all()
        ]


def create_chat_agent(
    workspace_root: str | None = None,
    enable_skills: bool = True,
    enable_web_search: bool = False,
    enable_checkpointing: bool = False,
) -> ChatAgent:
    """Create a ChatAgent instance with configuration from settings.

    This factory function creates a ChatAgent with sensible defaults
    from the application settings.

    Args:
        workspace_root: Override workspace root (defaults to settings)
        enable_skills: Enable built-in file skills
        enable_web_search: Enable web search tool
        enable_checkpointing: Enable state checkpointing

    Returns:
        Configured ChatAgent instance
    """
    if workspace_root is None:
        workspace_root = getattr(settings, "WORKSPACE_ROOT", "/workspace")

    return ChatAgent(
        workspace_root=workspace_root,
        enable_skills=enable_skills,
        enable_web_search=enable_web_search,
        enable_checkpointing=enable_checkpointing,
    )
