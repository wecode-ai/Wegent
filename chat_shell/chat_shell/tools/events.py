# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tool event handling for Chat Service.

This module provides handlers for tool start/end events during streaming,
emitting tool events via unified ResponsesAPIEmitter.
"""

import asyncio
import json
import logging
import time
from typing import Any, Callable

from chat_shell.services.streaming.core import should_display_tool_details
from shared.models import ResponsesAPIEmitter
from shared.telemetry.decorators import add_span_event

logger = logging.getLogger(__name__)


def create_tool_event_handler(
    state: Any,
    emitter: ResponsesAPIEmitter,
    agent_builder: Any,
) -> Callable[[str, dict], None]:
    """Create a tool event handler function.

    Args:
        state: Streaming state to update
        emitter: ResponsesAPIEmitter for events
        agent_builder: Agent builder for tool registry access

    Returns:
        Tool event handler function
    """

    def handle_tool_event(kind: str, event_data: dict):
        """Handle tool events and emit tool data via ResponsesAPIEmitter."""
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


def _run_async(coro):
    """Run async coroutine from sync context."""
    try:
        loop = asyncio.get_running_loop()
        # We're in an async context, create a task
        loop.create_task(coro)
    except RuntimeError:
        # No running event loop, run directly
        asyncio.run(coro)


def _handle_tool_start(
    state: Any,
    emitter: ResponsesAPIEmitter,
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

    # Extract display_name from tool instance for frontend display
    tool_instance = _get_tool_instance(agent_builder, tool_name)
    display_name = (
        getattr(tool_instance, "display_name", None) if tool_instance else None
    )

    # Emit tool_start event via ResponsesAPIEmitter
    # Only include arguments if tool is in whitelist
    arguments = serializable_input if should_display_tool_details(tool_name) else None

    _run_async(
        emitter.tool_start(
            call_id=tool_use_id,
            name=tool_name,
            arguments=arguments,
            display_name=display_name,
        )
    )


def _handle_tool_end(
    state: Any,
    emitter: ResponsesAPIEmitter,
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

    # Process tool output and extract sources for knowledge base citations
    sources = _extract_sources(tool_name, serializable_output)
    if sources:
        state.add_sources(sources)

    # Track loaded skills for persistence across conversation turns
    if tool_name == "load_skill":
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

    # Emit tool_done event via ResponsesAPIEmitter
    # Only include arguments if tool is in whitelist
    arguments = tool_input if should_display_tool_details(tool_name) else None

    _run_async(
        emitter.tool_done(
            call_id=tool_use_id,
            name=tool_name,
            arguments=arguments,
        )
    )


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


def _extract_sources(tool_name: str, tool_output: Any) -> list[dict[str, Any]]:
    """Extract sources from tool output for knowledge base citations.

    Args:
        tool_name: Name of the tool
        tool_output: Output from the tool

    Returns:
        List of source dictionaries
    """
    sources: list[dict[str, Any]] = []

    # Extract sources from knowledge_base_search results
    if tool_name == "knowledge_base_search":
        if isinstance(tool_output, str):
            try:
                parsed = json.loads(tool_output)
                logger.info(
                    f"[TOOL_OUTPUT] knowledge_base_search parsed output: "
                    f"has_sources={'sources' in parsed}, "
                    f"sources_count={len(parsed.get('sources', []))}"
                )
                if isinstance(parsed, dict) and "sources" in parsed:
                    kb_sources = parsed.get("sources", [])
                    if isinstance(kb_sources, list):
                        sources.extend(kb_sources)
                        logger.info(
                            f"[TOOL_OUTPUT] Extracted {len(kb_sources)} sources from knowledge_base_search"
                        )
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

    return sources


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
