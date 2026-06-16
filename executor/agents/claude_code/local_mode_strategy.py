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
- Project tasks can reuse global Claude config for local capability discovery

Cross-platform support:
- Unix: Uses chmod for file permissions
- Windows: Uses ACLs via platform abstraction layer
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Tuple

from executor.agents.api_headers import (
    DEFAULT_HEADERS_ENV_KEYS,
    extract_default_headers,
    merge_anthropic_custom_headers,
    merge_anthropic_header_map,
    merge_project_header,
)
from executor.agents.claude_code.mode_strategy import ExecutionModeStrategy
from executor.config import config
from executor.platform_compat import get_permissions_manager, sanitize_ld_library_path
from shared.logger import setup_logger

logger = setup_logger("local_mode_strategy")


class LocalModeStrategy(ExecutionModeStrategy):
    """Strategy for local (non-Docker) execution mode.

    Security-focused implementation that:
    - Does NOT write agent settings.json (contains sensitive API keys)
    - Passes sensitive config via environment variables
    - Uses task config by default and global Claude config for project capabilities
    - Applies restrictive file permissions
    - Preserves skills cache between tasks
    """

    def __init__(self) -> None:
        self._use_global_capabilities = False
        self._project_id: Any = None

    def use_global_capabilities(self, enabled: bool, project_id: Any = None) -> None:
        """Enable global Claude capability reuse for project task execution."""
        self._use_global_capabilities = enabled
        self._project_id = project_id if enabled else None

    def get_config_directory(self, task_id: int) -> str:
        """Get the Claude configuration directory.

        Args:
            task_id: The task ID

        Returns:
            Path to the task or global .claude directory
        """
        if self._use_global_capabilities:
            return os.path.expanduser("~/.claude")
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
        if self._use_global_capabilities:
            self._reconcile_global_capability_plugins()

        # Write only non-sensitive claude.json with restricted permissions
        with open(claude_json_path, "w") as f:
            json.dump(claude_json_config, f, indent=2)
        permissions_manager.set_owner_only(claude_json_path, is_directory=False)

        # Inject PostToolUse hook if WEGENT_FILE_EDIT_HOOK_COMMAND is configured.
        # Merge with existing global settings so user-managed plugin settings survive.
        hook_command = os.environ.get("WEGENT_FILE_EDIT_HOOK_COMMAND", "")
        if hook_command:
            settings_path = os.path.join(config_dir, "settings.json")
            try:
                settings_config = self._read_json_object(Path(settings_path))
            except FileNotFoundError:
                settings_config = {}
            except Exception as exc:
                logger.warning(
                    "Failed to read Claude settings from %s before hook merge: %s",
                    settings_path,
                    exc,
                )
                settings_config = {}

            settings_config["hooks"] = {
                "PostToolUse": [
                    {
                        "matcher": "Write|Edit",
                        "hooks": [{"type": "command", "command": hook_command}],
                    }
                ]
            }
            with open(settings_path, "w") as f:
                json.dump(settings_config, f, indent=2)
            permissions_manager.set_owner_only(settings_path, is_directory=False)

        # Return env config to be passed via environment variables
        env_config = agent_config.get("env", {})
        return config_dir, env_config

    def _reconcile_global_capability_plugins(self) -> None:
        """Restore Wegent-managed global plugins before Claude Code starts."""
        try:
            from executor.modes.local.capabilities import GlobalCapabilityStore

            restored = GlobalCapabilityStore().reconcile_managed_plugins()
            if restored:
                logger.info(
                    "Restored global Claude plugins before project task: %s",
                    sorted(restored),
                )
        except Exception as exc:
            logger.warning("Failed to reconcile global Claude plugins: %s", exc)

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
        the task-specific directory unless project-global capabilities are enabled.

        Args:
            options: Existing client options
            config_dir: Task-specific config directory
            env_config: Sensitive configuration (ANTHROPIC_AUTH_TOKEN, etc.)
            task_identity_env: Task-scoped identity env variables

        Returns:
            Updated options with env configuration
        """
        if self._use_global_capabilities or not config_dir:
            config_dir = self.get_config_directory(task_id=0)
        updated_options = options.copy()
        existing_env = dict(updated_options.get("env", {}))
        merged_env = {**existing_env, **env_config, **task_identity_env}

        # Fix PyInstaller LD_LIBRARY_PATH issue for child processes.
        # See: https://pyinstaller.org/en/stable/common-issues-and-pitfalls.html
        # Ensure all values are strings (required by SDK).
        env = {k: str(v) for k, v in merged_env.items()}
        sanitize_ld_library_path(env)

        # Project tasks use global Claude capability symlinks; non-project tasks
        # keep their task-local Claude config directory.
        env["CLAUDE_CONFIG_DIR"] = config_dir
        env["SKILLS_DIR"] = self.get_skills_directory(config_dir)

        process_custom_headers = os.environ.get("ANTHROPIC_CUSTOM_HEADERS", "")
        runtime_custom_headers = env.get("ANTHROPIC_CUSTOM_HEADERS", "")
        custom_headers = merge_anthropic_custom_headers(
            config.ANTHROPIC_CUSTOM_HEADERS,
            process_custom_headers,
            runtime_custom_headers,
        )
        default_headers = extract_default_headers(merged_env)
        if self._use_global_capabilities:
            default_headers = merge_project_header(default_headers, self._project_id)
        if default_headers:
            serialized_default_headers = json.dumps(
                default_headers,
                ensure_ascii=True,
                separators=(",", ":"),
            )
            for default_headers_key in DEFAULT_HEADERS_ENV_KEYS:
                env[default_headers_key] = serialized_default_headers
            custom_headers = merge_anthropic_header_map(
                custom_headers,
                default_headers,
            )

        # Add ANTHROPIC_CUSTOM_HEADERS if configured via environment variable or
        # project execution source metadata.
        if custom_headers:
            env["ANTHROPIC_CUSTOM_HEADERS"] = custom_headers

        updated_options["env"] = env

        logger.debug(f"Local mode: Configured CLAUDE_CONFIG_DIR={config_dir}")
        return updated_options

    def _read_json_object(self, path: Path) -> Dict[str, Any]:
        """Read a JSON object from disk."""
        with open(path, "r") as f:
            value = json.load(f)
        if not isinstance(value, dict):
            raise ValueError(f"Expected JSON object in {path}")
        return value

    def get_skills_directory(self, config_dir: str = None) -> str:
        """Get the Claude skills directory.

        Args:
            config_dir: Task-specific config directory.

        Returns:
            Path to the task or global Claude skills directory.
        """
        if self._use_global_capabilities:
            return os.path.expanduser("~/.claude/skills")
        if config_dir:
            return os.path.join(config_dir, "skills")
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
