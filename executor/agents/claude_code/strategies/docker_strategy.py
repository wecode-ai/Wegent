#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Docker mode strategy for Claude Code execution.

This strategy handles mode-specific behavior when the executor runs
inside a Docker container (isolated environment).
"""

import json
import os
import random
import string
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from shared.logger import setup_logger

from .base_strategy import ClaudeCodeModeStrategy

logger = setup_logger("docker_strategy")


def _generate_claude_code_user_id() -> str:
    """Generate a random user ID for Claude Code."""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=64))


class DockerClaudeCodeStrategy(ClaudeCodeModeStrategy):
    """Strategy for Docker container execution.

    Key characteristics:
        - Uses default ~/.claude/ directory (SDK standard location)
        - Writes both settings.json and claude.json (container is isolated)
        - No special environment variable overrides needed
        - Session persistence not supported (containers are ephemeral)
        - Skills are deployed with clear_cache=True for fresh state
    """

    def save_config_files(
        self,
        agent_config: Dict[str, Any],
        task_id: int,
        workspace_root: str,
    ) -> Tuple[str, Dict[str, str]]:
        """Save Claude config files to default SDK location.

        In Docker mode:
        - Config directory: ~/.claude/ (SDK default)
        - Writes both settings.json (with sensitive config) and claude.json
        - Container isolation means no security concern with sensitive data
        - Returns empty env_config (SDK reads from files directly)

        Args:
            agent_config: Claude model configuration dict
            task_id: Task ID (not used in Docker mode)
            workspace_root: Root workspace directory (not used in Docker mode)

        Returns:
            Tuple of (config_dir_path, env_config_dict)
        """
        # Non-sensitive user preferences config for claude.json
        claude_json_config = {
            "numStartups": 2,
            "installMethod": "unknown",
            "autoUpdates": True,
            "sonnet45MigrationComplete": True,
            "userID": _generate_claude_code_user_id(),
            "hasCompletedOnboarding": True,
            "lastOnboardingVersion": "2.0.14",
            "bypassPermissionsModeAccepted": True,
            "hasOpusPlanDefault": False,
            "lastReleaseNotesSeen": "2.0.14",
            "isQualifiedForDataSharing": False,
        }

        # Docker mode: save to user's ~/.claude directory (SDK default location)
        config_dir = os.path.expanduser("~/.claude")
        claude_json_path = os.path.expanduser("~/.claude.json")

        Path(config_dir).mkdir(parents=True, exist_ok=True)

        # Save settings.json (Docker mode only - isolated container environment)
        settings_path = os.path.join(config_dir, "settings.json")
        with open(settings_path, "w") as f:
            json.dump(agent_config, f, indent=2)

        # Save claude.json
        with open(claude_json_path, "w") as f:
            json.dump(claude_json_config, f, indent=2)

        logger.info(f"Docker mode: Saved config files to {config_dir}")

        # Return empty env_config - SDK reads from config files in Docker mode
        return config_dir, {}

    def configure_sdk_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, str],
    ) -> Dict[str, Any]:
        """Configure SDK options for Docker mode.

        In Docker mode:
        - No special configuration needed
        - SDK uses default paths (~/.claude/)
        - Returns options unchanged

        Args:
            options: Base SDK options dict
            config_dir: Claude config directory path (not used)
            env_config: Environment configuration dict (not used)

        Returns:
            Unchanged options dict
        """
        # Docker mode: no modifications needed, SDK uses default paths
        return options

    def get_skills_deployment_config(
        self,
        config_dir: str,
    ) -> Tuple[str, bool, bool]:
        """Get skills deployment configuration for Docker mode.

        In Docker mode:
        - Skills deployed to ~/.claude/skills (standard location)
        - skip_existing=False to always deploy
        - clear_cache=True for fresh state each container

        Args:
            config_dir: Claude config directory path (not used)

        Returns:
            Tuple of (skills_dir, skip_existing, clear_cache)
        """
        skills_dir = os.path.expanduser("~/.claude/skills")
        return (skills_dir, False, True)  # skip_existing=False, clear_cache=True

    def cleanup_session(
        self,
        task_id: int,
        workspace_root: str,
        delete_session_file: bool,
    ) -> None:
        """Cleanup session resources for Docker mode.

        Docker mode does not persist sessions, so this is a no-op.

        Args:
            task_id: Task ID
            workspace_root: Root workspace directory
            delete_session_file: Whether to delete session file (ignored)
        """
        logger.debug(
            f"Docker mode: Session persistence not supported, no cleanup needed for task {task_id}"
        )

    def get_session_file_path(
        self,
        task_id: int,
        workspace_root: str,
    ) -> Optional[str]:
        """Get session file path for Docker mode.

        Docker mode does not support session persistence.

        Args:
            task_id: Task ID
            workspace_root: Root workspace directory

        Returns:
            None - session persistence not supported in Docker mode
        """
        return None

    def supports_session_persistence(self) -> bool:
        """Docker mode does not support session persistence.

        Returns:
            False - sessions are ephemeral in containers
        """
        return False
