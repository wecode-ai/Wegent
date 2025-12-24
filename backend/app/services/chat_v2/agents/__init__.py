# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""LangGraph agents module.

This module provides the LangGraph-based agent implementation using
the prebuilt create_react_agent for ReAct workflow.

Note: State management is handled internally by LangGraph's prebuilt agent.
If you need to access AgentState, import directly from langgraph:
    from langgraph.prebuilt.chat_agent_executor import AgentState
"""

from .graph_builder import LangGraphAgentBuilder

__all__ = ["LangGraphAgentBuilder"]
