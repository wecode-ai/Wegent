# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Helper functions for OpenAPI v1/responses endpoint.
Contains utility functions for status conversion, parsing, and validation.
"""

from typing import Any, Dict, List, Optional, Union

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.schemas.kind import Bot, Shell, Team
from app.schemas.openapi_response import (
    InputItem,
    WegentTool,
)
from app.services.readers.kinds import KindType, kindReader


def wegent_status_to_openai_status(wegent_status: str) -> str:
    """Convert Wegent task status to OpenAI response status."""
    status_mapping = {
        "PENDING": "queued",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "failed",
        "CANCELLED": "cancelled",
        "CANCELLING": "in_progress",
        "DELETE": "failed",
    }
    return status_mapping.get(wegent_status, "incomplete")


def subtask_status_to_message_status(subtask_status: str) -> str:
    """Convert subtask status to output message status."""
    status_mapping = {
        "PENDING": "in_progress",
        "RUNNING": "in_progress",
        "COMPLETED": "completed",
        "FAILED": "incomplete",
        "CANCELLED": "incomplete",
    }
    return status_mapping.get(subtask_status, "incomplete")


def parse_model_string(model: str) -> Dict[str, Any]:
    """
    Parse model string to extract team namespace, team name, and optional model id.
    Format: namespace#team_name or namespace#team_name#model_id
    """
    parts = model.split("#")
    if len(parts) < 2:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid model format: '{model}'. Expected format: 'namespace#team_name' or 'namespace#team_name#model_id'",
        )

    result = {
        "namespace": parts[0],
        "team_name": parts[1],
        "model_id": parts[2] if len(parts) > 2 else None,
    }
    return result


def parse_wegent_tools(tools: Optional[List[WegentTool]]) -> Dict[str, Any]:
    """
    Parse Wegent custom tools from request.

    Args:
        tools: List of WegentTool objects

    Returns:
        Dict with parsed tool settings:
        - enable_chat_bot: bool (enables all server-side capabilities)
        - mcp_servers: dict (custom MCP server configurations, format: {name: config})
        - preload_skills: list (skills to preload for the bot)
    """
    result: Dict[str, Any] = {
        "enable_chat_bot": False,
        "mcp_servers": {},
        "preload_skills": [],
    }
    if tools:
        for tool in tools:
            if tool.type == "wegent_chat_bot":
                result["enable_chat_bot"] = True
            elif tool.type == "mcp" and tool.mcp_servers:
                # mcp_servers is List[Dict[str, Any]]
                # Each dict maps server_name -> config
                for servers_dict in tool.mcp_servers:
                    for name, config in servers_dict.items():
                        # Skip disabled servers
                        if isinstance(config, dict) and config.get("disabled"):
                            continue
                        if isinstance(config, dict):
                            result["mcp_servers"][name] = {
                                "url": config.get("url"),
                                "type": config.get("type"),
                                "headers": config.get("headers"),
                                "command": config.get("command"),
                                "args": config.get("args"),
                            }
            elif tool.type == "skill" and tool.preload_skills:
                # Add skills to preload_skills list
                result["preload_skills"].extend(tool.preload_skills)
    return result


def extract_input_text(input_data: Union[str, List[InputItem]]) -> str:
    """
    Extract the user input text from the input field.

    Args:
        input_data: Either a string or list of InputItem

    Returns:
        The user's input text
    """
    if isinstance(input_data, str):
        return input_data

    # For list input, get the last user message
    for item in reversed(input_data):
        if isinstance(item, InputItem) and item.role == "user":
            # content can be str or List[InputTextContent]
            if isinstance(item.content, str):
                return item.content
            elif isinstance(item.content, list):
                # Extract text from InputTextContent list
                texts = []
                for content_item in item.content:
                    if hasattr(content_item, "text"):
                        texts.append(content_item.text)
                    elif isinstance(content_item, dict) and "text" in content_item:
                        texts.append(content_item["text"])
                return " ".join(texts)
        elif isinstance(item, dict) and item.get("role") == "user":
            content = item.get("content", "")
            if isinstance(content, str):
                return content
            elif isinstance(content, list):
                # Extract text from content list
                texts = []
                for content_item in content:
                    if isinstance(content_item, dict) and "text" in content_item:
                        texts.append(content_item["text"])
                return " ".join(texts)

    # If no user message found, return empty string
    return ""


# Shell types that support direct chat (bypass executor)
DIRECT_CHAT_SHELL_TYPES = ["Chat"]


def is_direct_chat_shell(shell_type: str) -> bool:
    """
    Check if the shell type supports direct chat.

    Args:
        shell_type: The shell type to check

    Returns:
        bool: True if the shell type supports direct chat
    """
    return shell_type in DIRECT_CHAT_SHELL_TYPES


def check_team_supports_direct_chat(db: Session, team: Kind, user_id: int) -> bool:
    """
    Check if the team supports direct chat mode.

    Returns True only if ALL bots in the team use Chat Shell type.
    This is a simplified version of the check from chat.py.

    Args:
        db: Database session
        team: Team Kind object
        user_id: User ID for lookup

    Returns:
        True if team supports direct chat
    """
    import logging

    logger = logging.getLogger(__name__)
    team_crd = Team.model_validate(team.json)
    logger.info(
        f"[OPENAPI_HELPERS] check_team_supports_direct_chat: team={team.namespace}/{team.name}, user_id={user_id}, team.user_id={team.user_id}"
    )

    for member in team_crd.spec.members:
        # Find bot using kindReader
        bot = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.BOT,
            member.botRef.namespace,
            member.botRef.name,
        )

        if not bot:
            logger.warning(
                f"[OPENAPI_HELPERS] Bot not found: {member.botRef.namespace}/{member.botRef.name} for team.user_id={team.user_id}"
            )
            return False

        # Get shell type
        bot_crd = Bot.model_validate(bot.json)
        logger.info(
            f"[OPENAPI_HELPERS] Found bot: {bot.namespace}/{bot.name}, shellRef={bot_crd.spec.shellRef.namespace}/{bot_crd.spec.shellRef.name}"
        )

        # Query shell using kindReader (will fallback to public if not found personally)
        shell = kindReader.get_by_name_and_namespace(
            db,
            team.user_id,
            KindType.SHELL,
            bot_crd.spec.shellRef.namespace,
            bot_crd.spec.shellRef.name,
        )

        if not shell or not shell.json:
            logger.warning(
                f"[OPENAPI_HELPERS] Shell not found: {bot_crd.spec.shellRef.namespace}/{bot_crd.spec.shellRef.name}"
            )
            return False

        shell_crd = Shell.model_validate(shell.json)
        shell_type = shell_crd.spec.shellType
        logger.info(
            f"[OPENAPI_HELPERS] Found shell: {shell.namespace}/{shell.name}, shellType={shell_type}, is_direct_chat={is_direct_chat_shell(shell_type)}"
        )

        if not is_direct_chat_shell(shell_type):
            return False

    return True
