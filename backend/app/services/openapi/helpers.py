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
        - enable_deep_thinking: bool (also enables web search if WEB_SEARCH_ENABLED)
    """
    result = {
        "enable_deep_thinking": False,
    }
    if tools:
        for tool in tools:
            if tool.type == "wegent_deep_thinking":
                result["enable_deep_thinking"] = True
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
    team_crd = Team.model_validate(team.json)

    for member in team_crd.spec.members:
        # Find bot
        bot = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Bot",
                Kind.name == member.botRef.name,
                Kind.namespace == member.botRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        if not bot:
            return False

        # Get shell type
        bot_crd = Bot.model_validate(bot.json)

        # Check user's custom shells first
        shell = (
            db.query(Kind)
            .filter(
                Kind.user_id == team.user_id,
                Kind.kind == "Shell",
                Kind.name == bot_crd.spec.shellRef.name,
                Kind.namespace == bot_crd.spec.shellRef.namespace,
                Kind.is_active == True,
            )
            .first()
        )

        # If not found, check public shells
        if not shell:
            shell = (
                db.query(Kind)
                .filter(
                    Kind.user_id == 0,
                    Kind.kind == "Shell",
                    Kind.name == bot_crd.spec.shellRef.name,
                    Kind.namespace == bot_crd.spec.shellRef.namespace,
                    Kind.is_active == True,
                )
                .first()
            )

        if not shell or not shell.json:
            return False

        shell_crd = Shell.model_validate(shell.json)
        shell_type = shell_crd.spec.shellType

        if not is_direct_chat_shell(shell_type):
            return False

    return True
