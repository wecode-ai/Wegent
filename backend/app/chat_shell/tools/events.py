# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tool event handling for Chat Service.

This module provides handlers for tool start/end events during streaming,
including thinking step generation and event emission.
"""

import asyncio
import logging
from typing import Any, Callable

from app.services.streaming import StreamingState

logger = logging.getLogger(__name__)


def create_tool_event_handler(
    state: StreamingState,
    emitter: Any,
    agent_builder: Any,
) -> Callable[[str, dict], None]:
    """Create a tool event handler function.

    Args:
        state: Streaming state to update
        emitter: Stream emitter for events
        agent_builder: Agent builder for tool registry access

    Returns:
        Tool event handler function
    """

    def handle_tool_event(kind: str, event_data: dict):
        """Handle tool events and add thinking steps."""
        tool_name = event_data.get("name", "unknown")
        run_id = event_data.get("run_id", "")

        if kind == "tool_start":
            _handle_tool_start(
                state, emitter, agent_builder, tool_name, run_id, event_data
            )
        elif kind == "tool_end":
            _handle_tool_end(
                state, emitter, agent_builder, tool_name, run_id, event_data
            )

    return handle_tool_event


def _handle_tool_start(
    state: StreamingState,
    emitter: Any,
    agent_builder: Any,
    tool_name: str,
    run_id: str,
    event_data: dict,
) -> None:
    """Handle tool start event."""
    # Extract tool input for better display
    tool_input = event_data.get("data", {}).get("input", {})

    # Convert input to JSON-serializable format
    serializable_input = _make_serializable(tool_input)

    # Build friendly title
    title = _build_tool_start_title(agent_builder, tool_name, serializable_input)

    state.add_thinking_step(
        {
            "title": title,
            "next_action": "continue",
            "run_id": run_id,
            "details": {
                "type": "tool_use",
                "tool_name": tool_name,
                "name": tool_name,
                "status": "started",
                "input": serializable_input,
            },
        }
    )

    asyncio.create_task(
        emitter.emit_chunk(
            content="",
            offset=state.offset,
            subtask_id=state.subtask_id,
            result=state.get_current_result(include_value=False, slim_thinking=True),
        )
    )


def _handle_tool_end(
    state: StreamingState,
    emitter: Any,
    agent_builder: Any,
    tool_name: str,
    run_id: str,
    event_data: dict,
) -> None:
    """Handle tool end event."""
    from app.chat_shell.agent import ChatAgent

    # Extract and serialize tool output
    tool_output = event_data.get("data", {}).get("output", "")
    serializable_output = _make_output_serializable(tool_output)

    # Process tool output and extract metadata
    title, sources = ChatAgent.process_tool_output(tool_name, serializable_output)

    # Add sources to state
    if sources:
        state.add_sources(sources)

    # Try to get better title from display_name
    if title == f"Tool completed: {tool_name}":
        title = _build_tool_end_title(agent_builder, tool_name, run_id, state, title)

    # Find matching start step and insert result after it
    matching_start_idx = None
    for idx, step in enumerate(state.thinking):
        if (
            step.get("run_id") == run_id
            and step.get("details", {}).get("status") == "started"
        ):
            matching_start_idx = idx
            break

    result_step = {
        "title": title,
        "next_action": "continue",
        "run_id": run_id,
        "details": {
            "type": "tool_result",
            "tool_name": tool_name,
            "status": "completed",
            "output": serializable_output,
            "content": serializable_output,
        },
    }

    if matching_start_idx is not None:
        state.thinking.insert(matching_start_idx + 1, result_step)
    else:
        state.add_thinking_step(result_step)

    # Immediately emit thinking step (exclude value to reduce data size)
    asyncio.create_task(
        emitter.emit_chunk(
            content="",
            offset=state.offset,
            subtask_id=state.subtask_id,
            result=state.get_current_result(include_value=False, slim_thinking=True),
        )
    )


def _make_serializable(value: Any) -> Any:
    """Convert value to JSON-serializable format."""
    if isinstance(value, dict):
        result = {}
        for key, val in value.items():
            if isinstance(val, (str, dict, list, int, float, bool, type(None))):
                result[key] = val
            else:
                result[key] = str(val)
        return result
    elif isinstance(value, (str, list, int, float, bool, type(None))):
        return value
    else:
        return str(value)


def _make_output_serializable(tool_output: Any) -> Any:
    """Convert tool output to JSON-serializable format."""
    if hasattr(tool_output, "content"):
        return tool_output.content
    elif not isinstance(tool_output, (str, dict, list, int, float, bool, type(None))):
        return str(tool_output)
    return tool_output


def _build_tool_start_title(
    agent_builder: Any,
    tool_name: str,
    serializable_input: Any,
) -> str:
    """Build friendly title for tool start event."""
    tool_instance = None
    if agent_builder.tool_registry:
        tool_instance = agent_builder.tool_registry.get(tool_name)

    display_name = (
        getattr(tool_instance, "display_name", None) if tool_instance else None
    )

    if display_name:
        title = display_name
        # For load_skill, append the skill's friendly display name
        if tool_name == "load_skill" and tool_instance:
            skill_name_param = (
                serializable_input.get("skill_name", "")
                if isinstance(serializable_input, dict)
                else ""
            )
            if skill_name_param:
                skill_display = skill_name_param
                if hasattr(tool_instance, "get_skill_display_name"):
                    try:
                        skill_display = tool_instance.get_skill_display_name(
                            skill_name_param
                        )
                    except Exception:
                        pass
                title = f"{display_name}：{skill_display}"
    elif tool_name == "web_search":
        query = (
            serializable_input if isinstance(serializable_input, dict) else {}
        ).get("query", "")
        title = f"正在搜索: {query}" if query else "正在进行网页搜索"
    else:
        title = f"正在使用工具: {tool_name}"

    return title


def _build_tool_end_title(
    agent_builder: Any,
    tool_name: str,
    run_id: str,
    state: StreamingState,
    default_title: str,
) -> str:
    """Build friendly title for tool end event."""
    tool_instance = None
    if agent_builder.tool_registry:
        tool_instance = agent_builder.tool_registry.get(tool_name)

    display_name = (
        getattr(tool_instance, "display_name", None) if tool_instance else None
    )

    if not display_name:
        return default_title

    # Remove "正在" prefix for cleaner display
    if display_name.startswith("正在"):
        base_title = display_name[2:]
    else:
        base_title = display_name

    # For load_skill, append the skill's friendly display name
    if tool_name == "load_skill" and tool_instance:
        # Find the matching tool_start step to get the skill_name
        for step in state.thinking:
            if (
                step.get("run_id") == run_id
                and step.get("details", {}).get("status") == "started"
            ):
                start_input = step.get("details", {}).get("input", {})
                if isinstance(start_input, dict):
                    skill_name_param = start_input.get("skill_name", "")
                    if skill_name_param and hasattr(
                        tool_instance, "get_skill_display_name"
                    ):
                        skill_display = tool_instance.get_skill_display_name(
                            skill_name_param
                        )
                        return f"{base_title}：{skill_display}"
                break

    return base_title
