#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import json
import importlib
import random
import string
import subprocess
import re
import time
from typing import Dict, Any, List, Optional
from pathlib import Path
from datetime import datetime

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from executor.agents.claude_code.response_processor import process_response
from executor.agents.claude_code.progress_state_manager import ProgressStateManager
from executor.agents.base import Agent
from executor.agents.agno.thinking_step_manager import ThinkingStepManager
from executor.config import config
from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.models.task import ThinkingStep, ExecutionResult
from shared.utils.crypto import is_token_encrypted, decrypt_git_token
from shared.utils.sensitive_data_masker import mask_sensitive_data
from shared.telemetry.decorators import trace_async, add_span_event

from executor.utils.mcp_utils import extract_mcp_servers_config
from executor.tasks.task_state_manager import TaskStateManager, TaskState
from executor.tasks.resource_manager import ResourceManager

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
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=64))


class ClaudeCodeAgent(Agent):
    """
    Claude Code Agent that integrates with Claude Code SDK
    """

    # Static dictionary for storing client connections to enable connection reuse
    _clients: Dict[str, ClaudeSDKClient] = {}
    
    # Static dictionary for storing hook functions
    _hooks: Dict[str, Any] = {}

    def get_name(self) -> str:
        return "ClaudeCode"

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
            logger.debug("No hook configuration file found at /app/config/claude_hooks.json")
            return
            
        try:
            with open(hook_config_path, 'r') as f:
                hook_config = json.load(f)
                logger.info(f"Loading hook configuration from {hook_config_path}")
                
                for hook_name, hook_path in hook_config.items():
                    try:
                        # Parse module path and function name
                        module_path, func_name = hook_path.rsplit('.', 1)
                        # Dynamically import the module
                        module = importlib.import_module(module_path)
                        # Get the function from the module
                        hook_func = getattr(module, func_name)
                        # Store the hook function
                        cls._hooks[hook_name] = hook_func
                        logger.info(f"Successfully loaded hook: {hook_name} from {hook_path}")
                    except Exception as e:
                        logger.warning(f"Failed to load hook {hook_name} from {hook_path}: {e}")
        except Exception as e:
            logger.warning(f"Failed to load hook configuration from {hook_config_path}: {e}")

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the Claude Code Agent

        Args:
            task_data: The task data dictionary
        """
        super().__init__(task_data)
        self.client = None
        self.session_id = self.task_id
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
        self.thinking_manager = ThinkingStepManager(progress_reporter=self.report_progress)
        
        # Initialize progress state manager - will be fully initialized when task starts
        self.state_manager: Optional[ProgressStateManager] = None
        
        # Initialize task state manager and resource manager
        self.task_state_manager = TaskStateManager()
        self.resource_manager = ResourceManager()
        
        # Set initial task state to RUNNING
        self.task_state_manager.set_state(self.task_id, TaskState.RUNNING)

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
            "git_url": "GIT_URL"
        }
        
        env_values = {}
        for source_key, env_key in git_fields.items():
            value = task_data.get(source_key)
            if value is not None:
                os.environ[env_key] = str(value)
                env_values[env_key] = value
                
        if env_values:
            logger.info(f"Set git environment variables: {env_values}")

        # Configure GitLab CLI authentication if git_domain is available
        git_domain = task_data.get("git_domain")
        if not git_domain:
            logger.warning("No git_domain provided, skipping CLI authentication.")
            return

        git_token = self._get_git_token(git_domain, task_data)
        if not git_token:
            logger.warning(f"No valid token found for {git_domain}, skipping authentication.")
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
            logger.info(f"{'GitHub' if is_github else 'GitLab'} CLI authenticated for {git_domain}")
            if result.stdout.strip():
                logger.debug(f"CLI output: {result.stdout.strip()}")

        except subprocess.CalledProcessError as e:
            stderr = e.stderr.strip() if e.stderr else str(e)
            logger.warning(f"CLI authentication failed for {git_domain}: {stderr}")
        except Exception as e:
            logger.warning(f"Unexpected error during CLI authentication for {git_domain}: {e}")

    def _configure_repo_proxy(self, git_domain: str) -> None:
        """
        Configure repository CLI proxy settings using REPO_PROXY_CONFIG env mapping.

        The REPO_PROXY_CONFIG environment variable should contain JSON with domains
        as keys and proxy definitions (http_proxy/https_proxy) as values.
        """
        proxy_config_raw = os.getenv("REPO_PROXY_CONFIG")
        if not proxy_config_raw:
            logger.info("No REPO_PROXY_CONFIG environment variable set, skipping proxy configuration.")
            return

        try:
            proxy_config = json.loads(proxy_config_raw)
        except json.JSONDecodeError as e:
            logger.warning(f"Invalid REPO_PROXY_CONFIG JSON: {e}")
            return

        domain_config = proxy_config.get(git_domain) or proxy_config.get(git_domain.lower()) or proxy_config.get("*")
        if not isinstance(domain_config, dict):
            logger.info(f"No proxy configuration found for domain {git_domain}")
            return

        proxy_values = {
            key.lower(): value
            for key, value in domain_config.items()
            if key.lower() in {"http.proxy", "https.proxy"} and value
        }

        if not proxy_values:
            logger.info(f"Proxy configuration for domain {git_domain} is empty, skipping.")
            return

        for proxy_key, proxy_value in proxy_values.items():
            cmd = f'git config --global {proxy_key} {proxy_value}'
            try:
                subprocess.run(
                    cmd,
                    shell=True,
                    capture_output=True,
                    text=True,
                    check=True,
                )
                logger.info(f"Configured environment {proxy_key} for domain {git_domain}")
            except subprocess.CalledProcessError as e:
                stderr = e.stderr.strip() if e.stderr else str(e)
                logger.warning(f"Proxy configuration failed: {stderr}")

    def _get_git_token(self, git_domain: str, task_data: Dict[str, Any]) -> Optional[str]:
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
                        logger.debug(f"Decrypting git token from file for domain: {git_domain}")
                        return decrypt_git_token(token)
                    return token
            except Exception as e:
                logger.warning(f"Failed to read token from {token_path}: {e}")
        return None
    def add_thinking_step(self, title: str, action: str = "", reasoning: str = "",
                         result: str = "", confidence: float = -1,
                         next_action: str = "continue", report_immediately: bool = True,
                         use_i18n_keys: bool = False, details: Optional[Dict[str, Any]] = None) -> None:
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
            details=details
        )
    
    def add_thinking_step_by_key(self, title_key: str, report_immediately: bool = True, details: Optional[Dict[str, Any]] = None) -> None:
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
            title_key=title_key,
            report_immediately=report_immediately,
            details=details
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
                project_path=project_path
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
        Saves the bot configuration to ~/.claude/settings.json if available.

        Returns:
            TaskStatus: Initialization status
        """
        try:
            # Check if task was cancelled before initialization
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} was cancelled before initialization")
                return TaskStatus.COMPLETED
            
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_agent",
                report_immediately=False
            )

            # Check if bot config is available
            if "bot" in self.task_data and len(self.task_data["bot"]) > 0:
                bot_config = self.task_data["bot"][0]
                user_name = self.task_data["user"]["name"]
                git_url = self.task_data["git_url"]
                # Get config from bot
                agent_config = self._create_claude_model(bot_config, user_name=user_name, git_url=git_url)
                if agent_config:
                    # Ensure ~/.claude directory exists
                    claude_dir = os.path.expanduser("~/.claude")
                    Path(claude_dir).mkdir(parents=True, exist_ok=True)

                    # Save config to settings.json
                    settings_path = os.path.join(claude_dir, "settings.json")
                    with open(settings_path, "w") as f:
                        json.dump(agent_config, f, indent=2)
                    logger.info(f"Saved Claude Code settings to {settings_path}")
                    
                    # Save claude.json config
                    claude_json_path = os.path.expanduser("~/.claude.json")
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
                        "isQualifiedForDataSharing": False
                    }
                    with open(claude_json_path, "w") as f:
                        json.dump(claude_json_config, f, indent=2)
                    logger.info(f"Saved Claude Code config to {claude_json_path}")

                    # Download and deploy Skills if configured
                    self._download_and_deploy_skills(bot_config)
            else:
                logger.info("No bot config found for Claude Code Agent")

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Claude Code Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.initialize_failed",
                report_immediately=False
            )
            return TaskStatus.FAILED


    def _create_claude_model(self, bot_config: Dict[str, Any], user_name: str = None, git_url: str = None) -> Dict[str, Any]:
        """
        claude code settings: https://docs.claude.com/en/docs/claude-code/settings
        """
        agent_config = bot_config.get("agent_config", {})
        env = agent_config.get("env", {})
        # Using user-defined input model configuration
        if not env.get("model"):
            return agent_config
        
        model_id = env.get("model_id", "")
        
        # Note: ANTHROPIC_SMALL_FAST_MODEL is deprecated in favor of ANTHROPIC_DEFAULT_HAIKU_MODEL. 
        env_config = {
            "ANTHROPIC_MODEL": model_id,
            "ANTHROPIC_SMALL_FAST_MODEL": env.get("small_model", model_id),
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": env.get("small_model", model_id),
            "ANTHROPIC_AUTH_TOKEN": env.get("api_key", ""),
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": int(os.getenv("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "0")),
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
                final_claude_code_config_with_hook = self._hooks["post_create_claude_model"](
                    env_config, model_id, bot_config, user_name, git_url
                )
                logger.info("Applied post_create_claude_model hook")
                logger.info(f"Created Claude Code model config with hook: {mask_sensitive_data(final_claude_code_config_with_hook)}")
        
                return final_claude_code_config_with_hook
            except Exception as e:
                logger.warning(f"Hook execution failed: {e}")

        final_claude_code_config = {
            "env": env_config,
            "includeCoAuthoredBy": os.getenv("CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY", "true").lower() != "false",
        }
        logger.info(f"Created Claude Code model config: {mask_sensitive_data(final_claude_code_config)}")
        
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
        ]

        logger.info(f"Extracting Claude options from task data: {mask_sensitive_data(task_data)}")

        # Collect all non-None configuration parameters
        options = {
            "setting_sources": ["user", "project", "local"]
        }
        bots = task_data.get("bot", [])
        bot_config = bots[0]
        # Extract all non-None parameters from bot_config
        if bot_config:
            # Extract MCP servers configuration
            mcp_servers = extract_mcp_servers_config(bot_config)
            if mcp_servers:
                logger.info(f"Detected MCP servers configuration: {mcp_servers}")
                bot_config["mcp_servers"] = mcp_servers

            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]

        logger.info(f"Extracted Claude options: {mask_sensitive_data(options)}")
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
                if "cwd" not in self.options and self.project_path is not None and os.path.exists(self.project_path):
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

                        logger.info(f"Setup Claude Code custom instructions with {len(custom_rules)} files")

                    # Setup Claude.md symlink from Agents.md if exists
                    self._setup_claude_md_symlink(self.project_path)

                except Exception as e:
                    logger.warning(f"Failed to process custom instructions: {e}")
                    # Continue execution with original systemPrompt

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Pre-execution failed: {str(e)}")
            self.add_thinking_step(
                title="Pre-execution Failed",
                report_immediately=True,
                use_i18n_keys=False,
                details={"error": str(e)}
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
            # Check if currently running in coroutine
            try:
                # Try to get current running event loop
                loop = asyncio.get_running_loop()
                # If we can get running event loop, we're in coroutine
                # Call async version directly
                logger.info(
                    "Detected running in an async context, calling execute_async"
                )
                # Create async task to run in background, but return PENDING instead of task object
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
                    use_i18n_keys=False
                )
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    return loop.run_until_complete(self._async_execute())
                finally:
                    loop.close()
        except Exception as e:
            return self._handle_execution_error(e, "Claude Code Agent execution")

    @trace_async(
        span_name="claude_code_execute_async",
        tracer_name="executor.agents.claude_code",
        extract_attributes=_extract_claude_agent_attributes
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
                    if hasattr(cached_client, '_process') and cached_client._process:
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
                                details={"session_id": self.session_id}
                            )
                            self.client = cached_client
                    else:
                        # No process info available, assume client is valid
                        logger.info(
                            f"Reusing existing Claude client for session_id: {self.session_id}"
                        )
                        self.client = cached_client
                except Exception as e:
                    logger.warning(f"Error checking client validity: {e}, creating new client")
                    # Remove potentially invalid client from cache
                    if self.session_id in self._clients:
                        del self._clients[self.session_id]

            # Create new client if not reusing
            if self.client is None:
                # Create new client connection
                logger.info(
                    f"Creating new Claude client for session_id: {self.session_id}"
                )
                logger.info(f"Initializing Claude client with options: {mask_sensitive_data(self.options)}")

                if self.options.get("cwd") is None or self.options.get("cwd") == "":
                    cwd =os.path.join(config.WORKSPACE_ROOT, str(self.task_id))
                    os.makedirs(cwd, exist_ok=True)
                    self.options["cwd"] = cwd

                if self.options:
                    code_options = ClaudeAgentOptions(**self.options)
                    self.client = ClaudeSDKClient(options=code_options)
                else:
                    self.client = ClaudeSDKClient()

                # Connect the client
                await self.client.connect()

                # Store client connection for reuse
                self._clients[self.session_id] = self.client
                
                # Register client as a resource for cleanup
                self.resource_manager.register_resource(
                    task_id=self.task_id,
                    resource_id=f"claude_client_{self.session_id}",
                    is_async=True
                )

            # Check cancellation again before proceeding
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled during client setup")
                return TaskStatus.COMPLETED

            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd") + "\n project url:"+ self.task_data.get("git_url")

            progress = 75
            # Update current progress
            self._update_progress(progress)
            
            # Check cancellation before sending query
            if self.task_state_manager.is_cancelled(self.task_id):
                logger.info(f"Task {self.task_id} cancelled before sending query")
                return TaskStatus.COMPLETED
            
            # Use session_id to send messages, ensuring messages are in the same session
            # Use the current updated prompt for each execution, even with the same session ID
            logger.info(
                f"Sending query with prompt (length: {len(self.prompt)}) for session_id: {self.session_id}"
            )

            await self.client.query(prompt, session_id=self.session_id)

            logger.info(f"Waiting for response for prompt: {prompt}")
            # Process and handle the response using the external processor
            result = await process_response(
                self.client, self.state_manager, self.thinking_manager, 
                self.task_state_manager, session_id=self.session_id
            )
            
            # Update task state based on result
            if result == TaskStatus.COMPLETED:
                self.task_state_manager.set_state(self.task_id, TaskState.COMPLETED)
            elif result == TaskStatus.FAILED:
                self.task_state_manager.set_state(self.task_id, TaskState.FAILED)
            
            return result

        except Exception as e:
            return self._handle_execution_error(e, "async execution")

    def _handle_execution_result(self, result_content: str, execution_type: str = "execution") -> TaskStatus:
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
                    "result_preview": result_content[:200] + "..." if len(result_content) > 200 else result_content
                }
            )
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                f"${{thinking.execution_completed}} {execution_type}",
                result=ExecutionResult(value=result_content, thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
            return TaskStatus.COMPLETED
        else:
            logger.warning(f"No content received from {execution_type}")
            self.add_thinking_step(
                title="Execution Failed",
                report_immediately=False,
                use_i18n_keys=False,
                details={"execution_type": execution_type}
            )
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"${{thinking.failed_no_content}} {execution_type}",
                result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
            return TaskStatus.FAILED

    def _handle_execution_error(self, error: Exception, execution_type: str = "execution") -> TaskStatus:
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
            details={
                "execution_type": execution_type,
                "error_message": error_message
            }
        )

        self.report_progress(
            100,
            TaskStatus.FAILED.value,
            f"${{thinking.execution_failed}} {execution_type}: {error_message}",
            result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
        )
        return TaskStatus.FAILED

    @classmethod
    async def close_client(cls, session_id: str) -> TaskStatus:
        try:
            if session_id in cls._clients:
                client = cls._clients[session_id]
                await client.close()
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
                await client.close()
                logger.info(f"Closed Claude client for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()

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
            if self.client and hasattr(self.client, 'interrupt'):
                self._sync_cancel_run()
                logger.info(f"Sent interrupt signal to task {self.task_id}")
            else:
                logger.warning(f"No client or interrupt method available for task {self.task_id}")

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
            logger.info(f"Task {self.task_id} cancelled (cleanup may continue in background), callback will be sent asynchronously")
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
                    loop = asyncio.new_event_loop()
                    asyncio.set_event_loop(loop)
                    try:
                        loop.run_until_complete(self._async_cancel_run())
                    finally:
                        loop.close()
        except Exception as e:
            logger.exception(f"Error during sync interrupt for session_id {self.session_id}: {str(e)}")

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
                logger.info(f"Successfully sent interrupt to client for session_id: {self.session_id}")
        except Exception as e:
            logger.exception(f"Error during async interrupt for session_id {self.session_id}: {str(e)}")
    

    def _setup_claudecode_dir(self, project_path: str, custom_rules: Dict[str, str]) -> None:
        """
        Setup .claudecode directory with custom instruction files for Claude Code compatibility

        Args:
            project_path: Project root directory
            custom_rules: Dictionary of {file_path: content} for custom instruction files
        """
        try:
            import shutil
            
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
                    with open(target_path, 'w', encoding='utf-8') as f:
                        f.write(content)
                    logger.info(f"Copied custom instruction file to .claudecode: {filename}")
                except Exception as e:
                    logger.warning(f"Failed to copy {filename} to .claudecode: {e}")
            
            logger.info(f"Setup .claudecode directory with {len(custom_rules)} custom instruction files")
            
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
                logger.debug("No agents.md file found (tried AGENTS.md, Agents.md, agents.md), skipping CLAUDE.md symlink creation")
                return

            claude_md = os.path.join(project_path, "CLAUDE.md")

            # Remove existing CLAUDE.md if it exists
            if os.path.exists(claude_md):
                if os.path.islink(claude_md):
                    os.unlink(claude_md)
                    logger.debug("Removed existing CLAUDE.md symlink")
                else:
                    logger.debug("CLAUDE.md already exists as a regular file, skipping symlink creation")
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
                logger.debug(".git directory does not exist, skipping git exclude update")
                return
            
            # Ensure .git/info directory exists
            info_dir = os.path.join(git_dir, "info")
            os.makedirs(info_dir, exist_ok=True)
            
            # Check if file exists and read content
            content = ""
            if os.path.exists(exclude_file):
                with open(exclude_file, 'r', encoding='utf-8') as f:
                    content = f.read()
            
            # Check if pattern already exists
            if pattern in content:
                logger.debug(f"Pattern '{pattern}' already in {exclude_file}")
                return
            
            # Append pattern
            with open(exclude_file, 'a', encoding='utf-8') as f:
                if content and not content.endswith('\n'):
                    f.write('\n')
                f.write(f"{pattern}\n")
            logger.info(f"Added '{pattern}' to .git/info/exclude")

        except Exception as e:
            logger.warning(f"Failed to add '{pattern}' to .git/info/exclude: {e}")

    def _download_and_deploy_skills(self, bot_config: Dict[str, Any]) -> None:
        """
        Download Skills from Backend API and deploy to ~/.claude/skills/.

        Args:
            bot_config: Bot configuration containing skills list
        """
        try:
            # Extract skills list from bot_config (skills is at top level, not in spec)
            skills = bot_config.get("skills", [])
            if not skills:
                logger.debug("No skills configured for this bot")
                return

            logger.info(f"Found {len(skills)} skills to deploy: {skills}")

            # Prepare skills directory
            skills_dir = os.path.expanduser("~/.claude/skills")

            # Clear existing skills directory
            if os.path.exists(skills_dir):
                import shutil
                shutil.rmtree(skills_dir)
                logger.info(f"Cleared existing skills directory: {skills_dir}")

            Path(skills_dir).mkdir(parents=True, exist_ok=True)

            # Get API base URL and auth token from task_data
            api_base_url = os.getenv("TASK_API_DOMAIN", "http://wegent-backend:8000").rstrip("/")
            auth_token = self.task_data.get("auth_token")

            if not auth_token:
                logger.warning("No auth token available, cannot download skills")
                return
            
            logger.info(f"Auth token available for skills download")

            # Download each skill
            import requests
            import zipfile
            import io
            import shutil

            success_count = 0
            for skill_name in skills:
                try:
                    logger.info(f"Downloading skill: {skill_name}")

                    # Get skill by name
                    list_url = f"{api_base_url}/api/v1/kinds/skills?name={skill_name}"
                    headers = {"Authorization": f"Bearer {auth_token}"}

                    response = requests.get(list_url, headers=headers, timeout=30)
                    if response.status_code != 200:
                        logger.error(f"Failed to query skill '{skill_name}': HTTP {response.status_code}")
                        continue

                    skills_data = response.json()
                    skill_items = skills_data.get("items", [])

                    if not skill_items:
                        logger.error(f"Skill '{skill_name}' not found")
                        continue

                    # Extract skill ID from labels
                    skill_item = skill_items[0]
                    skill_id = skill_item.get("metadata", {}).get("labels", {}).get("id")

                    if not skill_id:
                        logger.error(f"Skill '{skill_name}' has no ID in metadata")
                        continue

                    # Download skill ZIP
                    download_url = f"{api_base_url}/api/v1/kinds/skills/{skill_id}/download"
                    response = requests.get(download_url, headers=headers, timeout=60)

                    if response.status_code != 200:
                        logger.error(f"Failed to download skill '{skill_name}': HTTP {response.status_code}")
                        continue

                    # Extract ZIP to ~/.claude/skills/
                    # The ZIP structure is: skill-name.zip -> skill-name/SKILL.md
                    # We extract to skills_dir, which will create skills_dir/skill-name/
                    import zipfile
                    with zipfile.ZipFile(io.BytesIO(response.content)) as zip_file:
                        # Security check: prevent Zip Slip attacks
                        for file_info in zip_file.filelist:
                            if file_info.filename.startswith('/') or '..' in file_info.filename:
                                logger.error(f"Unsafe file path in skill ZIP: {file_info.filename}")
                                break
                        else:
                            # Extract all files to skills_dir
                            # This will create skills_dir/skill-name/ automatically
                            zip_file.extractall(skills_dir)
                            skill_target_dir = os.path.join(skills_dir, skill_name)
                            
                            # Verify the skill folder was created
                            if os.path.exists(skill_target_dir) and os.path.isdir(skill_target_dir):
                                logger.info(f"Deployed skill '{skill_name}' to {skill_target_dir}")
                                success_count += 1
                            else:
                                logger.error(f"Skill folder '{skill_name}' not found after extraction")

                except Exception as e:
                    logger.warning(f"Failed to download skill '{skill_name}': {str(e)}")
                    continue

            if success_count > 0:
                logger.info(f"Successfully deployed {success_count}/{len(skills)} skills to {skills_dir}")
            else:
                logger.warning("No skills were successfully deployed")

        except Exception as e:
            logger.error(f"Error in _download_and_deploy_skills: {str(e)}")
            # Don't raise - skills deployment failure shouldn't block task execution

