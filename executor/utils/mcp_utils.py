#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import re
from typing import Any, Dict, List, Optional, Tuple, Union

from shared.logger import setup_logger

logger = setup_logger("mcp_utils")


def extract_mcp_servers_config(config: Dict[str, Any]) -> Optional[Any]:
    """
    Extract MCP servers configuration supporting multiple formats.
    Priority order:
    1) {"mcpServers": {"mcpServers": {...}}}
       {"mcpServers": {"mcp_servers": {...}}}
    2) {"mcp_servers": {"mcp_servers": {...}}}
       {"mcp_servers": {"mcpServers": {...}}}
    3) {"mcpServers": {...}}
    4) {"mcp_servers": {...}}
    5) Fallback: config.get("mcp_servers")
    """
    try:
        # Collect candidates as tuples: (variant, outer_key, inner_key, cfg)
        # variant: "double" or "single"
        candidates: List[Tuple[str, str, str, Dict[str, Any]]] = []
        for outer_key in ("mcpServers", "mcp_servers"):
            val = config.get(outer_key)
            if isinstance(val, dict):
                found_double = False
                # Support cross-key inner nesting:
                for inner_key in ("mcpServers", "mcp_servers"):
                    nested = val.get(inner_key)
                    if isinstance(nested, dict) and nested:
                        logger.info(
                            f"Detected double-nested MCP config outer='{outer_key}', inner='{inner_key}'."
                        )
                        candidates.append(("double", outer_key, inner_key, nested))
                        found_double = True
                # If no valid double-nested dicts were found, treat the dict itself as single
                if not found_double and val:
                    logger.info(
                        f"Detected single-nested MCP config under '{outer_key}'."
                    )
                    candidates.append(("single", outer_key, "", val))

        # Priority selection (strict order)
        # 1) {"mcpServers": {"mcpServers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcpServers" and inner == "mcpServers":
                return cfg
        #    {"mcpServers": {"mcp_servers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcpServers" and inner == "mcp_servers":
                return cfg
        # 2) {"mcp_servers": {"mcp_servers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if (
                variant == "double"
                and outer == "mcp_servers"
                and inner == "mcp_servers"
            ):
                return cfg
        #    {"mcp_servers": {"mcpServers": {...}}}
        for variant, outer, inner, cfg in candidates:
            if variant == "double" and outer == "mcp_servers" and inner == "mcpServers":
                return cfg
        # 3) {"mcpServers": {...}}
        for variant, outer, inner, cfg in candidates:
            if variant == "single" and outer == "mcpServers":
                return cfg
        # 4) {"mcp_servers": {...}}
        for variant, outer, inner, cfg in candidates:
            if variant == "single" and outer == "mcp_servers":
                return cfg

        # 5) Fallback: original behavior
        fallback = config.get("mcp_servers")
        if fallback is not None:
            logger.info("Using fallback 'mcp_servers' configuration.")
            return fallback
    except Exception as e:
        logger.warning(f"Failed to extract MCP servers configuration: {str(e)}")
    return None


def _get_nested_value(data: Dict[str, Any], path: str) -> Optional[Any]:
    """
    Get a value from a nested dictionary using dot-separated path.
    Supports both dict key access and list index access.

    Args:
        data: The dictionary to search in
        path: Dot-separated path string, e.g., "user.name", "git_repo", or "bot.0.name"

    Returns:
        The value at the path, or None if the path doesn't exist

    Examples:
        >>> data = {"user": {"name": "John", "id": 123}}
        >>> _get_nested_value(data, "user.name")
        'John'
        >>> _get_nested_value(data, "user.email")
        None
        >>> data = {"bot": [{"name": "bot1"}, {"name": "bot2"}]}
        >>> _get_nested_value(data, "bot.0.name")
        'bot1'
        >>> _get_nested_value(data, "bot.1.name")
        'bot2'
    """
    if not data or not path:
        return None

    keys = path.split(".")
    current = data

    for key in keys:
        if isinstance(current, dict):
            if key in current:
                current = current[key]
            else:
                return None
        elif isinstance(current, list):
            # Try to parse key as integer index
            try:
                index = int(key)
                if 0 <= index < len(current):
                    current = current[index]
                else:
                    return None
            except ValueError:
                # Key is not a valid integer
                return None
        else:
            return None

    return current


