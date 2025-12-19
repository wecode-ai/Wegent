"""LangGraph Chat Service - main service entry point with real LangGraph agent."""

from typing import List, Dict, Any, Optional, AsyncIterator
import json
import uuid
import time

from langchain_core.messages import AIMessage

from .config import config
from .providers.langchain_models import LangChainModelFactory
from .tools import ToolRegistry, SkillsRegistry, WebSearchTool
from .tools.mcp import MCPSessionManager
from .agents.graph_builder import LangGraphAgentBuilder


class StreamChunk:
    """Stream chunk response."""
    def __init__(self, delta: Dict[str, Any], finish_reason: Optional[str] = None, usage: Optional[Dict[str, int]] = None):
        self.delta = delta
        self.finish_reason = finish_reason
        self.usage = usage


class CompletionResponse:
    """Chat completion response."""
    def __init__(
        self,
        content: str,
        tool_calls: Optional[List[Dict[str, Any]]] = None,
        finish_reason: str = "stop",
        usage: Optional[Dict[str, int]] = None,
    ):
        self.content = content
        self.tool_calls = tool_calls
        self.finish_reason = finish_reason
        self.usage = usage or {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


class LangGraphChatService:
    """Main service for LangGraph-based chat completions.

    Uses LangChain/LangGraph framework for agent orchestration with:
    - Real LangGraph state management
    - Tool binding via LangChain
    - OpenAI/Gemini/Anthropic SDK integration through LangChain
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
        thread_id: Optional[str] = None,
        **kwargs,
    ) -> CompletionResponse | AsyncIterator[StreamChunk]:
        """Execute chat completion with LangGraph agent.

        Args:
            model: Model identifier (e.g., gpt-4o, claude-3-5-sonnet, gemini-2.0-flash)
            messages: Conversation messages
            stream: Whether to stream response
            tools: Optional custom tools (added to built-in tools)
            tool_choice: Tool selection strategy
            user_id: User ID for isolation
            namespace: Namespace for resource isolation
            deep_thinking: Enable multi-step reasoning with tool loops (uses LangGraph)
            max_tool_iterations: Maximum tool call iterations
            thread_id: Thread ID for checkpointing
            **kwargs: Additional parameters (temperature, max_tokens, etc.)

        Returns:
            CompletionResponse or AsyncIterator[StreamChunk]
        """
        # Create LangChain model instance
        lc_model = LangChainModelFactory.create_model(model, **kwargs)

        # Build LangGraph agent
        agent_builder = LangGraphAgentBuilder(
            llm=lc_model,
            tool_registry=self.tool_registry,
            max_iterations=max_tool_iterations,
            enable_checkpointing=self.enable_checkpointing,
        )

        # Prepare config for checkpointing
        config_dict = {
            "thread_id": thread_id or f"thread-{uuid.uuid4()}",
            "user_id": user_id,
            "namespace": namespace,
        }

        if deep_thinking or (tools and len(self.tool_registry.get_all_tools()) > 0):
            # Use LangGraph agent for tool calling and multi-step reasoning
            if stream:
                return self._stream_agent_execution(agent_builder, messages, config_dict)
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
        messages: List[Dict[str, Any]],
        config: Dict[str, Any],
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

        # Convert to CompletionResponse
        if isinstance(last_message, AIMessage):
            content = last_message.content if isinstance(last_message.content, str) else ""
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
                usage={
                    "prompt_tokens": 0,  # TODO: Calculate from state
                    "completion_tokens": 0,
                    "total_tokens": 0,
                },
            )
        else:
            # Fallback for non-AI messages
            return CompletionResponse(
                content=str(last_message.content) if hasattr(last_message, "content") else "",
                tool_calls=None,
                finish_reason="stop",
                usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
            )

    async def _stream_agent_execution(
        self,
        agent_builder: LangGraphAgentBuilder,
        messages: List[Dict[str, Any]],
        config: Dict[str, Any],
    ) -> AsyncIterator[StreamChunk]:
        """Stream LangGraph agent execution.

        Args:
            agent_builder: LangGraph agent builder
            messages: Conversation messages
            config: Execution configuration

        Yields:
            StreamChunk for each state update
        """
        async for event in agent_builder.stream_execute(messages, config):
            # Extract messages from event
            for node_name, state in event.items():
                if "messages" in state:
                    messages_list = state["messages"]
                    for msg in messages_list:
                        if isinstance(msg, AIMessage):
                            # Stream AI message content
                            if msg.content:
                                yield StreamChunk(delta={"content": msg.content}, finish_reason=None)

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
                                yield StreamChunk(delta={"tool_calls": tool_calls_formatted}, finish_reason=None)

        # Final chunk
        yield StreamChunk(delta={}, finish_reason="stop", usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

    async def _execute_direct_llm(
        self,
        lc_model,
        messages: List[Dict[str, Any]],
    ) -> CompletionResponse:
        """Execute direct LLM call without tools.

        Args:
            lc_model: LangChain model instance
            messages: Conversation messages

        Returns:
            CompletionResponse
        """
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage as LCAIMessage

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

        return CompletionResponse(
            content=response.content if isinstance(response.content, str) else "",
            tool_calls=None,
            finish_reason="stop",
            usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        )

    async def _stream_direct_llm(
        self,
        lc_model,
        messages: List[Dict[str, Any]],
    ) -> AsyncIterator[StreamChunk]:
        """Stream direct LLM call without tools.

        Args:
            lc_model: LangChain model instance
            messages: Conversation messages

        Yields:
            StreamChunk
        """
        from langchain_core.messages import SystemMessage, HumanMessage, AIMessage as LCAIMessage

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

        # Stream model response
        async for chunk in lc_model.astream(lc_messages):
            if chunk.content:
                yield StreamChunk(delta={"content": chunk.content}, finish_reason=None)

        # Final chunk
        yield StreamChunk(delta={}, finish_reason="stop", usage={"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0})

    def list_available_tools(self) -> List[Dict[str, Any]]:
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
