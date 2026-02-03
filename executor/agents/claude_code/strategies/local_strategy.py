#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

"""
Local mode strategy for Claude Code execution.

This strategy handles mode-specific behavior when the executor runs
locally on the user's machine (not in a Docker container).
"""

import json
import os
import random
import string
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from shared.logger import setup_logger

from .base_strategy import ClaudeCodeModeStrategy

logger = setup_logger("local_strategy")


def _generate_claude_code_user_id() -> str:
    """Generate a random user ID for Claude Code."""
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=64))


class LocalClaudeCodeStrategy(ClaudeCodeModeStrategy):
    """Strategy for local executor running on user's machine.

    Key characteristics:
        - Uses task-specific config directory to avoid polluting user's ~/.claude/
        - Does NOT write settings.json (contains sensitive API keys)
        - Passes sensitive config via environment variables
        - Supports session persistence via .claude_session_id file
        - Skills are deployed with skip_existing=True to avoid re-downloading
    """

    def save_config_files(
        self,
        agent_config: Dict[str, Any],
        task_id: int,
        workspace_root: str,
    ) -> Tuple[str, Dict[str, str]]:
        """Save Claude config files to task-specific directory.

        In Local mode:
        - Config directory: {workspace_root}/{task_id}/.claude/
        - Only writes claude.json (non-sensitive user preferences)
        - Does NOT write settings.json (contains sensitive API keys)
        - Sensitive config is passed via environment variables
        - Uses restricted file permissions (0o700 for dir, 0o600 for file)

        Args:
            agent_config: Claude model configuration dict
            task_id: Task ID
            workspace_root: Root workspace directory

        Returns:
            Tuple of (config_dir_path, env_config_dict)
        """
        # Extract env config for passing to SDK via environment variables
        env_config = agent_config.get("env", {})

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

        # Local mode: task-specific config directory
        config_dir = os.path.join(workspace_root, str(task_id), ".claude")
        claude_json_path = os.path.join(config_dir, "claude.json")

        # Create directory with restricted permissions (owner only)
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

        return config_dir, env_config

    def configure_sdk_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, str],
    ) -> Dict[str, Any]:
        """Configure SDK options for local mode.

        In Local mode:
        - Merges env_config into options["env"]
        - Sets CLAUDE_CONFIG_DIR to redirect SDK config reads/writes
          to task-specific directory instead of ~/.claude/

        Args:
            options: Base SDK options dict
            config_dir: Claude config directory path
            env_config: Environment configuration dict

        Returns:
            Modified options dict
        """
        # Make a copy to avoid modifying the original
        options = dict(options)

        # Pass env config (contains ANTHROPIC_AUTH_TOKEN, ANTHROPIC_MODEL, etc.)
        if env_config:
            existing_env = options.get("env", {})
            merged_env = {**existing_env, **env_config}
            options["env"] = {k: str(v) for k, v in merged_env.items()}

        # Set CLAUDE_CONFIG_DIR env var to redirect all config reads/writes
        # This affects settings.json, claude.json, and skills locations
        if config_dir:
            env = options.get("env", {})
            env["CLAUDE_CONFIG_DIR"] = config_dir
            options["env"] = env

        return options

    def get_skills_deployment_config(
        self,
        config_dir: str,
    ) -> Tuple[str, bool, bool]:
        """Get skills deployment configuration for local mode.

        In Local mode:
        - Skills deployed to {config_dir}/skills (follows CLAUDE_CONFIG_DIR)
        - skip_existing=True to avoid re-downloading existing skills
        - clear_cache=False to preserve cached skills

        Args:
            config_dir: Claude config directory path

        Returns:
            Tuple of (skills_dir, skip_existing, clear_cache)
        """
        skills_dir = os.path.join(config_dir, "skills")
        return (skills_dir, True, False)  # skip_existing=True, clear_cache=False

    def cleanup_session(
        self,
        task_id: int,
        workspace_root: str,
        delete_session_file: bool,
    ) -> None:
        """Cleanup session resources for local mode.

        Args:
            task_id: Task ID
            workspace_root: Root workspace directory
            delete_session_file: Whether to delete the session file
                - True: Full cleanup (manual close)
                - False: Partial cleanup (pause) - keep session file for resume
        """
        if not delete_session_file:
            logger.info(
                f"Local mode: Keeping session file for task {task_id} (pause mode)"
            )
            return

        # Delete session file for full cleanup
        session_file = self.get_session_file_path(task_id, workspace_root)
        if session_file and os.path.exists(session_file):
            try:
                os.remove(session_file)
                logger.info(f"Deleted session file: {session_file}")
            except Exception as e:
                logger.warning(f"Failed to delete session file {session_file}: {e}")
        else:
            logger.debug(
                f"Session file not found for task {task_id}, nothing to delete"
            )

    def get_session_file_path(
        self,
        task_id: int,
        workspace_root: str,
    ) -> Optional[str]:
        """Get session file path for local mode.

        Args:
            task_id: Task ID
            workspace_root: Root workspace directory

        Returns:
            Path to session file: {workspace_root}/{task_id}/.claude_session_id
        """
        task_dir = os.path.join(workspace_root, str(task_id))
        return os.path.join(task_dir, ".claude_session_id")

    def supports_session_persistence(self) -> bool:
        """Local mode supports session persistence.

        Returns:
            True - sessions can be persisted and resumed
        """
        return True
