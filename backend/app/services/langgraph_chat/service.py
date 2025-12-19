"""LangGraph Chat Service - main service entry point."""

from typing import List, Dict, Any, Optional, AsyncIterator
import json

from .config import config
from .providers import ProviderFactory, Message, StreamChunk, CompletionResponse
from .tools import ToolRegistry, global_registry, SkillsRegistry, WebSearchTool
from .tools.mcp import MCPSessionManager


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    Provides OpenAI-compatible chat completion API with support for:
    - Multiple LLM providers (OpenAI, Anthropic, Google Gemini)
    - Tool calling with MCP integration
    - Skills for large file handling
    - Streaming responses
    - Multi-tenant isolation
    """

    def __init__(
        self,
        workspace_root: str = "/workspace",
        enable_mcp: bool = False,
        enable_skills: bool = True,
        enable_web_search: bool = False,
    ):
        """Initialize LangGraph Chat Service.

        Args:
            workspace_root: Root directory for file operations
            enable_mcp: Enable MCP tool integration
            enable_skills: Enable built-in skills
            enable_web_search: Enable web search tool
        """
        self.workspace_root = workspace_root
        self.tool_registry = ToolRegistry()

        # Initialize MCP if enabled
        self.mcp_manager: Optional[MCPSessionManager] = None
        if enable_mcp and config.MCP_ENABLED:
            mcp_config = config.get_mcp_servers_config()
            if mcp_config:
                self.mcp_manager = MCPSessionManager(mcp_config)

        # Initialize Skills if enabled
        self.skills_registry: Optional[SkillsRegistry] = None
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
            await self.mcp_manager.connect_all()
            # Register MCP tools
            for tool in self.mcp_manager.get_tools():
                self.tool_registry.register(tool)

    async def shutdown(self) -> None:
        """Shutdown service and cleanup resources."""
        if self.mcp_manager:
            await self.mcp_manager.disconnect_all()

    async def chat_completion(
        self,
        model: str,
        messages: List[Dict[str, Any]],
        stream: bool = False,
        tools: Optional[List[Dict[str, Any]]] = None,
        tool_choice: str = "auto",
        user_id: Optional[int] = None,
        namespace: str = "default",
        deep_thinking: bool = False,
        max_tool_iterations: int = 10,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute chat completion with optional tool calling.

        Args:
            model: Model identifier (e.g., gpt-4o, claude-3-5-sonnet)
            messages: Conversation messages
            stream: Whether to stream response
            tools: Optional custom tools (added to built-in tools)
            tool_choice: Tool selection strategy
            user_id: User ID for isolation
            namespace: Namespace for resource isolation
            deep_thinking: Enable multi-step reasoning with tool loops
            max_tool_iterations: Maximum tool call iterations
            **kwargs: Additional parameters

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        # Convert messages to provider format
        provider_messages = [self._dict_to_message(msg) for msg in messages]

        # Get provider
        provider = ProviderFactory.create_provider(model)

        # Prepare tools
        available_tools = self._prepare_tools(tools)

        # Execute completion
        if deep_thinking and available_tools:
            # Deep thinking mode: iterative tool calling
            return await self._deep_thinking_completion(
                provider,
                provider_messages,
                available_tools,
                tool_choice,
                stream,
                max_tool_iterations,
                **kwargs,
            )
        else:
            # Standard completion
            return await provider.chat_completion(
                messages=provider_messages,
                tools=available_tools if available_tools else None,
                tool_choice=tool_choice,
                stream=stream,
                **kwargs,
            )

    async def _deep_thinking_completion(
        self,
        provider: Any,
        messages: List[Message],
        tools: List[Dict[str, Any]],
        tool_choice: str,
        stream: bool,
        max_iterations: int,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute deep thinking completion with tool loops.

        Args:
            provider: LLM provider
            messages: Conversation messages
            tools: Available tools
            tool_choice: Tool selection strategy
            stream: Whether to stream
            max_iterations: Maximum iterations
            **kwargs: Additional parameters

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        current_messages = messages.copy()
        iteration = 0

        while iteration < max_iterations:
            # Call LLM
            response = await provider.chat_completion(
                messages=current_messages,
                tools=tools,
                tool_choice=tool_choice,
                stream=False,  # No streaming in iterative mode
                **kwargs,
            )

            # Check if tool calls are present
            if not response.tool_calls:
                # No more tool calls, return final response
                if stream:
                    return self._response_to_stream(response)
                else:
                    return response

            # Execute tool calls
            tool_results = []
            for tool_call in response.tool_calls:
                tool_name = tool_call["function"]["name"]
                tool_args = json.loads(tool_call["function"]["arguments"]) if isinstance(tool_call["function"]["arguments"], str) else tool_call["function"]["arguments"]

                # Execute tool
                result = await self.tool_registry.execute_tool(tool_name, **tool_args)

                tool_results.append(
                    {
                        "tool_call_id": tool_call["id"],
                        "role": "tool",
                        "name": tool_name,
                        "content": json.dumps(result.model_dump() if hasattr(result, "model_dump") else {"output": result.output, "error": result.error}),
                    }
                )

            # Add assistant message with tool calls
            current_messages.append(
                Message(
                    role="assistant",
                    content=response.content or "",
                    tool_calls=response.tool_calls,
                )
            )

            # Add tool results
            for tool_result in tool_results:
                current_messages.append(
                    Message(
                        role="tool",
                        content=tool_result["content"],
                        tool_call_id=tool_result["tool_call_id"],
                        name=tool_result["name"],
                    )
                )

            iteration += 1

        # Max iterations reached, return last response
        if stream:
            return self._response_to_stream(response)
        else:
            return response

    def _prepare_tools(self, custom_tools: Optional[List[Dict[str, Any]]]) -> List[Dict[str, Any]]:
        """Prepare tools list (built-in + custom).

        Args:
            custom_tools: Optional custom tools

        Returns:
            Combined tools list in OpenAI format
        """
        tools = self.tool_registry.to_openai_format()

        if custom_tools:
            tools.extend(custom_tools)

        return tools

    def _dict_to_message(self, msg_dict: Dict[str, Any]) -> Message:
        """Convert dict to Message model.

        Args:
            msg_dict: Message dictionary

        Returns:
            Message instance
        """
        return Message(
            role=msg_dict["role"],
            content=msg_dict.get("content", ""),
            name=msg_dict.get("name"),
            tool_calls=msg_dict.get("tool_calls"),
            tool_call_id=msg_dict.get("tool_call_id"),
        )

    async def _response_to_stream(self, response: CompletionResponse) -> AsyncIterator[StreamChunk]:
        """Convert CompletionResponse to stream chunks.

        Args:
            response: Completion response

        Yields:
            Stream chunks
        """
        # Yield content chunk
        if response.content:
            yield StreamChunk(delta={"content": response.content}, finish_reason=None)

        # Yield tool calls chunk
        if response.tool_calls:
            yield StreamChunk(delta={"tool_calls": response.tool_calls}, finish_reason=None)

        # Yield final chunk
        yield StreamChunk(delta={}, finish_reason=response.finish_reason, usage=response.usage)

    def list_available_tools(self) -> List[Dict[str, Any]]:
        """List all available tools.

        Returns:
            List of tool definitions
        """
        return self.tool_registry.to_openai_format()

    def get_tool_registry(self) -> ToolRegistry:
        """Get tool registry instance.

        Returns:
            ToolRegistry
        """
        return self.tool_registry
