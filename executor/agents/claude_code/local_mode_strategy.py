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
- Config files use restricted permissions (0700 for dirs, 0600 for files on Unix)
- Task-specific directories isolate different tasks

Cross-platform support:
- Unix: Uses chmod for file permissions
- Windows: Uses ACLs via platform abstraction layer
"""

import json
import os
import shutil
from pathlib import Path
from typing import Any, Dict, Tuple

from executor.agents.claude_code.mode_strategy import ExecutionModeStrategy
from executor.config import config
from executor.platform_compat import get_permissions_manager, sanitize_ld_library_path
from shared.logger import setup_logger

logger = setup_logger("local_mode_strategy")

GLOBAL_PLUGIN_SETTINGS_KEYS = ("enabledPlugins", "extraKnownMarketplaces")


class LocalModeStrategy(ExecutionModeStrategy):
    """Strategy for local (non-Docker) execution mode.

    Security-focused implementation that:
    - Does NOT write agent settings.json (contains sensitive API keys)
    - Passes sensitive config via environment variables
    - Uses task-specific config directories
    - Applies restrictive file permissions
    - Preserves skills cache between tasks
    """

    def __init__(self) -> None:
        self._use_global_capabilities = False

    def use_global_capabilities(self, enabled: bool) -> None:
        """Enable global Claude capability reuse for project task execution."""
        self._use_global_capabilities = enabled

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

        SECURITY: Does NOT write agent settings.json because it contains
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

        # Create directory with restricted permissions (owner only)
        Path(config_dir).mkdir(parents=True, exist_ok=True)
        permissions_manager = get_permissions_manager()
        permissions_manager.set_owner_only(config_dir, is_directory=True)

        # Write only non-sensitive claude.json with restricted permissions
        with open(claude_json_path, "w") as f:
            json.dump(claude_json_config, f, indent=2)
        permissions_manager.set_owner_only(claude_json_path, is_directory=False)

        # Inject PostToolUse hook if WEGENT_FILE_EDIT_HOOK_COMMAND is configured
        hook_command = os.environ.get("WEGENT_FILE_EDIT_HOOK_COMMAND", "")
        if hook_command:
            settings_config = {
                "hooks": {
                    "PostToolUse": [
                        {
                            "matcher": "Write|Edit",
                            "hooks": [{"type": "command", "command": hook_command}],
                        }
                    ]
                }
            }
            settings_path = os.path.join(config_dir, "settings.json")
            with open(settings_path, "w") as f:
                json.dump(settings_config, f, indent=2)
            permissions_manager.set_owner_only(settings_path, is_directory=False)

        # Return env config to be passed via environment variables
        env_config = agent_config.get("env", {})
        return config_dir, env_config

    def configure_client_options(
        self,
        options: Dict[str, Any],
        config_dir: str,
        env_config: Dict[str, Any],
        task_identity_env: Dict[str, Any],
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
            task_identity_env: Task-scoped identity env variables

        Returns:
            Updated options with env configuration
        """
        updated_options = options.copy()
        existing_env = dict(updated_options.get("env", {}))
        merged_env = {**existing_env, **env_config, **task_identity_env}
        # Ensure all values are strings (required by SDK)
        updated_options["env"] = {k: str(v) for k, v in merged_env.items()}

        # Fix PyInstaller LD_LIBRARY_PATH issue for child processes.
        # See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
        env = dict(updated_options.get("env", {}))
        sanitize_ld_library_path(env)

        # Set CLAUDE_CONFIG_DIR to redirect all config reads/writes
        # This affects settings.json, claude.json, skills, and plugins locations.
        if self._use_global_capabilities:
            self._expose_global_claude_capability_directories(config_dir)
            self._merge_global_plugin_settings(config_dir)
        env["CLAUDE_CONFIG_DIR"] = config_dir
        env["SKILLS_DIR"] = self.get_skills_directory(config_dir)

        # Add ANTHROPIC_CUSTOM_HEADERS if configured via environment variable
        if config.ANTHROPIC_CUSTOM_HEADERS:
            env["ANTHROPIC_CUSTOM_HEADERS"] = config.ANTHROPIC_CUSTOM_HEADERS
            logger.info(
                f"Local mode: ANTHROPIC_CUSTOM_HEADERS={config.ANTHROPIC_CUSTOM_HEADERS}"
            )

        updated_options["env"] = env

        logger.debug(f"Local mode: Configured CLAUDE_CONFIG_DIR={config_dir}")
        return updated_options

    def _expose_global_claude_capability_directories(self, config_dir: str) -> None:
        """Expose global Claude capability directories in the task config dir."""
        for directory_name in ("skills", "plugins"):
            self._expose_global_claude_capability_directory(config_dir, directory_name)

    def _expose_global_claude_capability_directory(
        self, config_dir: str, directory_name: str
    ) -> None:
        """Expose one global Claude capability directory in the task config dir."""
        global_capability_dir = Path(os.path.expanduser("~/.claude")) / directory_name
        task_capability_dir = Path(config_dir) / directory_name
        permissions_manager = get_permissions_manager()

        global_capability_dir.mkdir(parents=True, exist_ok=True)
        permissions_manager.set_owner_only(
            str(global_capability_dir), is_directory=True
        )
        task_capability_dir.parent.mkdir(parents=True, exist_ok=True)

        try:
            if task_capability_dir.is_symlink():
                if task_capability_dir.resolve() == global_capability_dir.resolve():
                    return
                task_capability_dir.unlink()
            elif task_capability_dir.exists():
                if task_capability_dir.samefile(global_capability_dir):
                    return
                shutil.rmtree(task_capability_dir)

            os.symlink(
                global_capability_dir,
                task_capability_dir,
                target_is_directory=True,
            )
            logger.info(
                "Local mode: exposed global Claude %s directory %s at %s",
                directory_name,
                global_capability_dir,
                task_capability_dir,
            )
        except Exception as exc:
            logger.warning(
                "Failed to symlink global Claude %s directory %s to %s: %s. "
                "Falling back to a directory copy.",
                directory_name,
                global_capability_dir,
                task_capability_dir,
                exc,
            )
            if task_capability_dir.exists() or task_capability_dir.is_symlink():
                if task_capability_dir.is_symlink():
                    task_capability_dir.unlink()
                else:
                    shutil.rmtree(task_capability_dir)
            shutil.copytree(
                global_capability_dir, task_capability_dir, dirs_exist_ok=True
            )

    def _merge_global_plugin_settings(self, config_dir: str) -> None:
        """Copy non-sensitive global plugin settings into task settings."""
        global_settings_path = Path(os.path.expanduser("~/.claude/settings.json"))
        if not global_settings_path.is_file():
            return

        try:
            global_settings = self._read_json_object(global_settings_path)
        except Exception as exc:
            logger.warning(
                "Failed to read global Claude settings from %s: %s",
                global_settings_path,
                exc,
            )
            return

        plugin_settings = {
            key: value
            for key, value in global_settings.items()
            if key in GLOBAL_PLUGIN_SETTINGS_KEYS and isinstance(value, dict) and value
        }
        if not plugin_settings:
            return

        task_settings_path = Path(config_dir) / "settings.json"
        try:
            task_settings = self._read_json_object(task_settings_path)
        except FileNotFoundError:
            task_settings = {}
        except Exception as exc:
            logger.warning(
                "Failed to read task Claude settings from %s: %s",
                task_settings_path,
                exc,
            )
            task_settings = {}

        for key, global_value in plugin_settings.items():
            task_value = task_settings.get(key)
            if isinstance(task_value, dict):
                task_settings[key] = {**global_value, **task_value}
            else:
                task_settings[key] = global_value

        task_settings_path.parent.mkdir(parents=True, exist_ok=True)
        with open(task_settings_path, "w") as f:
            json.dump(task_settings, f, indent=2)
        get_permissions_manager().set_owner_only(
            str(task_settings_path), is_directory=False
        )
        logger.info(
            "Local mode: merged global Claude plugin settings into %s",
            task_settings_path,
        )

    def _read_json_object(self, path: Path) -> Dict[str, Any]:
        """Read a JSON object from disk."""
        with open(path, "r") as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError(f"Expected JSON object in {path}")
        return value

    def get_skills_directory(self, config_dir: str = None) -> str:
        """Get task-specific skills directory.

        In local mode, skills are stored in the task's config directory
        to avoid modifying the user's personal ~/.claude/skills.

        Args:
            config_dir: Task-specific config directory

        Returns:
            Path to skills directory within config_dir
        """
        if self._use_global_capabilities:
            return os.path.expanduser("~/.claude/skills")
        if config_dir:
            skills_dir = os.path.join(config_dir, "skills")
            self._copy_global_managed_skills(skills_dir)
            return skills_dir
        # Fallback to default location if config_dir not provided
        return os.path.expanduser("~/.claude/skills")

    def _copy_global_managed_skills(self, target_skills_dir: str) -> None:
        """Copy globally synced managed skills into the task skills directory."""
        try:
            from executor.modes.local.capabilities import GlobalCapabilityStore

            store = GlobalCapabilityStore()
            manifest = store.load()
            os.makedirs(target_skills_dir, exist_ok=True)
            copied = []
            skipped = []
            for name, record in manifest.get("skills", {}).items():
                if not isinstance(record, dict) or not record.get("managed", True):
                    continue
                source = store.skills_dir / name
                target = os.path.join(target_skills_dir, name)
                if not source.is_dir() or os.path.exists(target):
                    skipped.append(name)
                    continue
                shutil.copytree(source, target)
                copied.append(name)
            logger.info(
                "Copied global managed skills: copied=%s skipped=%s target=%s",
                copied,
                skipped,
                target_skills_dir,
            )
        except Exception as exc:
            logger.warning("Failed to copy global managed skills: %s", exc)

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
