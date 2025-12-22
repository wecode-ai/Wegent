# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Agent state definitions for LangGraph."""

import asyncio
from typing import Annotated, Any

from langchain_core.messages import BaseMessage
from langgraph.graph import add_messages
from typing_extensions import TypedDict


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
        cancel_event: Optional asyncio.Event for cancellation
        accumulated_content: Accumulated streaming content for persistence
    """

    # Messages with automatic aggregation via add_messages reducer
    messages: Annotated[list[BaseMessage], add_messages]

    # Tool execution tracking
    tool_results: list[dict[str, Any]]

    # Iteration control
    iteration: int
    max_iterations: int

    # Execution results
    final_answer: str | None
    error: str | None

    # Context metadata
    metadata: dict[str, Any]

    # Streaming support
    cancel_event: asyncio.Event | None
    accumulated_content: str
