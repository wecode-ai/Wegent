"""LangGraph graph builder for agent workflows."""

from typing import Any, Callable, Dict, List, Optional

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import Tool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from ..tools.base import BaseTool, ToolRegistry
from .state import AgentState


class LangGraphAgentBuilder:
    """Builder for LangGraph-based agent workflows with tool calling."""

    def __init__(
        self,
        llm: BaseChatModel,
        tool_registry: ToolRegistry,
        max_iterations: int = 10,
        enable_checkpointing: bool = False,
    ):
        """Initialize agent builder.

        Args:
            llm: LangChain chat model instance
            tool_registry: Registry of available tools
            max_iterations: Maximum tool loop iterations
            enable_checkpointing: Enable state checkpointing for resumability
        """
        self.llm = llm
        self.tool_registry = tool_registry
        self.max_iterations = max_iterations
        self.enable_checkpointing = enable_checkpointing

        # Convert tools to LangChain format
        self.langchain_tools = self._convert_tools_to_langchain()

        # Bind tools to LLM
        if self.langchain_tools:
            self.llm_with_tools = self.llm.bind_tools(self.langchain_tools)
        else:
            self.llm_with_tools = self.llm

    def _convert_tools_to_langchain(self) -> List[Tool]:
        """Convert tool registry to LangChain Tool objects.

        Returns:
            List of LangChain Tool instances
        """
        langchain_tools = []

        for tool in self.tool_registry.get_all_tools():
            # Create async function wrapper for tool execution
            # Use a factory to bind the current tool to avoid closure variable capture issue
            def make_tool_func(bound_tool):
                async def tool_func(**kwargs):
                    result = await bound_tool.execute(**kwargs)
                    if result.success:
                        return result.output
                    else:
                        return f"Error: {result.error}"

                return tool_func

            tool_func_bound = make_tool_func(tool)

            # Create LangChain Tool
            lc_tool = Tool(
                name=tool.name,
                description=tool.description,
                func=tool_func_bound,
                coroutine=tool_func_bound,  # Use async version
            )
            langchain_tools.append(lc_tool)

        return langchain_tools

    async def call_model(self, state: AgentState) -> AgentState:
        """Node: Call LLM with current messages and tools.

        Args:
            state: Current agent state

        Returns:
            Updated state with LLM response
        """
        messages = state["messages"]

        # Call LLM with tools
        response = await self.llm_with_tools.ainvoke(messages)

        # Update state
        return {
            **state,
            "messages": [response],  # add_messages will append automatically
        }

    async def execute_tools(self, state: AgentState) -> AgentState:
        """Node: Execute tool calls from LLM response.

        Args:
            state: Current agent state with tool calls

        Returns:
            Updated state with tool results
        """
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
                    result = await self.tool_registry.execute_tool(
                        tool_name, **tool_args
                    )

                    # Store result
                    tool_results.append(
                        {
                            "tool_call_id": tool_call_id,
                            "tool_name": tool_name,
                            "result": (
                                result.model_dump()
                                if hasattr(result, "model_dump")
                                else {"output": result.output}
                            ),
                        }
                    )

                    # Create ToolMessage for LangChain
                    # Ensure content is always a string by serializing non-string outputs
                    import json

                    if result.success:
                        # Convert output to string
                        if isinstance(result.output, str):
                            content = result.output
                        else:
                            try:
                                content = json.dumps(result.output, ensure_ascii=False)
                            except (TypeError, ValueError):
                                content = str(result.output)
                    else:
                        content = f"Error: {result.error}"

                    tool_message = ToolMessage(
                        content=content,
                        tool_call_id=tool_call_id,
                        name=tool_name,
                    )
                    tool_messages.append(tool_message)

                except Exception as e:
                    # Handle tool execution errors
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
            "messages": tool_messages,  # add_messages will append
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
        messages = state["messages"]
        last_message = messages[-1]

        # Check if max iterations reached
        if state.get("iteration", 0) >= state.get(
            "max_iterations", self.max_iterations
        ):
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
        # Create graph
        workflow = StateGraph(AgentState)

        # Add nodes
        workflow.add_node("agent", self.call_model)
        workflow.add_node("tools", self.execute_tools)

        # Set entry point
        workflow.set_entry_point("agent")

        # Add conditional edges
        workflow.add_conditional_edges(
            "agent",
            self.should_continue,
            {
                "continue": "tools",
                "end": END,
            },
        )

        # Add edge from tools back to agent
        workflow.add_edge("tools", "agent")

        # Compile graph
        if self.enable_checkpointing:
            memory = MemorySaver()
            return workflow.compile(checkpointer=memory)
        else:
            return workflow.compile()

    async def execute(
        self,
        messages: List[Dict[str, Any]],
        config: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Execute agent workflow.

        Args:
            messages: Initial conversation messages
            config: Optional configuration (thread_id for checkpointing)

        Returns:
            Final agent state with response
        """
        # Convert messages to LangChain format
        lc_messages = []
        for msg in messages:
            role = msg["role"]
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))

        # Initialize state
        initial_state: AgentState = {
            "messages": lc_messages,
            "tool_results": [],
            "iteration": 0,
            "max_iterations": self.max_iterations,
            "final_answer": None,
            "error": None,
            "metadata": config or {},
        }

        # Build and execute graph
        graph = self.build_graph()

        # Execute with config (for thread_id if checkpointing)
        exec_config = {"configurable": config} if config else None
        final_state = await graph.ainvoke(initial_state, config=exec_config)

        return final_state

    async def stream_execute(
        self,
        messages: List[Dict[str, Any]],
        config: Optional[Dict[str, Any]] = None,
    ):
        """Stream agent workflow execution.

        Args:
            messages: Initial conversation messages
            config: Optional configuration (thread_id for checkpointing)

        Yields:
            State updates as they occur
        """
        # Convert messages to LangChain format
        lc_messages = []
        for msg in messages:
            role = msg["role"]
            content = msg.get("content", "")

            if role == "system":
                lc_messages.append(SystemMessage(content=content))
            elif role == "user":
                lc_messages.append(HumanMessage(content=content))
            elif role == "assistant":
                lc_messages.append(AIMessage(content=content))

        # Initialize state
        initial_state: AgentState = {
            "messages": lc_messages,
            "tool_results": [],
            "iteration": 0,
            "max_iterations": self.max_iterations,
            "final_answer": None,
            "error": None,
            "metadata": config or {},
        }

        # Build graph
        graph = self.build_graph()

        # Stream execution
        exec_config = {"configurable": config} if config else None
        async for event in graph.astream(initial_state, config=exec_config):
            yield event
