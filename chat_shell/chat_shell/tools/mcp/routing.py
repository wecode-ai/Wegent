# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Keep failed optional MCP calls out of the ReAct termination route."""

from typing import Any

from langchain_core.messages import ToolMessage
from langchain_core.tools import BaseTool
from langgraph.graph import END
from langgraph.graph.state import CompiledStateGraph


def configure_mcp_result_routing(
    agent: CompiledStateGraph, tools: list[BaseTool]
) -> CompiledStateGraph:
    """Preserve successful direct returns while continuing after MCP failures."""
    direct_tools = {tool.name: tool for tool in tools if tool.return_direct}
    if not any(
        getattr(tool, "_wegent_tool_protocol", None) == "mcp_call"
        for tool in direct_tools.values()
    ):
        return agent

    # The prebuilt ReAct route treats every direct tool result as terminal,
    # including errors. Recompile its graph with the capability-aware route.
    workflow = agent.builder
    workflow.branches["tools"].pop("route_tool_responses")
    entrypoint = "pre_model_hook" if "pre_model_hook" in workflow.nodes else "agent"

    def route_mcp_results(state: dict[str, Any]) -> str:
        for message in reversed(state["messages"]):
            if not isinstance(message, ToolMessage):
                break
            tool = direct_tools.get(message.name)
            if tool is None:
                continue
            if getattr(tool, "_wegent_tool_protocol", None) != "mcp_call":
                return END
            unavailable = getattr(tool, "_wegent_mcp_unavailable", None)
            if message.status != "error" and not (unavailable and unavailable.is_set()):
                return END
        return entrypoint

    workflow.add_conditional_edges(
        "tools", route_mcp_results, path_map=[entrypoint, END]
    )
    return workflow.compile(checkpointer=agent.checkpointer)
