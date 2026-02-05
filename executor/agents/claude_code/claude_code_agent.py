#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import importlib
import json
import os
import random
import re
import string
import subprocess
import time
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

from executor.agents.agno.thinking_step_manager import ThinkingStepManager
from executor.agents.base import Agent
from executor.agents.claude_code.mode_strategy import (
    ExecutionModeStrategy,
    ModeStrategyFactory,
)
from executor.agents.claude_code.progress_state_manager import ProgressStateManager
from executor.agents.claude_code.response_processor import process_response
from executor.config import config
from executor.services.attachment_downloader import get_api_base_url
from executor.tasks.resource_manager import ResourceManager
from executor.tasks.task_state_manager import TaskState, TaskStateManager
from executor.utils.mcp_utils import (
    extract_mcp_servers_config,
    replace_mcp_server_variables,
)
from shared.logger import setup_logger
from shared.models.task import ExecutionResult, ThinkingStep
from shared.status import TaskStatus
from shared.telemetry.decorators import add_span_event, trace_async
from shared.utils.crypto import (
    decrypt_git_token,
    decrypt_sensitive_data,
    is_data_encrypted,
    is_token_encrypted,
)
from shared.utils.sensitive_data_masker import mask_sensitive_data

logger = setup_logger("claude_code_agent")


def _extract_claude_agent_attributes(self, *args, **kwargs) -> Dict[str, Any]:
    """Extract trace attributes from ClaudeCodeAgent instance."""
    return {
        "task.id": str(self.task_id),
        "task.subtask_id": str(self.subtask_id),
        "agent.type": "ClaudeCode",
        "agent.session_id": str(self.session_id),
    }


def _generate_claude_code_user_id() -> str:
    return "".join(random.choices(string.ascii_lowercase + string.digits, k=64))


