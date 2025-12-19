"""Agent state definitions for LangGraph."""

from typing import Annotated, List, Dict, Any, Optional
from typing_extensions import TypedDict
from langgraph.graph import add_messages
from langchain_core.messages import BaseMessage


class AgentState(TypedDict):
    """State for LangGraph agent execution.

    Attributes:
        messages: Conversation history with automatic message aggregation
        tool_results: Results from tool executions
        iteration: Current iteration count for tool loops
        max_iterations: Maximum allowed iterations
        final_answer: Final response from agent
        error: Error message if execution failed
        metadata: Additional metadata for execution context
    """
    # Messages with automatic aggregation via add_messages reducer
    messages: Annotated[List[BaseMessage], add_messages]

    # Tool execution tracking
    tool_results: List[Dict[str, Any]]

    # Iteration control
    iteration: int
    max_iterations: int

    # Execution results
    final_answer: Optional[str]
    error: Optional[str]

    # Context metadata
    metadata: Dict[str, Any]