def _replace_placeholders_in_string(text: str, task_data: Dict[str, Any]) -> str:
    """
    Replace all ${{path}} placeholders in a string with values from task_data.

    Args:
        text: The string containing placeholders
        task_data: The dictionary containing replacement values

    Returns:
        The string with placeholders replaced. If a path doesn't exist in task_data,
        the original placeholder is preserved.

    Examples:
        >>> task_data = {"user": {"name": "John"}, "git_repo": "owner/repo"}
        >>> _replace_placeholders_in_string("Hello ${{user.name}}", task_data)
        'Hello John'
        >>> _replace_placeholders_in_string("${{user.email}}", task_data)
        '${{user.email}}'
    """
    # Pattern to match ${{path.to.value}}
    pattern = r"\$\{\{([^}]+)\}\}"

    def replace_match(match: re.Match) -> str:
        path = match.group(1).strip()
        value = _get_nested_value(task_data, path)
        if value is not None:
            # Convert non-string values to string
            return str(value)
        else:
            # Keep original placeholder if path not found
            return match.group(0)

    return re.sub(pattern, replace_match, text)


def _replace_variables_recursive(
    obj: Union[Dict[str, Any], List[Any], str, Any], task_data: Dict[str, Any]
) -> Union[Dict[str, Any], List[Any], str, Any]:
    """
    Recursively process an object and replace placeholders in all string values.

    Args:
        obj: The object to process (dict, list, string, or other)
        task_data: The dictionary containing replacement values

    Returns:
        The processed object with all string placeholders replaced
    """
    if isinstance(obj, dict):
        return {
            key: _replace_variables_recursive(value, task_data)
            for key, value in obj.items()
        }
    elif isinstance(obj, list):
        return [_replace_variables_recursive(item, task_data) for item in obj]
    elif isinstance(obj, str):
        return _replace_placeholders_in_string(obj, task_data)
    else:
        # For other types (int, float, bool, None, etc.), return as-is
        return obj


def replace_mcp_server_variables(
    mcp_servers: Optional[Any], task_data: Optional[Dict[str, Any]]
) -> Optional[Any]:
    """
    Replace ${{path}} placeholders in MCP servers configuration with values from task_data.

    This function recursively traverses the mcp_servers configuration and replaces
    all ${{path.to.value}} format placeholders with actual values from task_data.

    Args:
        mcp_servers: The MCP servers configuration dictionary
        task_data: The task data dictionary containing replacement values.
                   Supports nested access like "user.name" -> task_data["user"]["name"]

    Returns:
        A new dictionary with all placeholders replaced. If a path doesn't exist
        in task_data, the original placeholder is preserved.

    Examples:
        >>> mcp_servers = {
        ...     "server1": {
        ...         "url": "https://api.example.com/${{user.git_login}}",
        ...         "headers": {
        ...             "Authorization": "Bearer ${{user.git_token}}",
        ...             "X-User": "${{user.name}}"
        ...         }
        ...     }
        ... }
        >>> task_data = {
        ...     "user": {
        ...         "name": "zhangsan",
        ...         "git_login": "zhangsan",
        ...         "git_token": "token123"
        ...     }
        ... }
        >>> result = replace_mcp_server_variables(mcp_servers, task_data)
        >>> result["server1"]["url"]
        'https://api.example.com/zhangsan'
        >>> result["server1"]["headers"]["Authorization"]
        'Bearer token123'

    Supported placeholder paths:
        - Simple: ${{git_repo}}, ${{branch_name}}
        - Nested: ${{user.name}}, ${{user.git_token}}
        - Deep nested: ${{bot.0.agent_config.env.api_key}} (for list access, use index)
    """
    if not mcp_servers:
        logger.debug("Empty mcp_servers provided, returning mcp_servers")
        return mcp_servers

    if not task_data:
        logger.debug("Empty task_data provided, returning mcp_servers unchanged")
        return mcp_servers

    try:
        result = _replace_variables_recursive(mcp_servers, task_data)
        logger.info("Successfully replaced variables in MCP servers configuration")
        return result
    except Exception as e:
        logger.warning(f"Failed to replace variables in MCP servers: {str(e)}")
        return mcp_servers