class ClaudeCodeAgent(Agent):
    """
    Claude Code Agent that integrates with Claude Code SDK
    """

    # Static dictionary for storing client connections to enable connection reuse
    # Key: session_id (task_id:bot_id format), Value: ClaudeSDKClient
    _clients: Dict[str, ClaudeSDKClient] = {}

    # Static dictionary for storing hook functions
    _hooks: Dict[str, Any] = {}

    # Static dictionary for mapping internal_session_key to actual Claude session_id
    # Key: internal_session_key (task_id:bot_id), Value: actual Claude session_id
    _session_id_map: Dict[str, str] = {}

    def get_name(self) -> str:
        return "ClaudeCode"

    @staticmethod
    def _get_session_id_file_path(task_id: int) -> str:
        """Get the path to the session ID file for a task.

        Args:
            task_id: Task ID

        Returns:
            Path to the session ID file
        """
        workspace_root = config.get_workspace_root()
        task_dir = os.path.join(workspace_root, str(task_id))
        return os.path.join(task_dir, ".claude_session_id")

    @classmethod
    def _load_saved_session_id(cls, task_id: int) -> str | None:
        """Load saved Claude session ID for a task.

        Args:
            task_id: Task ID

        Returns:
            Saved session ID or None if not found
        """
        session_file = cls._get_session_id_file_path(task_id)
        try:
            if os.path.exists(session_file):
                with open(session_file, "r", encoding="utf-8") as f:
                    session_id = f.read().strip()
                    if session_id:
                        logger.info(
                            f"Loaded saved Claude session ID for task {task_id}: {session_id}"
                        )
                        return session_id
        except Exception as e:
            logger.warning(f"Failed to load saved session ID for task {task_id}: {e}")
        return None

    @classmethod
    def _save_session_id(cls, task_id: int, claude_session_id: str) -> None:
        """Save Claude session ID for a task.

        Args:
            task_id: Task ID
            claude_session_id: Claude's actual session ID
        """
        session_file = cls._get_session_id_file_path(task_id)
        try:
            # Ensure directory exists
            os.makedirs(os.path.dirname(session_file), exist_ok=True)

            with open(session_file, "w", encoding="utf-8") as f:
                f.write(claude_session_id)
            logger.info(
                f"Saved Claude session ID for task {task_id}: {claude_session_id}"
            )
        except Exception as e:
            logger.warning(f"Failed to save session ID for task {task_id}: {e}")

    @classmethod
    def get_active_task_ids(cls) -> list[int]:
        """Get list of active task IDs.

        Each task_id represents an active Claude Code session/process.
        Session keys can be in format:
        - "task_id:bot_id" for initial connections
        - "subtask_id" when new_session=True (subtask_id as session_id)

        To get correct task_ids, we need to:
        1. Check _session_id_map to find internal_key -> session_id mappings
        2. Extract task_id from internal_key (format: "task_id:bot_id")

        Returns:
            List of active task IDs
        """
        task_ids = []

        # Use _session_id_map to correctly map session_id back to task_id
        # internal_key format: "task_id:bot_id", session_id can be "task_id:bot_id" or "subtask_id"
        for internal_key in cls._session_id_map.keys():
            try:
                # Extract task_id from internal_key (format: "task_id:bot_id" or "task_id")
                task_id_str = internal_key.split(":")[0]
                task_id = int(task_id_str)
                if task_id not in task_ids:
                    task_ids.append(task_id)
            except (ValueError, IndexError):
                continue

        # Also check _clients directly for session_ids in "task_id:bot_id" format
        # (these may not have corresponding _session_id_map entries)
        for session_id in cls._clients.keys():
            try:
                # Only process if it looks like "task_id:bot_id" format
                if ":" in session_id:
                    task_id_str = session_id.split(":")[0]
                    task_id = int(task_id_str)
                    if task_id not in task_ids:
                        task_ids.append(task_id)
            except (ValueError, IndexError):
                continue

        return task_ids

    @classmethod
    def get_active_session_count(cls) -> int:
        """Get the number of active Claude Code sessions.

        Returns:
            Number of active sessions (same as number of active tasks)
        """
        return len(cls.get_active_task_ids())

    @classmethod
    def _load_hooks(cls):
        """
        Load hook configuration if available
        This method loads hooks from /app/config/claude_hooks.json if it exists.
        Hooks are loaded once and stored in the class variable _hooks.
        """
        if cls._hooks:
            # Hooks already loaded
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
                        # Parse module path and function name
                        module_path, func_name = hook_path.rsplit(".", 1)
                        # Dynamically import the module
                        module = importlib.import_module(module_path)
                        # Get the function from the module
                        hook_func = getattr(module, func_name)
                        # Store the hook function
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

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the Claude Code Agent

        Args:
            task_data: The task data dictionary
        """
        super().__init__(task_data)
        self.client = None
        self.new_session = task_data.get("new_session", False)

        # Extract bot_id from task_data for session key
        # In pipeline mode, each bot has its own session
        bot_id = None
        bots = task_data.get("bot", [])
        if bots and len(bots) > 0:
            bot_id = bots[0].get("id")

        # Internal key for caching - use task_id:bot_id so each bot has independent session
        # This allows pipeline tasks to jump back to previous bots and restore their sessions
        if bot_id:
            self._internal_session_key = f"{self.task_id}:{bot_id}"
        else:
            self._internal_session_key = str(self.task_id)

        cached_session_id = self._session_id_map.get(self._internal_session_key)

        # Case 1: No cache -> use internal_session_key as session_id
        if not cached_session_id:
            self.session_id = self._internal_session_key
            logger.info(
                f"No cache, using {self.session_id} as session_id (bot_id={bot_id})"
            )
        # Case 2: Has cache + new_session=True -> create new session in _async_execute
        elif self.new_session:
            # For new_session, we'll create a new client but keep the old one for potential jump-back
            self.session_id = cached_session_id
            logger.info(
                f"Has cache + new_session=True, will create new session for {self.session_id}"
            )
        # Case 3: Has cache + new_session=False -> use cached session_id (follow-up in same bot)
        else:
            self.session_id = cached_session_id
            logger.info(
                f"Has cache, using cached session_id {self.session_id} (bot_id={bot_id})"
            )
        self.prompt = task_data.get("prompt", "")
        self.project_path = None

        # Load hooks on first initialization
        self._load_hooks()

        # Extract Claude Code options from task_data
        self.options = self._extract_claude_options(task_data)
        self.options["permission_mode"] = "bypassPermissions"

        # Set git-related environment variables
        self._set_git_env_variables(task_data)

        # Initialize thinking step manager
        self.thinking_manager = ThinkingStepManager(
            progress_reporter=self.report_progress
        )

        # Initialize progress state manager - will be fully initialized when task starts
        self.state_manager: Optional[ProgressStateManager] = None

        # Initialize task state manager and resource manager
        self.task_state_manager = TaskStateManager()
        self.resource_manager = ResourceManager()

        # Set initial task state to RUNNING
        self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)

        # Silent exit tracking for subscription tasks
        self.is_silent_exit: bool = False
        self.silent_exit_reason: str = ""

        # Config directory and env config for Local mode (populated in initialize())
        self._claude_config_dir: str = ""
        self._claude_env_config: Dict[str, Any] = {}

        # Callback for when client is created (used for heartbeat updates)
        self.on_client_created_callback: Optional[callable] = None

        # Initialize execution mode strategy
        self._mode_strategy: ExecutionModeStrategy = ModeStrategyFactory.create()

    def _set_git_env_variables(self, task_data: Dict[str, Any]) -> None:
        """
        Extract git-related fields from task_data and set them as environment variables

        Args:
            task_data: The task data dictionary
        """
        git_fields = {
            "git_domain": "GIT_DOMAIN",
            "git_repo": "GIT_REPO",
            "git_repo_id": "GIT_REPO_ID",
            "branch_name": "BRANCH_NAME",
            "git_url": "GIT_URL",
        }

        env_values = {}
        for source_key, env_key in git_fields.items():
            value = task_data.get(source_key)
            if value is not None:
                os.environ[env_key] = str(value)
                env_values[env_key] = value

        if env_values:
            logger.info("Set git environment variables")

        # Configure GitLab CLI authentication if git_domain is available
        git_domain = task_data.get("git_domain")
        if not git_domain:
            logger.warning("No git_domain provided, skipping CLI authentication.")
            return

        git_token = self._get_git_token(git_domain, task_data)
        if not git_token:
            logger.warning(
                f"No valid token found for {git_domain}, skipping authentication."
            )
            return

        self._authenticate_cli(git_domain, git_token)

    def _authenticate_cli(self, git_domain: str, git_token: str) -> None:

        is_github = "github" in git_domain.lower()
        cmd = None

        if is_github:
            # GitHub CLI supports stdin token
            cmd = f'echo "{git_token}" | gh auth login --with-token'
        else:
            # GitLab CLI uses token flag
            cmd = f'glab auth login --hostname {git_domain} --token "{git_token}"'

        self._configure_repo_proxy(git_domain)

        try:
            result = subprocess.run(
                cmd,
                shell=True,
                capture_output=True,
                text=True,
                check=True,
            )
            logger.info(
                f"{'GitHub' if is_github else 'GitLab'} CLI authenticated for {git_domain}"
            )
            if result.stdout.strip():
                logger.debug(f"CLI output: {result.stdout.strip()}")

        except subprocess.CalledProcessError as e:
            stderr = e.stderr.strip() if e.stderr else str(e)
            logger.warning(f"CLI authentication failed for {git_domain}: {stderr}")
        except Exception as e:
            logger.warning(
                f"Unexpected error during CLI authentication for {git_domain}: {e}"
            )

    def _configure_repo_proxy(self, git_domain: str) -> None:
        """
        Configure repository CLI proxy settings using REPO_PROXY_CONFIG env mapping.

        The REPO_PROXY_CONFIG environment variable should contain JSON with domains
        as keys and proxy definitions (http_proxy/https_proxy) as values.
        """
        proxy_config_raw = os.getenv("REPO_PROXY_CONFIG")
        if not proxy_config_raw:
            logger.info(
                "No REPO_PROXY_CONFIG environment variable set, skipping proxy configuration."
            )
            return

        try:
            proxy_config = json.loads(proxy_config_raw)
        except json.JSONDecodeError as e:
            logger.warning(f"Invalid REPO_PROXY_CONFIG JSON: {e}")
            return

        domain_config = (
            proxy_config.get(git_domain)
            or proxy_config.get(git_domain.lower())
            or proxy_config.get("*")
        )
        if not isinstance(domain_config, dict):
            logger.info(f"No proxy configuration found for domain {git_domain}")
            return

        proxy_values = {
            key.lower(): value
            for key, value in domain_config.items()
            if key.lower() in {"http.proxy", "https.proxy"} and value
        }

        if not proxy_values:
            logger.info(
                f"Proxy configuration for domain {git_domain} is empty, skipping."
            )
            return

        for proxy_key, proxy_value in proxy_values.items():
            cmd = f"git config --global {proxy_key} {proxy_value}"
            try:
                subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                logger.info(
                    f"Configured environment {proxy_key} for domain {git_domain}"
                )
            except subprocess.CalledProcessError as e:
                stderr = e.stderr.strip() if e.stderr else str(e)
                logger.warning(f"Proxy configuration failed: {stderr}")

    def _get_git_token(
        self, git_domain: str, task_data: Dict[str, Any]
    ) -> Optional[str]:
        user_cfg = task_data.get("user", {})
        git_token = user_cfg.get("git_token")

        if git_token and git_token != "***":
            # Check if the token is encrypted and decrypt if needed
            if is_token_encrypted(git_token):
                logger.debug(f"Decrypting git token for domain: {git_domain}")
                return decrypt_git_token(git_token)
            return git_token.strip()

        token_path = os.path.expanduser(f"~/.ssh/{git_domain}")
        if os.path.exists(token_path):
            try:
                with open(token_path, "r", encoding="utf-8") as f:
                    token = f.read().strip()
                    # Check if the token is encrypted and decrypt if needed
                    if is_token_encrypted(token):
                        logger.debug(
                            f"Decrypting git token from file for domain: {git_domain}"
                        )
                        return decrypt_git_token(token)
                    return token
            except Exception as e:
                logger.warning(f"Failed to read token from {token_path}: {e}")
        return None

    def add_thinking_step(
        self,
        title: str,
        action: str = "",
        reasoning: str = "",
        result: str = "",
        confidence: float = -1,
        next_action: str = "continue",
        report_immediately: bool = True,
        use_i18n_keys: bool = False,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step (wrapper for backward compatibility)

        Args:
            title: Step title
            action: Action description (ignored)
            reasoning: Reasoning process (ignored)
            result: Result (ignored)
            confidence: Confidence level (ignored)
            next_action: Next action (ignored)
            report_immediately: Whether to report this thinking step immediately (default True)
            use_i18n_keys: Whether to use i18n key directly instead of English text (default False)
            details: Additional details for the thinking step (optional)
        """
        self.thinking_manager.add_thinking_step(
            title=title,
            report_immediately=report_immediately,
            use_i18n_keys=use_i18n_keys,
            details=details,
        )

    def add_thinking_step_by_key(
        self,
        title_key: str,
        report_immediately: bool = True,
        details: Optional[Dict[str, Any]] = None,
    ) -> None:
        """
        Add a thinking step using i18n key (wrapper for backward compatibility)

        Args:
            title_key: i18n key for step title
            action_key: i18n key for action description (ignored)
            reasoning_key: i18n key for reasoning process (ignored)
            result_key: i18n key for result (ignored)
            confidence: Confidence level (ignored)
            next_action_key: i18n key for next action (ignored)
            report_immediately: Whether to report this thinking step immediately (default True)
            details: Additional details for thinking step (optional)
        """
        self.thinking_manager.add_thinking_step_by_key(
            title_key=title_key, report_immediately=report_immediately, details=details
        )

    def _text_to_i18n_key(self, text: str) -> str:
        """
        Convert text to i18n key

        Args:
            text: Text to convert

        Returns:
            str: Corresponding i18n key
        """
        return self.thinking_manager._text_to_i18n_key(text)

    def _update_progress(self, progress: int) -> None:
        """
        Update current progress value for thinking steps

        Args:
            progress: Current progress value (0-100)
        """
        self.thinking_manager.update_progress(progress)

    def get_thinking_steps(self) -> List[ThinkingStep]:
        """
        Get all thinking steps

        Returns:
            List[ThinkingStep]: List of thinking steps
        """
        return self.thinking_manager.get_thinking_steps()

    def clear_thinking_steps(self) -> None:
        """
        Clear all thinking steps
        """
        self.thinking_manager.clear_thinking_steps()

    def _initialize_state_manager(self) -> None:
        """
        Initialize the progress state manager
        """
        if self.state_manager is None:
            # Get project path from options or use default
            project_path = self.options.get("cwd", self.project_path)

            self.state_manager = ProgressStateManager(
                thinking_manager=self.thinking_manager,
                task_data=self.task_data,
                report_progress_callback=self.report_progress,
                project_path=project_path,
            )

            # Set state_manager to thinking_manager for immediate reporting
            self.thinking_manager.set_state_manager(self.state_manager)

            logger.info("Initialized progress state manager")

    def update_prompt(self, new_prompt: str) -> None:
        """
        Update the prompt attribute while keeping other attributes unchanged

        Args:
            new_prompt: The new prompt to use
        """
        if new_prompt:
            logger.info(f"Updating prompt for session_id: {self.session_id}")
            self.prompt = new_prompt

    def initialize(self) -> TaskStatus:
        """
        Initialize the Claude Code Agent with configuration from task_data.
        Generates config files to task workspace directory and passes via settings parameter.

        Returns:
            TaskStatus: Initialization status
        """
        try:
            # Check if task was cancelled before initialization
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} was cancelled before initialization")
                return TaskStatus.COMPLETED

            self.add_thinking_step_by_key(
                title_key="thinking.initialize_agent", report_immediately=False
            )

            # Check if bot config is available
            if "bot" in self.task_data and len(self.task_data["bot"]) > 0:
                bot_config = self.task_data["bot"][0]
                user_name = self.task_data.get("user", {}).get("name", "unknown")
                git_url = self.task_data.get("git_url", "")
                # Get config from bot
                agent_config = self._create_claude_model(
                    bot_config, user_name=user_name, git_url=git_url
                )
                if agent_config:
                    # Generate config files to task workspace directory
                    self._save_claude_config_files(agent_config)

                    # Download and deploy Skills if configured
                    self._download_and_deploy_skills(bot_config)
            else:
                logger.info("No bot config found for Claude Code Agent")

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Claude Code Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_failed", report_immediately=False
            )
            return TaskStatus.FAILED

    def _save_claude_config_files(self, agent_config: Dict[str, Any]) -> None:
        """
        Save Claude config files to appropriate directory based on execution mode.

        Delegates to the mode strategy which handles:
        - Docker mode: saves to ~/.claude/ (SDK reads from default location)
        - Local mode: Does NOT write settings.json (contains sensitive API keys).
          Sensitive config is passed via environment variables in _create_and_connect_client().
          Only writes non-sensitive claude.json (user preferences) with strict file permissions.

        Args:
            agent_config: The agent configuration dictionary
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

        # Delegate to mode strategy
        config_dir, env_config = self._mode_strategy.save_config_files(
            task_id=self.task_id,
            agent_config=agent_config,
            claude_json_config=claude_json_config,
        )

        # Store config directory and env config for SDK configuration
        self._claude_config_dir = config_dir
        self._claude_env_config = env_config

    def _resolve_env_value(self, value: str) -> str:
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

    def _create_claude_model(
        self, bot_config: Dict[str, Any], user_name: str = None, git_url: str = None
    ) -> Dict[str, Any]:
        """
        claude code settings: https://docs.claude.com/en/docs/claude-code/settings
        """
        agent_config = bot_config.get("agent_config", {})
        env = agent_config.get("env", {})
        # Using user-defined input model configuration
        if not env.get("model"):
            return agent_config

        model_id = env.get("model_id", "")

        # Extract API key and handle different formats:
        # 1. ${VAR_NAME} - environment variable template, replace with os.environ value
        # 2. Encrypted value - decrypt using decrypt_sensitive_data
        # 3. Plain value - use as-is
        api_key = env.get("api_key", "")
        api_key = self._resolve_env_value(api_key)

        # Note: ANTHROPIC_SMALL_FAST_MODEL is deprecated in favor of ANTHROPIC_DEFAULT_HAIKU_MODEL.
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
        if "post_create_claude_model" in self._hooks:
            try:
                final_claude_code_config_with_hook = self._hooks[
                    "post_create_claude_model"
                ](env_config, model_id, bot_config, user_name, git_url)
                logger.info("Applied post_create_claude_model hook")

                return final_claude_code_config_with_hook
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

    def _extract_claude_options(self, task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract Claude Code options from task data
        Collects all non-None configuration parameters from task_data

        Args:
            task_data: The task data dictionary

        Returns:
            Dict containing valid Claude Code options
        """
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
        options = {
            "setting_sources": ["user", "project", "local"],
            "max_buffer_size": 50 * 1024 * 1024,  # 50MB
        }
        bots = task_data.get("bot", [])
        bot_config = bots[0] if bots else {}
        # Extract all non-None parameters from bot_config
        if bot_config:
            # Extract MCP servers configuration
            mcp_servers = extract_mcp_servers_config(bot_config)
            if mcp_servers:
                # Replace placeholders in MCP servers config with actual values from task_data
                mcp_servers = replace_mcp_server_variables(mcp_servers, task_data)
                bot_config["mcp_servers"] = mcp_servers

            # Add system MCP server for subscription tasks (provides silent_exit tool)
            # System MCP config is injected by Backend via task_data
            system_mcp_config = task_data.get("system_mcp_config")
            if system_mcp_config and task_data.get("is_subscription"):
                if "mcp_servers" not in bot_config:
                    bot_config["mcp_servers"] = {}
                bot_config["mcp_servers"].update(system_mcp_config)
                logger.info(
                    f"Added system MCP server for subscription task: {list(system_mcp_config.keys())}"
                )

            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]

        return options

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution setup for Claude Code Agent

        Returns:
            TaskStatus: Pre-execution status
        """
        try:
            git_url = self.task_data.get("git_url")
            # Download code if git_url is provided
            if git_url and git_url != "":
                self.download_code()

                # Update cwd in options if not already set
                if (
                    "cwd" not in self.options
                    and self.project_path is not None
                    and os.path.exists(self.project_path)
                ):
                    self.options["cwd"] = self.project_path
                    logger.info(f"Set cwd to {self.project_path}")

            # Setup Claude Code custom instructions
            if self.project_path:
                try:
                    custom_rules = self._load_custom_instructions(self.project_path)
                    if custom_rules:
                        # Setup .claudecode directory for Claude Code compatibility
                        self._setup_claudecode_dir(self.project_path, custom_rules)

                        # Update .git/info/exclude to ignore .claudecode
                        self._update_git_exclude(self.project_path)

                        logger.info(
                            f"Setup Claude Code custom instructions with {len(custom_rules)} files"
                        )

                    # Setup Claude.md symlink from Agents.md if exists
                    self._setup_claude_md_symlink(self.project_path)

                except Exception as e:
                    logger.warning(f"Failed to process custom instructions: {e}")
                    # Continue execution with original systemPrompt

            # Setup SubAgent configuration files for coordinate mode
            # This is called outside the project_path check because coordinate mode
            # can work without a git repo (e.g., with attachments only)
            self._setup_coordinate_mode()

            # Download attachments for this task
            self._download_attachments()

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Pre-execution failed: {str(e)}")
            self.add_thinking_step(
                title="Pre-execution Failed",
                report_immediately=True,
                use_i18n_keys=False,
                details={"error": str(e)},
            )
            return TaskStatus.FAILED

    def execute(self) -> TaskStatus:
        """
        Execute the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            progress = 55
            progress = 55
            # Update current progress
            self._update_progress(progress)

            # Initialize state manager and workbench at task start
            self._initialize_state_manager()
            self.state_manager.initialize_workbench("running")

            # Report starting progress using state manager
            self.state_manager.report_progress(
                progress, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}"
            )

            # Check if this is a subscription task - subscription tasks need to wait for completion
            # so the container can exit properly after task finishes
            is_subscription = self.task_data.get("is_subscription", False)

            # Check if currently running in coroutine
            try:
                # Try to get current running event loop
                loop = asyncio.get_running_loop()
                # If we can get running event loop, we're in coroutine
                # Call async version directly
                logger.info(
                    "Detected running in an async context, calling execute_async"
                )

                if is_subscription:
                    # For subscription tasks, we need to wait for completion
                    # so the container can exit with proper status
                    logger.info(
                        "Subscription task detected, waiting for async execution to complete"
                    )
                    # Run in a new event loop in a separate thread to avoid blocking
                    # the current async context while still waiting for completion
                    import concurrent.futures

                    def run_async_task():
                        new_loop = asyncio.new_event_loop()
                        asyncio.set_event_loop(new_loop)
                        try:
                            return new_loop.run_until_complete(self._async_execute())
                        finally:
                            new_loop.close()

                    with concurrent.futures.ThreadPoolExecutor() as executor:
                        future = executor.submit(run_async_task)
                        result = future.result()
                        logger.info(
                            f"Subscription task async execution completed with status: {result}"
                        )
                        return result
                else:
                    # For non-subscription tasks, create background task and return immediately
                    asyncio.create_task(self.execute_async())
                    logger.info(
                        "Created async task for execution, returning RUNNING status"
                    )
                    return TaskStatus.RUNNING
            except RuntimeError:
                # No running event loop, can safely use run_until_complete
                logger.info("No running event loop detected, using new event loop")
                self.add_thinking_step(
                    title="Sync Execution",
                    report_immediately=False,
                    use_i18n_keys=False,
                )

                # Copy ContextVars before creating new event loop
                # ContextVars don't automatically propagate to new event loops
                try:
                    from shared.telemetry.context import (
                        copy_context_vars,
                        restore_context_vars,
                    )

                    saved_context = copy_context_vars()
                except ImportError:
                    saved_context = None

                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    # Restore ContextVars in the new event loop
                    if saved_context:
                        restore_context_vars(saved_context)
                    return loop.run_until_complete(self._async_execute())
                finally:
                    loop.close()
        except Exception as e:
            return self._handle_execution_error(e, "Claude Code Agent execution")

    @trace_async(
        span_name="claude_code_execute_async",
        tracer_name="executor.agents.claude_code",
        extract_attributes=_extract_claude_agent_attributes,
    )
    async def execute_async(self) -> TaskStatus:
        """
        Execute Claude Code Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Update current progress
            self._update_progress(60)

            # Initialize state manager and workbench if not already initialized
            if self.state_manager is None:
                self._initialize_state_manager()
                self.state_manager.initialize_workbench("running")

            # Report starting progress using state manager
            self.state_manager.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}"
            )

            # Add trace event for state manager initialization
            add_span_event("state_manager_initialized")

            return await self._async_execute()
        except Exception as e:
            return self._handle_execution_error(e, "Claude Code Agent async execution")

    async def _async_execute(self) -> TaskStatus:
        """
        Asynchronous execution of the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if task was cancelled before execution
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} was cancelled before execution")
                return TaskStatus.COMPLETED

            progress = 65
            # Update current progress
            self._update_progress(progress)

            # Check if a client connection already exists for the corresponding task_id
            if self.session_id in self._clients:
                cached_client = self._clients[self.session_id]

                # Verify the cached client is still valid
                # Check if client process is still running
                try:
                    if hasattr(cached_client, "_process") and cached_client._process:
                        if cached_client._process.poll() is not None:
                            # Process has terminated, remove from cache
                            logger.warning(
                                f"Cached client process terminated for session_id: {self.session_id}, creating new client"
                            )
                            del self._clients[self.session_id]
                            # Proceed to create new client
                        else:
                            # Process is still running, reuse client
                            logger.info(
                                f"Reusing existing Claude client for session_id: {self.session_id}"
                            )
                            self.add_thinking_step(
                                title="Reuse Existing Client",
                                report_immediately=False,
                                use_i18n_keys=False,
                                details={"session_id": self.session_id},
                            )
                            self.client = cached_client
                    else:
                        # No process info available, assume client is valid
                        logger.info(
                            f"Reusing existing Claude client for session_id: {self.session_id}"
                        )
                        self.client = cached_client
                except Exception as e:
                    logger.warning(
                        f"Error checking client validity: {e}, creating new client"
                    )
                    # Remove potentially invalid client from cache
                    if self.session_id in self._clients:
                        del self._clients[self.session_id]

            # Create new client if not reusing
            if self.client is None:
                await self._create_and_connect_client()

            # Check cancellation again before proceeding
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled during client setup")
                return TaskStatus.COMPLETED

            # Prepare prompt with skill emphasis if user selected skills
            prompt = self.prompt
            user_selected_skills = self.task_data.get("user_selected_skills", [])
            if user_selected_skills:
                skill_emphasis = self._build_skill_emphasis_prompt(user_selected_skills)
                prompt = skill_emphasis + "\n\n" + prompt
                logger.info(
                    f"Added skill emphasis for {len(user_selected_skills)} user-selected skills: {user_selected_skills}"
                )

            if self.options.get("cwd"):
                prompt = (
                    prompt + "\nCurrent working directory: " + self.options.get("cwd")
                )
                git_url = self.task_data.get("git_url")
                if git_url:
                    prompt = prompt + "\n project url:" + git_url

            progress = 75
            # Update current progress
            self._update_progress(progress)

            # Check cancellation before sending query
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled before sending query")
                return TaskStatus.COMPLETED

            # If new_session is True, create a new client with subtask_id as session_id
            # This is needed because different bots may have different skills, MCP servers, etc.
            # We keep the old client in cache for potential jump-back to previous bot
            if self.new_session:
                new_session_id = str(self.subtask_id)
                old_session_id = self.session_id
                self.session_id = new_session_id
                # Update the session_id_map cache for current bot
                self._session_id_map[self._internal_session_key] = new_session_id
                # Note: We do NOT close the old client here, because:
                # 1. Different bots have different skills/MCP servers, so we need separate clients
                # 2. Pipeline tasks may jump back to previous bots, which need their own clients
                # 3. The old client's session_id key is different from new one (task_id:bot_id format)
                # Create new client with current bot's configuration
                logger.info(
                    f"new_session=True, creating new client with subtask_id {new_session_id} as session_id "
                    f"(old: {old_session_id}, internal_key: {self._internal_session_key})"
                )
                await self._create_and_connect_client()

            # Use session_id to send messages, ensuring messages are in the same session
            # Use the current updated prompt for each execution, even with the same session ID
            logger.info(
                f"Sending query with prompt (length: {len(self.prompt)}) for session_id: {self.session_id}"
            )

            await self.client.query(prompt, session_id=self.session_id)

            logger.info(f"Waiting for response for prompt: {prompt}")
            # Process and handle the response using the external processor
            result = await process_response(
                self.client,
                self.state_manager,
                self.thinking_manager,
                self.task_state_manager,
                session_id=self.session_id,
            )

            # Update task state based on result
            if result == TaskStatus.COMPLETED:
                self.task_state_manager.set_state(self.task_id, TaskState.COMPLETED)
            elif result == TaskStatus.FAILED:
                self.task_state_manager.set_state(self.task_id, TaskState.FAILED)

            return result

        except Exception as e:
            return self._handle_execution_error(e, "async execution")

    async def _create_and_connect_client(self) -> None:
        """
        Create and connect a new Claude SDK client.
        Sets up the working directory if needed, creates the client with options,
        connects it, and stores it in the cache.

        Config files are generated in initialize() and passed via 'settings' parameter.
        """
        logger.info(f"Creating new Claude client for session_id: {self.session_id}")

        # Ensure working directory exists
        if self.options.get("cwd") is None or self.options.get("cwd") == "":
            cwd = os.path.join(config.get_workspace_root(), str(self.task_id))
            os.makedirs(cwd, exist_ok=True)
            self.options["cwd"] = cwd

        # Delegate mode-specific configuration to strategy
        if self._claude_config_dir:
            self.options = self._mode_strategy.configure_client_options(
                options=self.options,
                config_dir=self._claude_config_dir,
                env_config=self._claude_env_config,
            )

        # Check if there's a saved session ID to resume
        saved_session_id = self._load_saved_session_id(self.task_id)
        if saved_session_id:
            logger.info(
                f"Resuming Claude session for task {self.task_id}: {saved_session_id}"
            )
            self.options["resume"] = saved_session_id

        # Create client with options
        if self.options:
            code_options = ClaudeAgentOptions(**self.options)
            self.client = ClaudeSDKClient(options=code_options)
        else:
            self.client = ClaudeSDKClient()

        # Connect the client
        await self.client.connect()

        # Store client connection for reuse
        self._clients[self.session_id] = self.client

        # Update session_id_map for tracking (for both initial and new sessions)
        # This ensures cleanup_task_clients can find all clients by task_id
        if hasattr(self, "_internal_session_key"):
            self._session_id_map[self._internal_session_key] = self.session_id
            logger.info(
                f"Updated _session_id_map: {self._internal_session_key} -> {self.session_id}"
            )

        # Trigger callback to notify that client is created (e.g., for heartbeat update)
        if self.on_client_created_callback:
            try:
                if asyncio.iscoroutinefunction(self.on_client_created_callback):
                    await self.on_client_created_callback()
                else:
                    self.on_client_created_callback()
            except Exception as e:
                logger.warning(f"Error in on_client_created_callback: {e}")

        # Register client as a resource for cleanup
        self.resource_manager.register_resource(
            task_id=self.task_id,
            resource_id=f"claude_client_{self.session_id}",
            is_async=True,
        )

    def _handle_execution_result(
        self, result_content: str, execution_type: str = "execution"
    ) -> TaskStatus:
        """
        Handle the execution result and report progress

        Args:
            result_content: The content to handle
            execution_type: Type of execution for logging

        Returns:
            TaskStatus: Execution status
        """
        if result_content:
            logger.info(
                f"{execution_type} completed with content length: {len(result_content)}"
            )
            self.add_thinking_step(
                title="Execution Completed",
                report_immediately=False,
                use_i18n_keys=False,
                details={
                    "execution_type": execution_type,
                    "content_length": len(result_content),
                    "result_preview": (
                        result_content[:200] + "..."
                        if len(result_content) > 200
                        else result_content
                    ),
                },
            )
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                f"${{thinking.execution_completed}} {execution_type}",
                result=ExecutionResult(
                    value=result_content,
                    thinking=self.thinking_manager.get_thinking_steps(),
                ).dict(),
            )
            return TaskStatus.COMPLETED
        else:
            logger.warning(f"No content received from {execution_type}")
            self.add_thinking_step(
                title="Execution Failed",
                report_immediately=False,
                use_i18n_keys=False,
                details={"execution_type": execution_type},
            )
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"${{thinking.failed_no_content}} {execution_type}",
                result=ExecutionResult(
                    thinking=self.thinking_manager.get_thinking_steps()
                ).dict(),
            )
            return TaskStatus.FAILED

    def _handle_execution_error(
        self, error: Exception, execution_type: str = "execution"
    ) -> TaskStatus:
        """
        Handle execution error and report progress

        Args:
            error: The exception to handle
            execution_type: Type of execution for logging

        Returns:
            TaskStatus: Failed status
        """
        error_message = str(error)
        logger.exception(f"Error in {execution_type}: {error_message}")

        self.add_thinking_step(
            title="thinking.execution_failed",
            report_immediately=False,
            use_i18n_keys=False,
            details={"execution_type": execution_type, "error_message": error_message},
        )

        self.report_progress(
            100,
            TaskStatus.FAILED.value,
            f"${{thinking.execution_failed}} {execution_type}: {error_message}",
            result=ExecutionResult(
                thinking=self.thinking_manager.get_thinking_steps()
            ).dict(),
        )
        return TaskStatus.FAILED

    @classmethod
    async def close_client(cls, session_id: str) -> TaskStatus:
        try:
            if session_id in cls._clients:
                client = cls._clients[session_id]
                await client.disconnect()
                del cls._clients[session_id]
                logger.info(f"Closed Claude client for session_id: {session_id}")
                return TaskStatus.SUCCESS
            return TaskStatus.FAILED
        except Exception as e:
            logger.exception(
                f"Error closing client for session_id {session_id}: {str(e)}"
            )
            return TaskStatus.FAILED

    @classmethod
    async def close_all_clients(cls) -> None:
        """
        Close all client connections
        """
        for session_id, client in list(cls._clients.items()):
            try:
                await client.disconnect()
                logger.info(f"Closed Claude client for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()

    @classmethod
    async def cleanup_task_clients(cls, task_id: int) -> int:
        """
        Close all client connections for a specific task_id.

        Session keys can be in two formats:
        1. "task_id:bot_id" - for initial connections
        2. "subtask_id" - when new_session=True, uses subtask_id as session_id

        We check both _session_id_map (to find mapped session_ids) and
        _clients directly (for any remaining matches).

        Args:
            task_id: Task ID to cleanup clients for

        Returns:
            Number of clients cleaned up
        """
        cleaned_count = 0
        task_id_str = str(task_id)
        task_id_prefix = f"{task_id}:"

        # Debug: Log cleanup start
        logger.debug(f"[Cleanup] Starting cleanup for task_id={task_id}")
        logger.debug(
            f"[Cleanup] _session_id_map keys={list(cls._session_id_map.keys())}"
        )
        logger.debug(f"[Cleanup] _clients keys={list(cls._clients.keys())}")

        # Debug: Log current state
        logger.info(
            f"[Cleanup] Starting cleanup for task_id={task_id}, "
            f"_session_id_map keys={list(cls._session_id_map.keys())}, "
            f"_clients keys={list(cls._clients.keys())}"
        )

        # Step 1: Check _session_id_map to find all session_ids for this task
        internal_keys_to_cleanup = []
        logger.debug(
            f"[Cleanup] Checking _session_id_map for task_id_prefix={task_id_prefix}"
        )
        for internal_key, session_id in list(cls._session_id_map.items()):
            logger.debug(
                f"[Cleanup] Checking internal_key={internal_key}, session_id={session_id}"
            )
            if internal_key.startswith(task_id_prefix) or internal_key == task_id_str:
                logger.debug(f"[Cleanup] MATCH! Adding to cleanup list")
                internal_keys_to_cleanup.append((internal_key, session_id))
                logger.info(
                    f"[Cleanup] Found internal_key={internal_key} -> session_id={session_id} for task {task_id}"
                )
            else:
                logger.debug(f"[Cleanup] NO MATCH for internal_key={internal_key}")

        logger.debug(f"[Cleanup] internal_keys_to_cleanup={internal_keys_to_cleanup}")

        # Clean up clients found in _session_id_map
        logger.debug(
            f"[Cleanup] Starting to clean up {len(internal_keys_to_cleanup)} clients"
        )
        for internal_key, session_id in internal_keys_to_cleanup:
            logger.debug(
                f"[Cleanup] Processing internal_key={internal_key}, session_id={session_id}"
            )
            logger.debug(
                f"[Cleanup] Checking if session_id in _clients: {session_id in cls._clients}"
            )
            if session_id in cls._clients:
                logger.debug(
                    f"[Cleanup] Found client, attempting to terminate process..."
                )
                try:
                    client = cls._clients[session_id]

                    # Directly terminate the process instead of using disconnect()
                    # disconnect() has cancel scope issues when called from different asyncio context
                    logger.debug(f"[Cleanup] Accessing transport and process...")

                    # Get the process from the transport
                    if hasattr(client, "_transport") and client._transport:
                        transport = client._transport
                        if hasattr(transport, "_process") and transport._process:
                            process = transport._process
                            pid = process.pid if hasattr(process, "pid") else None
                            logger.debug(f"[Cleanup] Found process with PID={pid}")

                            # Try graceful termination first
                            try:
                                process.terminate()
                                logger.debug(
                                    f"[Cleanup] Sent SIGTERM to process PID={pid}"
                                )

                                # Wait briefly for process to exit
                                try:
                                    await asyncio.wait_for(process.wait(), timeout=2.0)
                                    logger.debug(
                                        f"[Cleanup] Process PID={pid} exited gracefully"
                                    )
                                except asyncio.TimeoutError:
                                    # Force kill if it doesn't exit
                                    logger.debug(
                                        f"[Cleanup] Process didn't exit, sending SIGKILL..."
                                    )
                                    process.kill()
                                    await asyncio.wait_for(process.wait(), timeout=1.0)
                                    logger.debug(f"[Cleanup] Process PID={pid} killed")

                                logger.info(
                                    f"Terminated Claude Code process for task_id={task_id}, session_id={session_id}, internal_key={internal_key}, PID={pid}"
                                )
                            except Exception as proc_error:
                                logger.debug(
                                    f"[Cleanup] Error terminating process: {proc_error}"
                                )
                                logger.warning(
                                    f"Error terminating process for session_id={session_id}: {proc_error}"
                                )
                        else:
                            logger.debug(f"[Cleanup] No process found in transport")
                            logger.warning(
                                f"No process found in transport for session_id={session_id}"
                            )
                    else:
                        logger.debug(f"[Cleanup] No transport found in client")
                        logger.warning(
                            f"No transport found in client for session_id={session_id}"
                        )

                    # Remove from _clients dict
                    logger.debug(f"[Cleanup] Removing from _clients...")
                    del cls._clients[session_id]
                    logger.debug(f"[Cleanup] Successfully cleaned up client!")
                    cleaned_count += 1
                except Exception as e:
                    logger.debug(f"[Cleanup] ERROR closing client: {e}")
                    logger.exception(
                        f"Error closing client for session_id {session_id}: {str(e)}"
                    )
            else:
                logger.debug(f"[Cleanup] session_id NOT in _clients!")
                logger.warning(
                    f"[Cleanup] session_id={session_id} not found in _clients for internal_key={internal_key}"
                )
            # Clean up the mapping
            try:
                del cls._session_id_map[internal_key]
            except KeyError:
                pass

        # Step 2: Also check _clients directly for any session_id that matches task_id pattern
        for session_id in list(cls._clients.keys()):
            if session_id.startswith(task_id_prefix) or session_id == task_id_str:
                if session_id not in [sid for _, sid in internal_keys_to_cleanup]:
                    try:
                        client = cls._clients[session_id]

                        # Directly terminate the process
                        if hasattr(client, "_transport") and client._transport:
                            transport = client._transport
                            if hasattr(transport, "_process") and transport._process:
                                process = transport._process
                                pid = process.pid if hasattr(process, "pid") else None

                                try:
                                    process.terminate()
                                    try:
                                        await asyncio.wait_for(
                                            process.wait(), timeout=2.0
                                        )
                                    except asyncio.TimeoutError:
                                        process.kill()
                                        await asyncio.wait_for(
                                            process.wait(), timeout=1.0
                                        )

                                    logger.info(
                                        f"Terminated Claude Code process (direct match) for task_id={task_id}, session_id={session_id}, PID={pid}"
                                    )
                                except Exception as proc_error:
                                    logger.warning(
                                        f"Error terminating process (direct match) for session_id={session_id}: {proc_error}"
                                    )

                        del cls._clients[session_id]
                        cleaned_count += 1
                    except Exception as e:
                        logger.exception(
                            f"Error closing client for session_id {session_id}: {str(e)}"
                        )

        if cleaned_count > 0:
            logger.info(f"Cleaned up {cleaned_count} client(s) for task_id={task_id}")
        else:
            logger.warning(
                f"[Cleanup] No clients found to cleanup for task_id={task_id}"
            )

        return cleaned_count

    def cancel_run(self) -> bool:
        """
        Cancel the current running task using multi-level cancellation strategy:
        1. Set cancellation state to CANCELLED immediately (not CANCELLING)
        2. Try SDK interrupt
        3. No longer send callback here, it will be sent asynchronously by background task to avoid blocking
        4. Wait briefly for cleanup

        Returns:
            bool: True if cancellation was successful, False otherwise
        """
        try:
            # Step 1: Immediately set to CANCELLED state (skip CANCELLING)
            # This ensures response_processor checks will immediately detect cancellation
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            logger.info(f"Task {self.task_id} marked as cancelled immediately")

            # Step 2: Try SDK interrupt if client is available
            if self.client and hasattr(self.client, "interrupt"):
                self._sync_cancel_run()
                logger.info(f"Sent interrupt signal to task {self.task_id}")
            else:
                logger.warning(
                    f"No client or interrupt method available for task {self.task_id}"
                )

            # Step 3: Wait briefly (2 seconds max) for graceful cleanup
            max_wait = min(config.GRACEFUL_SHUTDOWN_TIMEOUT, 2)
            waited = 0
            while waited < max_wait:
                # Check if cleanup completed (task state is None means cleaned up)
                if self.task_state_manager.get_state(self.task_id) is None:
                    logger.info(f"Task {self.task_id} cleaned up gracefully")
                    return True
                time.sleep(0.1)  # Check more frequently (100ms)
                waited += 0.1

            # Note: No longer send callback here
            # Callback will be sent asynchronously by background task in main.py to avoid blocking executor_manager's cancel request
            logger.info(
                f"Task {self.task_id} cancelled (cleanup may continue in background), callback will be sent asynchronously"
            )
            return True

        except Exception as e:
            logger.exception(f"Error cancelling task {self.task_id}: {e}")
            # Ensure cancelled state even on error
            self.task_state_manager.set_state(self.task_id, TaskState.CANCELLED)
            return False

    def _sync_cancel_run(self) -> None:
        """
        Synchronous helper method to cancel the current run
        """
        try:
            if self.client is not None:
                # Check if we're in an async context
                try:
                    loop = asyncio.get_running_loop()
                    # If we're in an async context, create a task
                    asyncio.create_task(self._async_cancel_run())
                except RuntimeError:
                    # No running event loop, run the async method in a new loop
                    # Copy ContextVars before creating new event loop
                    try:
                        from shared.telemetry.context import (
                            copy_context_vars,
                            restore_context_vars,
                        )

                        saved_context = copy_context_vars()
                    except ImportError:
                        saved_context = None

                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        # Restore ContextVars in the new event loop
                        if saved_context:
                            restore_context_vars(saved_context)
                        loop.run_until_complete(self._async_cancel_run())
                    finally:
                        loop.close()
        except Exception as e:
            logger.exception(
                f"Error during sync interrupt for session_id {self.session_id}: {str(e)}"
            )

    async def _async_cancel_run(self) -> None:
        """
        Asynchronous helper method to cancel the current run
        No longer send callback, handled by background task
        """
        try:
            if self.client is not None:
                await self.client.interrupt()
                # Note: No longer send callback here
                # Callback will be sent asynchronously by background task in main.py
                logger.info(
                    f"Successfully sent interrupt to client for session_id: {self.session_id}"
                )
        except Exception as e:
            logger.exception(
                f"Error during async interrupt for session_id {self.session_id}: {str(e)}"
            )

    def _setup_claudecode_dir(
        self, project_path: str, custom_rules: Dict[str, str]
    ) -> None:
        """
        Setup .claudecode directory with custom instruction files for Claude Code compatibility

        Args:
            project_path: Project root directory
            custom_rules: Dictionary of {file_path: content} for custom instruction files
        """
        try:
            claudecode_dir = os.path.join(project_path, ".claudecode")

            # Create .claudecode directory if it doesn't exist
            os.makedirs(claudecode_dir, exist_ok=True)
            logger.debug(f"Created .claudecode directory at {claudecode_dir}")

            # Copy custom instruction files to .claudecode directory
            for file_path, content in custom_rules.items():
                # Get just the filename (not the full path)
                filename = os.path.basename(file_path)
                target_path = os.path.join(claudecode_dir, filename)

                try:
                    with open(target_path, "w", encoding="utf-8") as f:
                        f.write(content)
                    logger.info(
                        f"Copied custom instruction file to .claudecode: {filename}"
                    )
                except Exception as e:
                    logger.warning(f"Failed to copy {filename} to .claudecode: {e}")

            logger.info(
                f"Setup .claudecode directory with {len(custom_rules)} custom instruction files"
            )

        except Exception as e:
            logger.warning(f"Failed to setup .claudecode directory: {e}")

    def _setup_claude_md_symlink(self, project_path: str) -> None:
        """
        Setup CLAUDE.md symlink from Agents.md or AGENTS.md if it exists
        Also adds CLAUDE.md to .git/info/exclude to prevent it from appearing in git diff

        Args:
            project_path: Project root directory
        """
        try:
            # Try to find agents file with case-insensitive search
            agents_filename = None
            for filename in ["AGENTS.md", "Agents.md", "agents.md"]:
                agents_path = os.path.join(project_path, filename)
                if os.path.exists(agents_path):
                    agents_filename = filename
                    break

            if not agents_filename:
                logger.debug(
                    "No agents.md file found (tried AGENTS.md, Agents.md, agents.md), skipping CLAUDE.md symlink creation"
                )
                return

            claude_md = os.path.join(project_path, "CLAUDE.md")

            # Remove existing CLAUDE.md if it exists
            if os.path.exists(claude_md):
                if os.path.islink(claude_md):
                    os.unlink(claude_md)
                    logger.debug("Removed existing CLAUDE.md symlink")
                else:
                    logger.debug(
                        "CLAUDE.md already exists as a regular file, skipping symlink creation"
                    )
                    return

            # Create symlink using the found filename
            os.symlink(agents_filename, claude_md)
            logger.info(f"Created CLAUDE.md symlink to {agents_filename}")

            # Add CLAUDE.md to .git/info/exclude to prevent it from appearing in git diff
            self._add_to_git_exclude(project_path, "CLAUDE.md")

        except Exception as e:
            logger.warning(f"Failed to create CLAUDE.md symlink: {e}")

    def _add_to_git_exclude(self, project_path: str, pattern: str) -> None:
        """
        Add a pattern to .git/info/exclude file

        Args:
            project_path: Project root directory
            pattern: Pattern to exclude (e.g., "CLAUDE.md")
        """
        try:
            exclude_file = os.path.join(project_path, ".git", "info", "exclude")

            # Check if .git directory exists
            git_dir = os.path.join(project_path, ".git")
            if not os.path.exists(git_dir):
                logger.debug(
                    ".git directory does not exist, skipping git exclude update"
                )
                return

            # Ensure .git/info directory exists
            info_dir = os.path.join(git_dir, "info")
            os.makedirs(info_dir, exist_ok=True)

            # Check if file exists and read content
            content = ""
            if os.path.exists(exclude_file):
                with open(exclude_file, "r", encoding="utf-8") as f:
                    content = f.read()

            # Check if pattern already exists
            if pattern in content:
                logger.debug(f"Pattern '{pattern}' already in {exclude_file}")
                return

            # Append pattern
            with open(exclude_file, "a", encoding="utf-8") as f:
                if content and not content.endswith("\n"):
                    f.write("\n")
                f.write(f"{pattern}\n")
            logger.info(f"Added '{pattern}' to .git/info/exclude")

        except Exception as e:
            logger.warning(f"Failed to add '{pattern}' to .git/info/exclude: {e}")

    def _download_attachments(self) -> None:
        """
        Download attachments from Backend API to workspace.

        This method downloads all attachments associated with the current subtask
        to a local directory, and updates the prompt to reference the local paths.
        Similar to _download_and_deploy_skills() but for attachments.
        """
        try:
            attachments = self.task_data.get("attachments", [])
            if not attachments:
                logger.debug("No attachments to download for this task")
                return

            logger.info(f"Found {len(attachments)} attachments to download")

            # Get auth token for API calls
            auth_token = self.task_data.get("auth_token")
            if not auth_token:
                logger.warning("No auth token available, cannot download attachments")
                return

            # Determine workspace path for attachments
            # Attachments should be stored in WORKSPACE_ROOT/task_id, not in the project path
            # This ensures attachments are accessible at /workspace/{task_id}:executor:attachments/...
            # instead of /workspace/{task_id}/{repo_name}/{task_id}:executor:attachments/...
            workspace = os.path.join(config.get_workspace_root(), str(self.task_id))

            # Import and use attachment downloader
            from executor.services.attachment_downloader import AttachmentDownloader
            from executor.services.attachment_prompt_processor import (
                AttachmentPromptProcessor,
            )

            downloader = AttachmentDownloader(
                workspace=workspace,
                task_id=str(self.task_id),
                subtask_id=str(self.subtask_id),
                auth_token=auth_token,
            )

            result = downloader.download_all(attachments)

            # Store download result for potential future use
            self._attachment_download_result = result

            # Process prompt to replace attachment references and add context
            if result.success or result.failed:
                # Replace [attachment:id] references with local paths
                self.prompt = AttachmentPromptProcessor.process_prompt(
                    self.prompt, result.success, result.failed
                )

                # Add context about available attachments
                attachment_context = AttachmentPromptProcessor.build_attachment_context(
                    result.success
                )
                if attachment_context:
                    self.prompt += attachment_context

                logger.info(f"Processed prompt with {len(result.success)} attachments")

                # Store image content blocks for potential vision support
                self._image_content_blocks = (
                    AttachmentPromptProcessor.build_image_content_blocks(result.success)
                )
                if self._image_content_blocks:
                    logger.info(
                        f"Built {len(self._image_content_blocks)} image content blocks"
                    )

            if result.success:
                self.add_thinking_step_by_key(
                    title_key="thinking.attachments_downloaded",
                    report_immediately=False,
                    details={"count": len(result.success)},
                )

            if result.failed:
                logger.warning(
                    f"Failed to download {len(result.failed)} attachments: "
                    f"{[a.get('original_filename') for a in result.failed]}"
                )

        except Exception as e:
            logger.error(f"Error downloading attachments: {e}")
            # Don't raise - attachment download failure shouldn't block task execution

    def _download_and_deploy_skills(self, bot_config: Dict[str, Any]) -> None:
        """
        Download Skills from Backend API and deploy to skills directory.

        Delegates to the mode strategy which handles:
        - Docker mode: deploys to ~/.claude/skills/, clears cache
        - Local mode: deploys to task config directory, preserves cache

        Uses shared SkillDownloader from api_client module.

        Args:
            bot_config: Bot configuration containing skills list
        """
        try:
            from executor.services.api_client import SkillDownloader

            # Extract skills list from bot_config (skills is at top level, not in spec)
            skills = bot_config.get("skills", [])
            if not skills:
                logger.debug("No skills configured for this bot")
                return

            logger.info(f"Found {len(skills)} skills to deploy: {skills}")

            # Get skills directory from strategy
            skills_dir = self._mode_strategy.get_skills_directory(
                config_dir=getattr(self, "_claude_config_dir", None)
            )

            # Get auth token
            auth_token = self.task_data.get("auth_token")
            if not auth_token:
                logger.warning("No auth token available, cannot download skills")
                return

            # Get team namespace for skill lookup
            team_namespace = self.task_data.get("team_namespace", "default")

            # Create downloader and deploy skills
            downloader = SkillDownloader(
                auth_token=auth_token,
                team_namespace=team_namespace,
                skills_dir=skills_dir,
            )

            # Get deployment options from strategy
            deployment_options = self._mode_strategy.get_skills_deployment_options()
            result = downloader.download_and_deploy(
                skills=skills,
                clear_cache=deployment_options["clear_cache"],
                skip_existing=deployment_options["skip_existing"],
            )

            logger.info(
                f"Skills deployment complete: {result.success_count}/{result.total_count} "
                f"deployed to {result.skills_dir}"
            )

        except Exception as e:
            logger.error(f"Error in _download_and_deploy_skills: {str(e)}")
            # Don't raise - skills deployment failure shouldn't block task execution

    def _setup_coordinate_mode(self) -> None:
        """
        Setup SubAgent configuration files for coordinate mode.

        In coordinate mode with multiple bots, the Leader (bot[0]) coordinates
        work among members (bot[1:]). This method generates .claude/agents/*.md
        configuration files for each member bot so that Claude Code can invoke
        them as SubAgents.

        SubAgent config files are placed in {target_path}/.claude/agents/ where
        target_path is determined by priority:
        1. self.project_path (if git repo was cloned)
        2. self.options["cwd"] (if already set)
        3. Default workspace: /workspace/{task_id}
        """
        bots = self.task_data.get("bot", [])
        mode = self.task_data.get("mode")

        # Only setup for coordinate mode with multiple bots
        if mode != "coordinate" or len(bots) <= 1:
            logger.debug(
                f"Skipping SubAgent setup: mode={mode}, bots_count={len(bots)}"
            )
            return

        # Determine target path for SubAgent configs
        # Priority: project_path > options["cwd"] > default workspace
        target_path = self.project_path or self.options.get("cwd")
        if not target_path:
            # Create default workspace directory
            target_path = os.path.join(config.get_workspace_root(), str(self.task_id))
            os.makedirs(target_path, exist_ok=True)
            # Also update options["cwd"] so Claude Code uses this directory
            self.options["cwd"] = target_path
            logger.info(
                f"Created default workspace for SubAgent configs: {target_path}"
            )

        # Leader is bot[0], members are bot[1:]
        member_bots = bots[1:]

        if not member_bots:
            logger.debug("Skipping SubAgent setup: no member bots after leader")
            return

        # Create .claude/agents directory
        agents_dir = os.path.join(target_path, ".claude", "agents")
        os.makedirs(agents_dir, exist_ok=True)

        # Generate SubAgent config file for each member
        for bot in member_bots:
            self._generate_subagent_file(agents_dir, bot)

        # Add to git exclude to prevent showing in git diff (only if .git exists)
        self._add_to_git_exclude(target_path, ".claude/agents/")

        logger.info(
            f"Generated {len(member_bots)} SubAgent config files for coordinate mode in {agents_dir}"
        )

    def _generate_subagent_file(self, agents_dir: str, bot: Dict[str, Any]) -> None:
        """
        Generate SubAgent Markdown configuration file.

        The generated file follows Claude Code's SubAgent format with YAML frontmatter
        containing name, description, and model settings.

        Args:
            agents_dir: Path to the .claude/agents directory
            bot: Bot configuration dictionary containing name, system_prompt, etc.
        """
        # Normalize bot name for filename (lowercase, replace spaces/underscores with hyphens)
        raw_name = bot.get("name", "unnamed")
        bot_id = bot.get("id", "")
        # Remove unsafe filesystem characters and normalize
        name = (
            re.sub(r"[^\w\s-]", "", raw_name)
            .lower()
            .replace("_", "-")
            .replace(" ", "-")
        )
        # Ensure name is not empty after sanitization
        if not name:
            name = "unnamed"
        # Append bot ID to prevent filename collisions (e.g., "My Bot" vs "my_bot")
        if bot_id:
            name = f"{name}-{bot_id}"

        # Get system prompt from bot config
        system_prompt = bot.get("system_prompt", "")

        # Generate description from bot name or use existing description
        description = bot.get("description") or f"Handle tasks related to {raw_name}"

        # Escape YAML special characters in description to prevent parsing issues
        # Wrap in double quotes and escape internal quotes
        escaped_description = description.replace('"', '\\"').replace("\n", " ")
        escaped_description = f'"{escaped_description}"'

        # Build SubAgent config content
        # - model: inherit -> use same model as Leader (inherit from parent)
        # - tools: omitted -> inherits all tools from Leader (per Claude Code docs)
        content = f"""---
name: {name}
description: {escaped_description}
model: inherit
---

{system_prompt}
"""

        filepath = os.path.join(agents_dir, f"{name}.md")
        try:
            with open(filepath, "w", encoding="utf-8") as f:
                f.write(content)
            logger.info(f"Generated SubAgent config: {filepath}")
        except Exception as e:
            logger.warning(f"Failed to generate SubAgent config for {raw_name}: {e}")

    def _build_skill_emphasis_prompt(self, user_selected_skills: List[str]) -> str:
        """
        Build skill emphasis prompt for user-selected skills.

        When users explicitly select skills in the frontend, this method generates
        a prompt prefix that emphasizes these skills, encouraging the model to
        prioritize using them.

        Args:
            user_selected_skills: List of skill names that the user explicitly selected

        Returns:
            str: Skill emphasis prompt to prepend to the user's message
        """
        if not user_selected_skills:
            return ""

        # Build skill list with emphasis markers
        skill_list = "\n".join(
            f"  - **{skill}** [USER SELECTED - PRIORITIZE]"
            for skill in user_selected_skills
        )

        emphasis_prompt = f"""## User-Selected Skills

The user has explicitly selected the following skills for this task. You should **prioritize using these skills** when they are relevant to the task:

{skill_list}

**Important**: These skills were specifically chosen by the user. When the task can benefit from these skills, prefer to use them over other approaches.

---

"""
        return emphasis_prompt
