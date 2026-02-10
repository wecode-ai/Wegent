# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Claude Code configuration management module.

Handles Claude config files, environment variables, and model configuration.
This module provides configuration lifecycle management for Claude Code agents.
"""

import importlib
import json
import os
import random
import string
from pathlib import Path
from typing import Any, Callable, Dict, Optional

from shared.logger import setup_logger
from shared.utils.crypto import decrypt_sensitive_data, is_data_encrypted

logger = setup_logger("claude_code_config_manager")


def generate_claude_code_user_id() -> str:
    """Generate a random user ID for Claude Code."""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=64))


class HookManager:
    """
    Manages hook functions for Claude Code configuration.

    Hooks allow customization of Claude Code behavior at various points
    such as model creation and configuration.
    """

    _hooks: Dict[str, Callable] = {}

    @classmethod
    def load_hooks(cls) -> None:
        """Load hook configuration from /app/config/claude_hooks.json if exists."""
        if cls._hooks:
            return

        hook_config_path = Path("/app/config/claude_hooks.json")
        if not hook_config_path.exists():
            logger.debug(
                "No hook configuration file found at /app/config/claude_hooks.json"
            )
            return

        try:
            with open(hook_config_path, "r") as f:
                hook_config = json.load(f)
                logger.info(f"Loading hook configuration from {hook_config_path}")

                for hook_name, hook_path in hook_config.items():
                    try:
                        module_path, func_name = hook_path.rsplit(".", 1)
                        module = importlib.import_module(module_path)
                        hook_func = getattr(module, func_name)
                        cls._hooks[hook_name] = hook_func
                        logger.info(
                            f"Successfully loaded hook: {hook_name} from {hook_path}"
                        )
                    except Exception as e:
                        logger.warning(
                            f"Failed to load hook {hook_name} from {hook_path}: {e}"
                        )
        except Exception as e:
            logger.warning(
                f"Failed to load hook configuration from {hook_config_path}: {e}"
            )

    @classmethod
    def get_hook(cls, hook_name: str) -> Optional[Callable]:
        """Get a hook function by name."""
        return cls._hooks.get(hook_name)

    @classmethod
    def has_hook(cls, hook_name: str) -> bool:
        """Check if a hook is registered."""
        return hook_name in cls._hooks


def resolve_env_value(value: str) -> str:
    """Resolve a value that may be an environment variable template or encrypted.

    Handles different formats:
    1. ${VAR_NAME} - environment variable template, replace with os.environ value
    2. Encrypted value - decrypt using decrypt_sensitive_data
    3. Plain value - use as-is

    Args:
        value: The value to resolve

    Returns:
        The resolved value
    """
    import re

    if not value:
        return value

    # Check for ${VAR_NAME} pattern and replace with env var
    env_var_pattern = r"^\$\{([^}]+)\}$"
    match = re.match(env_var_pattern, value)
    if match:
        var_name = match.group(1)
        resolved = os.environ.get(var_name, "")
        if resolved:
            logger.info(f"Resolved env var ${{{var_name}}} from environment")
        else:
            logger.warning(f"Environment variable {var_name} not found")
        return resolved

    # Check if encrypted and decrypt
    if is_data_encrypted(value):
        decrypted = decrypt_sensitive_data(value)
        if decrypted:
            logger.info("Decrypted sensitive data")
            return decrypted
        logger.warning("Failed to decrypt sensitive data")
        return ""

    # Return as-is
    return value


def build_claude_json_config() -> Dict[str, Any]:
    """Build non-sensitive user preferences config for claude.json.

    Returns:
        Dictionary with Claude Code user preferences
    """
    return {
        "numStartups": 2,
        "installMethod": "unknown",
        "autoUpdates": True,
        "sonnet45MigrationComplete": True,
        "userID": generate_claude_code_user_id(),
        "hasCompletedOnboarding": True,
        "lastOnboardingVersion": "2.0.14",
        "bypassPermissionsModeAccepted": True,
        "hasOpusPlanDefault": False,
        "lastReleaseNotesSeen": "2.0.14",
        "isQualifiedForDataSharing": False,
    }


def create_claude_model_config(
    bot_config: Dict[str, Any],
    user_name: Optional[str] = None,
    git_url: Optional[str] = None,
) -> Dict[str, Any]:
    """Create Claude model configuration from bot config.

    Claude code settings: https://docs.claude.com/en/docs/claude-code/settings

    Args:
        bot_config: Bot configuration dictionary
        user_name: Optional user name for hooks
        git_url: Optional git URL for hooks

    Returns:
        Agent configuration dictionary
    """
    agent_config = bot_config.get("agent_config", {})
    env = agent_config.get("env", {})

    # Using user-defined input model configuration
    if not env.get("model"):
        return agent_config

    model_id = env.get("model_id", "")

    # Extract and resolve API key
    api_key = env.get("api_key", "")
    api_key = resolve_env_value(api_key)

    # Build environment configuration
    env_config = {
        "ANTHROPIC_MODEL": model_id,
        "ANTHROPIC_SMALL_FAST_MODEL": env.get("small_model", model_id),
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": env.get("small_model", model_id),
        "ANTHROPIC_AUTH_TOKEN": api_key,
        "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": int(
            os.getenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0")
        ),
    }

    base_url = env.get("base_url", "")
    if base_url:
        env_config["ANTHROPIC_BASE_URL"] = base_url.removesuffix("/v1")

    # Add other environment variables except model_id, api_key, base_url
    excluded_keys = {"model_id", "api_key", "base_url", "model", "small_model"}
    for key, value in env.items():
        if key not in excluded_keys and value is not None:
            env_config[key] = value

    # Apply post-creation hook if available
    hook = HookManager.get_hook("post_create_claude_model")
    if hook:
        try:
            final_config = hook(env_config, model_id, bot_config, user_name, git_url)
            logger.info("Applied post_create_claude_model hook")
            return final_config
        except Exception as e:
            logger.warning(f"Hook execution failed: {e}")

    final_claude_code_config = {
        "env": env_config,
        "includeCoAuthoredBy": os.getenv(
            "CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY", "true"
        ).lower()
        != "false",
    }

    return final_claude_code_config


def extract_claude_options(task_data: Dict[str, Any]) -> Dict[str, Any]:
    """Extract Claude Code options from task data.

    Collects all non-None configuration parameters from task_data.

    Args:
        task_data: The task data dictionary

    Returns:
        Dict containing valid Claude Code options
    """
    from executor.utils.mcp_utils import (
        extract_mcp_servers_config,
        replace_mcp_server_variables,
    )
    from executor.utils.workdir_resolver import resolve_task_workdir

    # List of valid options for ClaudeAgentOptions
    valid_options = [
        "allowed_tools",
        "max_thinking_tokens",
        "system_prompt",
        "mcp_tools",
        "mcp_servers",
        "mcpServers",
        "permission_mode",
        "continue_conversation",
        "resume",
        "max_turns",
        "disallowed_tools",
        "model",
        "permission_prompt_tool_name",
        "cwd",
        "max_buffer_size",
    ]

    # Collect all non-None configuration parameters
    # Set max_buffer_size to 50MB to handle large file reads (default is 1MB)
    options: Dict[str, Any] = {
        "setting_sources": ["user", "project", "local"],
        "max_buffer_size": 50 * 1024 * 1024,  # 50MB
    }

    bots = task_data.get("bot", [])
    bot_config = bots[0] if bots else {}

    if bot_config:
        # Extract MCP servers configuration
        mcp_servers = extract_mcp_servers_config(bot_config)
        if mcp_servers:
            # Replace placeholders in MCP servers config with actual values
            mcp_servers = replace_mcp_server_variables(mcp_servers, task_data)
            bot_config["mcp_servers"] = mcp_servers

        # Add wegent MCP server for subscription tasks
        if task_data.get("is_subscription"):
            from executor.mcp_servers.wegent.server import get_wegent_mcp_url

            wegent_mcp_url = get_wegent_mcp_url()
            wegent_mcp = {
                "wegent": {
                    "type": "http",
                    "url": wegent_mcp_url,
                }
            }
            if "mcp_servers" not in bot_config:
                bot_config["mcp_servers"] = {}
            bot_config["mcp_servers"].update(wegent_mcp)
            logger.info(
                f"Added wegent MCP server (HTTP) for subscription task at {wegent_mcp_url}"
            )

        for key in valid_options:
            if key in bot_config and bot_config[key] is not None:
                options[key] = bot_config[key]

    effective_cwd = resolve_task_workdir(task_data, options.get("cwd"))
    if effective_cwd:
        options["cwd"] = effective_cwd

    return options


def get_claude_config_dir(task_id: int, cwd: Optional[str] = None) -> str:
    """Get the .claude config directory path for a task.

    Args:
        task_id: Task ID
        cwd: Optional working directory

    Returns:
        Path to .claude config directory
    """
    from executor.config import config

    if cwd:
        return os.path.join(cwd, ".claude")
    return os.path.join(config.get_workspace_root(), str(task_id), ".claude")
