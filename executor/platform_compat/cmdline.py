# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Windows command line length workaround utilities.

Windows cmd.exe has a ~8191 character command line limit. When passing large
configurations (MCP servers, system prompts) to Claude Code CLI, this limit
can be exceeded, causing WinError 206 (filename or extension too long).

This module provides utilities to write large configurations to files instead
of passing them via command line arguments.
"""

import json
import logging
import os
import sys
from typing import Any

logger = logging.getLogger(__name__)


def write_json_config(config_dir: str, filename: str, data: dict) -> str | None:
    """Write JSON data to a config file.

    Args:
        config_dir: Directory to write the config file
        filename: Name of the config file (e.g., 'mcp_servers.json')
        data: Dictionary to write as JSON

    Returns:
        Path to the file, or None if failed
    """
    try:
        os.makedirs(config_dir, exist_ok=True)
        filepath = os.path.join(config_dir, filename)

        with open(filepath, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)

        return filepath
    except Exception as e:
        logger.error(f"Failed to write {filename}: {e}")
        return None


def prepare_options_for_windows(
    options: dict[str, Any], config_dir: str
) -> dict[str, Any]:
    """Prepare SDK options for Windows to avoid command line length limit.

    On Windows, large options are written to files instead of being passed
    via command line arguments. This function modifies the options dict
    in-place and returns it.

    Args:
        options: Claude SDK options dictionary
        config_dir: Directory to write config files (e.g., '.claude')

    Returns:
        Modified options dictionary
    """
    if sys.platform != "win32":
        return options

    # Write MCP servers to file
    mcp_servers = options.get("mcp_servers")
    if isinstance(mcp_servers, dict) and mcp_servers:
        # Format required by Claude Code CLI's --mcp-config flag
        filepath = write_json_config(
            config_dir, "mcp_servers.json", {"mcpServers": mcp_servers}
        )
        if filepath:
            options["mcp_servers"] = filepath
            logger.info(
                f"Windows: MCP config ({len(mcp_servers)} servers) -> {filepath}"
            )

    # Write long system_prompt to settings file
    system_prompt = options.get("system_prompt")
    if isinstance(system_prompt, str) and len(system_prompt) > 2000:
        settings_path = os.path.join(config_dir, "settings.local.json")
        settings = {}
        if os.path.exists(settings_path):
            try:
                with open(settings_path, "r", encoding="utf-8") as f:
                    settings = json.load(f)
            except Exception:
                pass

        settings["systemPrompt"] = system_prompt
        filepath = write_json_config(config_dir, "settings.local.json", settings)
        if filepath:
            del options["system_prompt"]
            logger.info(
                f"Windows: System prompt ({len(system_prompt)} chars) -> {filepath}"
            )

    return options


def get_safe_path_name(name: str) -> str:
    """Convert a name to be safe for the current platform's filesystem.

    On Windows, colons are not allowed in file/directory names (reserved for
    drive letters like C:). This function replaces colons with underscores.

    Args:
        name: Original name that may contain unsafe characters

    Returns:
        Platform-safe name
    """
    if sys.platform == "win32":
        return name.replace(":", "_")
    return name
