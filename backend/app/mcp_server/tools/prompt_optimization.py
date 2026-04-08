# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""MCP tools for prompt optimization.

This module provides MCP tools for:
- Getting assembled team prompts with source mapping
- Submitting prompt changes to the frontend for user review

The submit_prompt_changes tool sends an interactive block to the frontend
for the user to review and apply changes. The actual optimization logic
is performed by the AI agent, guided by SKILL.md instructions.
"""

import logging
from typing import Any, Dict, List, Optional

from app.db.session import SessionLocal
from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools.decorator import mcp_tool
from app.services.prompt_optimization import (
    assemble_team_prompt,
    resolve_team_from_task,
)

logger = logging.getLogger(__name__)


async def _send_block_to_frontend(
    task_id: int,
    subtask_id: int,
    tool_name_match: str,
    block_data: Dict[str, Any],
) -> None:
    """Send a block to the frontend via WebSocket.

    Finds the matching tool block in session_manager and updates it
    with the provided block data.

    Args:
        task_id: Task ID
        subtask_id: Subtask ID
        tool_name_match: Substring to match in tool_name
        block_data: Block data to send
    """
    try:
        from app.services.chat.storage.session import session_manager
        from app.services.chat.webpage_ws_chat_emitter import get_webpage_ws_emitter
        from shared.models.blocks import BlockStatus

        blocks = await session_manager.get_blocks(subtask_id)
        tool_use_id = None
        for block in reversed(blocks):
            tool_name = block.get("tool_name", "")
            if block.get("type") == "tool" and tool_name_match in tool_name:
                tool_use_id = block.get("tool_use_id")
                break

        if not tool_use_id:
            logger.warning(
                "[PromptOptimization] No '%s' tool block found for subtask %d",
                tool_name_match,
                subtask_id,
            )
            return

        await session_manager.update_tool_block_status(
            subtask_id=subtask_id,
            tool_use_id=tool_use_id,
            tool_input=block_data,
        )

        ws_emitter = get_webpage_ws_emitter()
        if not ws_emitter:
            logger.warning("[PromptOptimization] WebSocket emitter not available")
            return

        await ws_emitter.emit_block_updated(
            task_id=task_id,
            subtask_id=subtask_id,
            block_id=tool_use_id,
            tool_input=block_data,
            status=BlockStatus.PENDING.value,
        )
        logger.info(
            "[PromptOptimization] Block sent: task_id=%d, subtask_id=%d",
            task_id,
            subtask_id,
        )
    except Exception as e:
        logger.error(
            "[PromptOptimization] Failed to send block: %s",
            e,
            exc_info=True,
        )


@mcp_tool(
    name="get_team_prompt",
    description="Get the assembled system prompt for the current task's team with source mapping. Returns each prompt source (Ghost systemPrompt or TeamMember prompt) with its name and content.",
    server="prompt_optimization",
)
async def get_team_prompt(
    token_info: TaskTokenInfo,
) -> Dict[str, Any]:
    """
    Get the assembled system prompt for the current task's team.

    Automatically resolves the team from the current task context.
    Returns the complete assembled prompt and a breakdown of sources
    (Ghost.systemPrompt and TeamMember.prompt components).
    """
    db = SessionLocal()
    try:
        team = resolve_team_from_task(db, token_info.task_id, token_info.user_id)
        assembled, sources = assemble_team_prompt(db, team.id, token_info.user_id)

        return {
            "team_id": team.id,
            "assembled_prompt": assembled,
            "sources": [s.model_dump() for s in sources],
        }
    except Exception as e:
        logger.error("[PromptOptimization] get_team_prompt failed: %s", e)
        return {
            "error": str(e),
            "assembled_prompt": "",
            "sources": [],
        }
    finally:
        db.close()


@mcp_tool(
    name="submit_prompt_changes",
    description=(
        "Submit optimized prompt changes to the frontend for user review. "
        "Displays interactive cards showing original vs modified prompt for each change. "
        "The user can then apply or cancel each change independently. "
        "Call get_team_prompt() first to get the current prompts and source mapping, "
        "then rewrite the prompts yourself, and call this tool with the changes."
    ),
    server="prompt_optimization",
    param_descriptions={
        "changes": (
            "List of prompt changes. Each change must include: "
            "type ('ghost' or 'member'), id (resource ID from source mapping), "
            "name (display name), field (e.g. 'systemPrompt'), "
            "original (current prompt text), suggested (new prompt text). "
            "For member type, also include index (member index in team)."
        ),
    },
)
async def submit_prompt_changes(
    token_info: TaskTokenInfo,
    changes: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Submit prompt changes to the frontend for user review.

    This tool does NOT perform optimization. It only delivers the changes
    (prepared by the AI agent) to the frontend as interactive cards.

    Each change is rendered as a separate card showing original vs modified text.
    The user can apply or cancel each change independently.
    """
    db = SessionLocal()
    try:
        team = resolve_team_from_task(db, token_info.task_id, token_info.user_id)
        team_id = team.id

        if not changes:
            return {"error": "No changes provided"}

        # Build apply_action payload for each change
        apply_changes = []
        for change in changes:
            apply_change: Dict[str, Any] = {
                "type": change["type"],
                "value": change["suggested"],
            }
            if change["type"] == "ghost":
                apply_change["id"] = change["id"]
                apply_change["field"] = change.get("field", "systemPrompt")
            elif change["type"] == "member":
                apply_change["team_id"] = team_id
                apply_change["index"] = change.get("index", 0)
            apply_changes.append(apply_change)

        block_data = {
            "type": "prompt_optimization",
            "ask_id": f"po_{token_info.subtask_id}",
            "task_id": token_info.task_id,
            "subtask_id": token_info.subtask_id,
            "team_id": team_id,
            "changes": changes,
            "apply_action": {
                "endpoint": "/api/prompt-optimization/apply",
                "method": "POST",
                "payload": {"team_id": team_id, "changes": apply_changes},
            },
        }

        await _send_block_to_frontend(
            task_id=token_info.task_id,
            subtask_id=token_info.subtask_id,
            tool_name_match="submit_prompt_changes",
            block_data=block_data,
        )

        return {
            "__silent_exit__": True,
            "reason": "Prompt changes sent to frontend. Waiting for user to review and apply.",
        }

    except Exception as e:
        logger.error(
            "[PromptOptimization] submit_prompt_changes failed: %s",
            e,
            exc_info=True,
        )
        return {
            "error": str(e),
            "__silent_exit__": True,
        }
    finally:
        db.close()
