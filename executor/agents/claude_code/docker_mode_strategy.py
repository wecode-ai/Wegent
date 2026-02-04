#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Docker Mode Strategy for ClaudeCodeAgent.

This strategy handles execution in isolated Docker container environments:
- Full configuration files (settings.json, claude.json) are written
- Uses default ~/.claude/ directory (isolated per container)
- Fresh skills deployment for each container
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Tuple

from executor.agents.claude_code.mode_strategy import ExecutionModeStrategy
from shared.logger import setup_logger

logger = setup_logger("docker_mode_strategy")


class DockerModeStrategy(ExecutionModeStrategy):
    """Strategy for Docker container execution mode.

    Container-isolated implementation that:
    - Writes full settings.json (container is isolated)
    - Uses default ~/.claude/ directory
    - Clears skills cache for fresh deployment each run
    """

    def get_config_directory(self, task_id: int) -> str:
        """Get the default Claude configuration directory.

        In Docker mode, we use the default ~/.claude/ directory since
        each container is isolated.

        Args:
            task_id: The task ID (unused in Docker mode)

        Returns:
            Path to ~/.claude/ directory
        """
        return os.path.expanduser("~/.claude")

    def save_config_files(
        self,
        task_id: int,
        agent_config: Dict[str, Any],
        claude_json_config: Dict[str, Any],
    ) -> Tuple[str, Dict[str, Any]]:
        """Save all configuration files (including settings.json).

        In Docker mode, it's safe to write settings.json because each
        container is isolated. The SDK reads settings from ~/.claude/settings.json.

        Args:
            task_id: The task ID (unused in Docker mode)
            agent_config: Agent configuration containing env settings
            claude_json_config: Non-sensitive user preferences

        Returns:
            Tuple of (config_dir, empty_dict):
            - config_dir: Path where config files were saved (~/.claude/)
            - empty_dict: Empty dict (env config written to settings.json)
        """
        config_dir = self.get_config_directory(task_id)
        claude_json_path = os.path.expanduser("~/.claude.json")

        # Create config directory
        Path(config_dir).mkdir(parents=True, exist_ok=True)

        # Save settings.json (Docker mode only - isolated container environment)
        settings_path = os.path.join(config_dir, "settings.json")
        with open(settings_path, "w") as f:
            json.dump(agent_config, f, indent=2)

        # Save claude.json to ~/.claude.json
        with open(claude_json_path, "w") as f:
            json.dump(claude_json_config, f, indent=2)

        logger.info(f"Docker mode: Saved config files to {config_dir}")

        # Return empty env_config since settings are written to file
        return config_dir, {}

    def configure_client_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, Any],
        task_data: Dict[str, Any] = None,
    ) -> Dict[str, Any]:
        """Configure SDK client with default behavior.

        In Docker mode, the SDK reads configuration from settings.json
        in the default location, so no special configuration is needed.

        Args:
            options: Existing client options
            config_dir: Config directory (unused - SDK uses default)
            env_config: Environment config (unused - written to settings.json)
            task_data: Task data (unused in Docker mode)

        Returns:
            Options unchanged (default SDK behavior)
        """
        # Docker mode uses default SDK behavior - no modifications needed
        return options

    def get_skills_directory(self, config_dir: str = None) -> str:
        """Get the default skills directory.

        In Docker mode, skills are stored in the default ~/.claude/skills
        directory.

        Args:
            config_dir: Unused in Docker mode

        Returns:
            Path to ~/.claude/skills directory
        """
        return os.path.expanduser("~/.claude/skills")

    def get_skills_deployment_options(self) -> Dict[str, bool]:
        """Get deployment options for Docker mode.

        In Docker mode:
        - clear_cache=True: Start fresh for each container
        - skip_existing=False: Re-deploy all skills

        Returns:
            Dictionary with clear_cache=True, skip_existing=False
        """
        return {
            "clear_cache": True,
            "skip_existing": False,
        }
