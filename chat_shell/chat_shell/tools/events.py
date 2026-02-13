# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tool event handling for Chat Service.

This module provides handlers for tool start/end events during streaming,
emitting tool events directly to the client.
"""

import json
import logging
import time
from typing import Any, Callable

from chat_shell.services.streaming.core import should_display_tool_details
from shared.telemetry.decorators import add_span_event

logger = logging.getLogger(__name__)


def create_tool_event_handler(
    state: Any,
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
        """Handle tool events and emit tool data directly."""
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
    state: Any,
    emitter: Any,
    agent_builder: Any,
    tool_name: str,
    run_id: str,
    event_data: dict,
) -> None:
    """Handle tool start event."""
    logger.info(
        "[TOOL_START] _handle_tool_start called: tool_name=%s, run_id=%s",
        tool_name,
        run_id,
    )
    # Extract tool input for better display
    tool_input = event_data.get("data", {}).get("input", {})

    # Convert input to JSON-serializable format
    serializable_input = _make_serializable(tool_input)

    # Generate tool_use_id (prefer from event, fallback to run_id + timestamp)
    tool_use_id = event_data.get("tool_use_id")
    if not tool_use_id:
        # Fallback: generate unique ID from run_id + timestamp
        tool_use_id = f"{run_id}-{int(time.time() * 1000)}"

    # Store tool_use_id mapping for tool_end to use the same ID
    if not hasattr(state, "_tool_use_id_map"):
        state._tool_use_id_map = {}
    state._tool_use_id_map[run_id] = tool_use_id

    # Add OpenTelemetry span event for tool start
    add_span_event(
        f"tool_start:{tool_name}",
        attributes={
            "tool.name": tool_name,
            "tool.run_id": run_id,
            "tool.tool_use_id": tool_use_id,
            "tool.input": str(serializable_input)[:1000],
        },
    )

    logger.info(
        f"[TOOL_START] {tool_name} (run_id={run_id}, tool_use_id={tool_use_id})"
    )

    # Build friendly title and extract display_name
    title = _build_tool_start_title(agent_builder, tool_name, serializable_input)

    # Extract display_name from tool instance
    tool_instance = _get_tool_instance(agent_builder, tool_name)
    display_name = (
        getattr(tool_instance, "display_name", None) if tool_instance else None
    )

    # Build tool_use event data
    tool_event = {
        "type": "tool_use",
        "tool_name": tool_name,
        "tool_use_id": tool_use_id,
        "run_id": run_id,
        "title": title,
        "status": "started",
    }

    # Add display_name if available
    if display_name:
        tool_event["display_name"] = display_name

    # Only include input if tool is in whitelist
    if should_display_tool_details(tool_name):
        tool_event["input"] = serializable_input

    # Emit tool event directly
    chunk_data = {
        "type": "chunk",
        "content": "",
        "offset": state.offset,
        "subtask_id": state.subtask_id,
        "tool_event": tool_event,
    }
    emitter.emit_json(chunk_data)


def _handle_tool_end(
    state: Any,
    emitter: Any,
    agent_builder: Any,
    tool_name: str,
    run_id: str,
    event_data: dict,
) -> None:
    """Handle tool end event."""
    # Extract and serialize tool output
    tool_output = event_data.get("data", {}).get("output", "")

    serializable_output = _make_output_serializable(tool_output)

    # Extract tool input from event_data for load_skill tracking
    raw_tool_input = event_data.get("data", {}).get("input", {})
    tool_input = _make_serializable(raw_tool_input) if raw_tool_input else {}

    # Get tool_use_id from event, or from saved mapping, or generate new one
    tool_use_id = event_data.get("tool_use_id")
    if not tool_use_id:
        # Try to get from saved mapping (set by tool_start)
        tool_use_id_map = getattr(state, "_tool_use_id_map", {})
        tool_use_id = tool_use_id_map.get(run_id)
        if tool_use_id:
            logger.info(
                "[TOOL_END] Using saved tool_use_id from tool_start: %s",
                tool_use_id,
            )
            # Clean up the mapping
            del tool_use_id_map[run_id]
        else:
            tool_use_id = f"{run_id}-{int(time.time() * 1000)}"
            logger.warning(
                "[TOOL_END] No tool_use_id from event or mapping, generated: %s",
                tool_use_id,
            )

    # Add OpenTelemetry span event for tool end
    output_str = str(serializable_output)
    add_span_event(
        f"tool_end:{tool_name}",
        attributes={
            "tool.name": tool_name,
            "tool.run_id": run_id,
            "tool.tool_use_id": tool_use_id,
            "tool.output_length": len(output_str),
            "tool.output": output_str[:1000],
            "tool.status": "completed",
        },
    )

    logger.info(f"[TOOL_END] {tool_name} (run_id={run_id}, tool_use_id={tool_use_id})")

    # Check for MCP silent_exit marker in tool output
    _check_silent_exit_marker(state, tool_name, serializable_output)

    # Process tool output and extract metadata
    title, sources = _process_tool_output(tool_name, serializable_output)

    # Detect success/failure status from tool output
    status = "completed"
    error_msg = None
    if isinstance(serializable_output, str):
        try:
            parsed_output = json.loads(serializable_output)
            if isinstance(parsed_output, dict):
                # Check for explicit success field
                if parsed_output.get("success") is False:
                    status = "failed"
                    error_msg = parsed_output.get("error", "Task failed")
                    title = (
                        f"Failed: {error_msg[:50]}..."
                        if len(str(error_msg)) > 50
                        else f"Failed: {error_msg}"
                    )
                elif parsed_output.get("success") is True:
                    status = "completed"
        except json.JSONDecodeError:
            pass

    # Add sources to state
    if sources:
        state.add_sources(sources)

    # Try to get better title from display_name
    if status == "completed" and title == f"Tool completed: {tool_name}":
        title = _build_tool_end_title(agent_builder, tool_name, tool_input)

    # Build tool_result event data
    tool_event = {
        "type": "tool_result",
        "tool_name": tool_name,
        "tool_use_id": tool_use_id,
        "run_id": run_id,
        "title": title,
        "status": status,
    }

    # Only include output if tool is in whitelist
    if should_display_tool_details(tool_name):
        tool_event["output"] = serializable_output
        tool_event["content"] = serializable_output

    # Add error field if failed
    if status == "failed" and error_msg:
        tool_event["error"] = error_msg

    # Track loaded skills for persistence across conversation turns
    if tool_name == "load_skill" and status == "completed":
        skill_name = (
            tool_input.get("skill_name") if isinstance(tool_input, dict) else None
        )

        logger.info(
            "[TOOL_END] load_skill completed: skill_name=%s, tool_input=%s",
            skill_name,
            tool_input,
        )

        # Add to loaded_skills if we found the skill name
        if skill_name and hasattr(state, "add_loaded_skill"):
            state.add_loaded_skill(skill_name)
            logger.info(
                "[TOOL_END] Tracked loaded skill: %s for persistence",
                skill_name,
            )
        else:
            logger.warning(
                "[TOOL_END] Could not track loaded skill: skill_name=%s",
                skill_name,
            )

    # Emit tool event directly
    chunk_data = {
        "type": "chunk",
        "content": "",
        "offset": state.offset,
        "subtask_id": state.subtask_id,
        "tool_event": tool_event,
    }
    emitter.emit_json(chunk_data)


def _get_tool_instance(agent_builder: Any, tool_name: str) -> Any:
    """Get tool instance from agent builder.

    Args:
        agent_builder: Agent builder with tool registry
        tool_name: Name of the tool

    Returns:
        Tool instance or None
    """
    tool_instance = None

    # First try tool_registry
    if agent_builder.tool_registry:
        tool_instance = agent_builder.tool_registry.get(tool_name)

    # If not found, search in agent_builder.all_tools (includes skill tools)
    if not tool_instance and hasattr(agent_builder, "all_tools"):
        for tool in agent_builder.all_tools:
            if tool.name == tool_name:
                tool_instance = tool
                break

    return tool_instance


def _process_tool_output(
    tool_name: str, tool_output: Any
) -> tuple[str, list[dict[str, Any]]]:
    """Process tool output and extract sources.

    Args:
        tool_name: Name of the tool
        tool_output: Output from the tool

    Returns:
        Tuple of (title, sources)
    """
    title = f"Tool completed: {tool_name}"
    sources: list[dict[str, Any]] = []

    # Extract sources from knowledge_base_search results
    if tool_name == "knowledge_base_search":
        if isinstance(tool_output, str):
            try:
                parsed = json.loads(tool_output)
                logger.info(
                    f"[TOOL_OUTPUT] knowledge_base_search parsed output: "
                    f"has_sources={'sources' in parsed}, "
                    f"sources_count={len(parsed.get('sources', []))}, "
                    f"sources={parsed.get('sources', [])}"
                )
                if isinstance(parsed, dict) and "sources" in parsed:
                    kb_sources = parsed.get("sources", [])
                    if isinstance(kb_sources, list):
                        sources.extend(kb_sources)
                        logger.info(
                            f"[TOOL_OUTPUT] Extracted {len(kb_sources)} sources from knowledge_base_search"
                        )
                    result_count = parsed.get("count", 0)
                    title = f"检索完成，找到 {result_count} 条结果"
            except json.JSONDecodeError as e:
                logger.warning(f"[TOOL_OUTPUT] Failed to parse tool output: {e}")

    # Extract sources from web_search results
    elif tool_name == "web_search":
        if isinstance(tool_output, str):
            # Try to extract URLs from the output
            import re

            urls = re.findall(r'https?://[^\s<>"{}|\\^`\[\]]+', tool_output)
            for url in urls[:5]:  # Limit to 5 sources
                sources.append({"type": "url", "url": url})
            title = f"搜索完成，找到 {len(urls)} 个结果"

    return title, sources


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
    tool_instance = _get_tool_instance(agent_builder, tool_name)

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
    tool_input: dict,
) -> str:
    """Build friendly title for tool end event."""
    tool_instance = _get_tool_instance(agent_builder, tool_name)

    display_name = (
        getattr(tool_instance, "display_name", None) if tool_instance else None
    )

    if not display_name:
        return f"Tool completed: {tool_name}"

    # Remove "正在" prefix for cleaner display
    if display_name.startswith("正在"):
        base_title = display_name[2:]
    else:
        base_title = display_name

    # For load_skill, append the skill's friendly display name
    if tool_name == "load_skill" and tool_instance:
        skill_name_param = (
            tool_input.get("skill_name", "") if isinstance(tool_input, dict) else ""
        )
        if skill_name_param and hasattr(tool_instance, "get_skill_display_name"):
            skill_display = tool_instance.get_skill_display_name(skill_name_param)
            return f"{base_title}：{skill_display}"

    return base_title


def _check_silent_exit_marker(state: Any, tool_name: str, tool_output: Any) -> None:
    """Check for MCP silent_exit marker in tool output.

    This detects the "__silent_exit__" marker from MCP tools and sets the
    silent exit state accordingly.

    Args:
        state: Streaming state to update
        tool_name: Name of the tool
        tool_output: Output from the tool
    """
    if not isinstance(tool_output, str):
        return

    try:
        parsed = json.loads(tool_output)
        if isinstance(parsed, dict) and parsed.get("__silent_exit__") is True:
            reason = parsed.get("reason", "")
            logger.info(
                "[TOOL_EVENT] MCP silent_exit detected: tool=%s, reason=%s",
                tool_name,
                reason,
            )
            # Mark state as silent exit
            state.is_silent_exit = True
            state.silent_exit_reason = reason
            add_span_event(
                "mcp_silent_exit_detected",
                attributes={
                    "tool.name": tool_name,
                    "silent_exit.reason": reason,
                },
            )
    except json.JSONDecodeError:
        pass
