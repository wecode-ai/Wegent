# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Chat Agent - agent creation and execution logic.

This module provides the ChatAgent class which handles:
- LangGraph agent creation and configuration
- Tool registry management
- Agent execution (both streaming and non-streaming)

The ChatAgent is decoupled from streaming infrastructure, making it easier
to test and maintain. Streaming is handled by the streaming module.
"""

import asyncio
import json
import logging
from dataclasses import dataclass
from typing import Any, Callable

from langchain_core.tools.base import BaseTool

from app.core.config import settings

from .agents import LangGraphAgentBuilder
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
    """

    model_config: dict[str, Any]
    system_prompt: str = ""
    max_iterations: int = settings.CHAT_TOOL_MAX_REQUESTS
    extra_tools: list[BaseTool] | None = None
    load_skill_tool: Any = None
    streaming: bool = True
    # Prompt enhancement options (handled internally by ChatAgent)
    enable_clarification: bool = False
    enable_deep_thinking: bool = True
    skills: list[dict[str, Any]] | None = None  # Skill metadata for prompt injection


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
        if enable_skills:
            from .tools.builtin import FileListSkill, FileReaderSkill

            self.tool_registry.register(FileReaderSkill(workspace_root=workspace_root))
            self.tool_registry.register(FileListSkill(workspace_root=workspace_root))

        # Register web search if enabled globally
        if enable_web_search and settings.WEB_SEARCH_ENABLED:
            self.tool_registry.register(
                WebSearchTool(
                    default_max_results=settings.WEB_SEARCH_DEFAULT_MAX_RESULTS
                )
            )

    def create_agent_builder(self, config: AgentConfig) -> LangGraphAgentBuilder:
        """Create a LangGraph agent builder with the given configuration.

        Args:
            config: Agent configuration

        Returns:
            Configured LangGraphAgentBuilder instance
        """
        # Create LangChain model from config with streaming enabled
        llm = LangChainModelFactory.create_from_config(
            config.model_config, streaming=config.streaming
        )

        # Create a temporary registry with extra tools
        tool_registry = ToolRegistry()

        # Copy existing tools
        for tool in self.tool_registry.get_all():
            tool_registry.register(tool)

        # Add extra tools
        if config.extra_tools:
            for tool in config.extra_tools:
                tool_registry.register(tool)

        # Create agent builder with load_skill_tool for dynamic skill prompt injection
        return LangGraphAgentBuilder(
            llm=llm,
            tool_registry=tool_registry,
            max_iterations=config.max_iterations,
            enable_checkpointing=self.enable_checkpointing,
            load_skill_tool=config.load_skill_tool,
        )

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

    async def stream(
        self,
        messages: list[dict[str, Any]],
        config: AgentConfig,
        cancel_event: asyncio.Event | None = None,
        on_tool_event: Callable[[str, dict], None] | None = None,
    ):
        """Stream tokens from agent execution.

        This is a generator that yields tokens from the agent.
        Tool events are handled via the on_tool_event callback.

        Args:
            messages: List of message dictionaries
            config: Agent configuration
            cancel_event: Optional cancellation event
            on_tool_event: Optional callback for tool events (kind, event_data)

        Yields:
            Tokens from the agent
        """
        agent = self.create_agent_builder(config)

        async for token in agent.stream_tokens(
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
    ) -> list[dict[str, Any]]:
        """Build messages for agent execution.

        Args:
            history: Chat history
            current_message: Current user message
            system_prompt: Base system prompt (will be enhanced if config is provided)
            username: Optional username for group chat
            config: Optional AgentConfig for prompt enhancements

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

        return MessageConverter.build_messages(
            history, current_message, final_prompt, username=username
        )

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


# Global agent instance for simple use cases
chat_agent = ChatAgent(
    workspace_root=getattr(settings, "WORKSPACE_ROOT", "/workspace"),
    enable_skills=getattr(settings, "ENABLE_SKILLS", True),
    enable_web_search=settings.WEB_SEARCH_ENABLED,
    enable_checkpointing=getattr(settings, "ENABLE_CHECKPOINTING", False),
)
