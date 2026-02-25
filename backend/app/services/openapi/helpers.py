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
        - workspace: dict (git workspace info for code tasks, contains git_url, branch, git_repo, git_domain)
    """
    result: Dict[str, Any] = {
        "enable_chat_bot": False,
        "mcp_servers": {},
        "preload_skills": [],
        "workspace": None,
    }
    if tools:
        for tool in tools:
            if tool.type == "wegent_chat_bot":
                result["enable_chat_bot"] = True
            elif tool.type == "wegent_code_bot":
                # Extract git repository information for code tasks
                if not tool.workspace:
                    raise HTTPException(
                        status_code=status.HTTP_400_BAD_REQUEST,
                        detail="workspace is required when type='wegent_code_bot'",
                    )
                result["workspace"] = {
                    "git_url": tool.workspace.git_url,
                    "branch": tool.workspace.branch,
                    "git_repo": tool.workspace.git_repo
                    or _extract_repo_from_url(tool.workspace.git_url),
                    "git_domain": _extract_domain_from_url(tool.workspace.git_url),
                }
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


def _extract_repo_from_url(git_url: str) -> Optional[str]:
    """
    Extract repository name from git URL.

    Examples:
        https://github.com/user/repo.git -> user/repo
        git@github.com:user/repo.git -> user/repo
        https://gitlab.com/group/subgroup/repo.git -> group/subgroup/repo

    Args:
        git_url: Git repository URL

    Returns:
        Repository name or None if cannot be extracted
    """
    if not git_url:
        return None

    # Remove trailing .git
    url = git_url.rstrip("/")
    if url.endswith(".git"):
        url = url[:-4]

    # Handle SSH format: git@github.com:user/repo
    if url.startswith("git@"):
        # git@github.com:user/repo -> user/repo
        parts = url.split(":")
        if len(parts) == 2:
            return parts[1]

    # Handle HTTPS format: https://github.com/user/repo
    # Extract path after domain
    if "://" in url:
        # Remove protocol and domain
        path = url.split("://", 1)[1]
        # Remove domain part
        if "/" in path:
            path = path.split("/", 1)[1]
            return path

    return None


def _extract_domain_from_url(git_url: str) -> Optional[str]:
    """
    Extract domain from git URL.

    Examples:
        https://github.com/user/repo.git -> github.com
        git@github.com:user/repo.git -> github.com
        https://gitlab.example.com/group/repo.git -> gitlab.example.com

    Args:
        git_url: Git repository URL

    Returns:
        Domain or None if cannot be extracted
    """
    if not git_url:
        return None

    # Handle SSH format: git@github.com:user/repo
    if git_url.startswith("git@"):
        # git@github.com:user/repo -> github.com
        url = git_url[4:]  # Remove 'git@'
        if ":" in url:
            return url.split(":")[0]

    # Handle HTTPS format: https://github.com/user/repo
    if "://" in git_url:
        # Remove protocol
        url = git_url.split("://", 1)[1]
        # Get domain part
        if "/" in url:
            return url.split("/")[0]
        return url

    return None


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


def get_team_shell_type(db: Session, team: Kind) -> str:
    """
    Get the shell type of the first bot in the team.

    This is used to determine the execution mode for the team.

    Args:
        db: Database session
        team: Team Kind object

    Returns:
        Shell type string (e.g., "Chat", "ClaudeCode", "Agno", "Dify")
    """
    import logging

    logger = logging.getLogger(__name__)
    team_crd = Team.model_validate(team.json)

    if not team_crd.spec.members:
        logger.warning(
            f"[OPENAPI_HELPERS] Team has no members: {team.namespace}/{team.name}"
        )
        return "Chat"  # Default to Chat

    # Get the first member's bot
    first_member = team_crd.spec.members[0]
    bot = kindReader.get_by_name_and_namespace(
        db,
        team.user_id,
        KindType.BOT,
        first_member.botRef.namespace,
        first_member.botRef.name,
    )

    if not bot:
        logger.warning(
            f"[OPENAPI_HELPERS] Bot not found: {first_member.botRef.namespace}/{first_member.botRef.name}"
        )
        return "Chat"  # Default to Chat

    # Get shell type
    bot_crd = Bot.model_validate(bot.json)
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
        return "Chat"  # Default to Chat

    shell_crd = Shell.model_validate(shell.json)
    return shell_crd.spec.shellType
    return True
