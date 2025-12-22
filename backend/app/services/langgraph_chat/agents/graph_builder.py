"""LangGraph graph builder for agent workflows."""

from typing import Any

from langchain_core.language_models import BaseChatModel
from langchain_core.messages import AIMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools.base import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.graph import END, StateGraph

from ..tools.base import ToolRegistry
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

        # Get all LangChain tools from registry
        self.langchain_tools: list[BaseTool] = self.tool_registry.get_all()

        # Bind tools to LLM
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
        messages = state["messages"]

        # Call LLM with tools
        response = await self.llm_with_tools.ainvoke(messages)

        # Update state
        return {
            **state,
            "messages": [response],  # add_messages will append automatically
        }

    async def invoke_tools(self, state: AgentState) -> AgentState:
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
                    result = await self.tool_registry.invoke_tool(
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
            return workflow.compile(checkpointer=memory)
        else:
            return workflow.compile()

    async def execute(
        self,
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
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
        messages: list[dict[str, Any]],
        config: dict[str, Any] | None = None,
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
