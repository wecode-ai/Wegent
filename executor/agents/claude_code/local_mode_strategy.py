#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Local Mode Strategy for ClaudeCodeAgent.

This strategy handles execution in local (non-Docker) environments with
enhanced security measures:
- Sensitive data (API keys, tokens) are NOT written to disk
- Sensitive config is passed via environment variables to the SDK
- Config files use restricted permissions (0700 for dirs, 0600 for files)
- Task-specific directories isolate different tasks
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Tuple

from executor.agents.claude_code.mode_strategy import ExecutionModeStrategy
from executor.config import config
from shared.logger import setup_logger

logger = setup_logger("local_mode_strategy")


class LocalModeStrategy(ExecutionModeStrategy):
    """Strategy for local (non-Docker) execution mode.

    Security-focused implementation that:
    - Does NOT write settings.json (contains sensitive API keys)
    - Passes sensitive config via environment variables
    - Uses task-specific config directories
    - Applies restrictive file permissions
    - Preserves skills cache between tasks
    """

    def get_config_directory(self, task_id: int) -> str:
        """Get task-specific configuration directory.

        In local mode, each task has its own .claude directory to
        isolate configurations and prevent cross-task interference.

        Args:
            task_id: The task ID

        Returns:
            Path to task-specific .claude directory
        """
        workspace_root = config.get_workspace_root()
        return os.path.join(workspace_root, str(task_id), ".claude")

    def save_config_files(
        self,
        task_id: int,
        agent_config: Dict[str, Any],
        claude_json_config: Dict[str, Any],
    ) -> Tuple[str, Dict[str, Any]]:
        """Save only non-sensitive configuration files.

        SECURITY: Does NOT write settings.json because it contains
        sensitive data (ANTHROPIC_AUTH_TOKEN, etc.). Instead, sensitive
        configuration is returned to be passed via environment variables.

        Args:
            task_id: The task ID
            agent_config: Agent configuration containing env settings
            claude_json_config: Non-sensitive user preferences

        Returns:
            Tuple of (config_dir, env_config):
            - config_dir: Path where claude.json was saved
            - env_config: Sensitive config to pass via env vars
        """
        config_dir = self.get_config_directory(task_id)
        claude_json_path = os.path.join(config_dir, "claude.json")

        # Create directory with restricted permissions (owner only: rwx)
        Path(config_dir).mkdir(parents=True, exist_ok=True)
        os.chmod(config_dir, 0o700)

        # Write only non-sensitive claude.json with restricted permissions
        with open(claude_json_path, "w") as f:
            json.dump(claude_json_config, f, indent=2)
        os.chmod(claude_json_path, 0o600)

        logger.info(
            f"Local mode: Saved claude.json to {config_dir} "
            "(settings.json skipped - sensitive config passed via env)"
        )

        # Return env config to be passed via environment variables
        env_config = agent_config.get("env", {})
        return config_dir, env_config

    def configure_client_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Configure SDK client with environment variables for sensitive data.

        In local mode, sensitive configuration (API keys, tokens) is passed
        via the SDK's env parameter rather than being read from settings.json.
        The CLAUDE_CONFIG_DIR env var redirects all config reads/writes to
        the task-specific directory.

        Args:
            options: Existing client options
            config_dir: Task-specific config directory
            env_config: Sensitive configuration (ANTHROPIC_AUTH_TOKEN, etc.)

        Returns:
            Updated options with env configuration
        """
        updated_options = options.copy()

        # Merge env config (contains ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, etc.)
        if env_config:
            existing_env = updated_options.get("env", {})
            merged_env = {**existing_env, **env_config}
            # Ensure all values are strings (required by SDK)
            updated_options["env"] = {k: str(v) for k, v in merged_env.items()}

        # Set CLAUDE_CONFIG_DIR to redirect all config reads/writes
        # This affects settings.json, claude.json, and skills locations
        env = updated_options.get("env", {})
        env["CLAUDE_CONFIG_DIR"] = config_dir

        # Add ANTHROPIC_CUSTOM_HEADERS if configured via environment variable
        if config.ANTHROPIC_CUSTOM_HEADERS:
            env["ANTHROPIC_CUSTOM_HEADERS"] = config.ANTHROPIC_CUSTOM_HEADERS
            logger.info(
                f"Local mode: ANTHROPIC_CUSTOM_HEADERS={config.ANTHROPIC_CUSTOM_HEADERS}"
            )

        updated_options["env"] = env

        logger.debug(f"Local mode: Configured CLAUDE_CONFIG_DIR={config_dir}")
        return updated_options

    def get_skills_directory(self, config_dir: str = None) -> str:
        """Get task-specific skills directory.

        In local mode, skills are stored in the task's config directory
        to avoid modifying the user's personal ~/.claude/skills.

        Args:
            config_dir: Task-specific config directory

        Returns:
            Path to skills directory within config_dir
        """
        if config_dir:
            return os.path.join(config_dir, "skills")
        # Fallback to default location if config_dir not provided
        return os.path.expanduser("~/.claude/skills")

    def get_skills_deployment_options(self) -> Dict[str, bool]:
        """Get deployment options optimized for local mode.

        In local mode:
        - clear_cache=False: Preserve existing skills for faster startup
        - skip_existing=True: Only deploy new/updated skills

        Returns:
            Dictionary with clear_cache=False, skip_existing=True
        """
        return {
            "clear_cache": False,
            "skip_existing": True,
        }
