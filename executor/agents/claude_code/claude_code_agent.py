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
from typing import Dict, Any, List, Optional
from pathlib import Path

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from executor.agents.claude_code.response_processor import process_response
from executor.agents.base import Agent
from executor.agents.agno.thinking_step_manager import ThinkingStepManager
from executor.config import config
from shared.logger import setup_logger
from shared.status import TaskStatus
from shared.models.task import ThinkingStep, ExecutionResult

from utils.mcp_utils import extract_mcp_servers_config

logger = setup_logger("claude_code_agent")


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
        if git_domain:
            token_path = os.path.expanduser(f"~/.ssh/{git_domain}")
            if os.path.exists(token_path):
                try:
                    cmd = f"glab auth login --hostname {git_domain} --token $(cat {token_path})"
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True, check=True)
                    logger.info(f"GitLab CLI authentication successful for domain: {git_domain}")
                    if result.stdout:
                        logger.info(f"glab auth output: {result.stdout.strip()}")
                except subprocess.CalledProcessError as e:
                    error_msg = e.stderr if e.stderr else str(e)
                    logger.warning(f"GitLab CLI authentication failed for {git_domain}: {error_msg}")
                except Exception as e:
                    logger.warning(f"GitLab CLI authentication failed with unexpected error for {git_domain}: {str(e)}")
            else:
                logger.info(f"Token file not found at {token_path}, skipping GitLab CLI authentication")

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
        
        env_config = {
            "ANTHROPIC_MODEL": model_id,
            "ANTHROPIC_SMALL_FAST_MODEL": env.get("small_model", model_id),
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
                logger.info(f"Created Claude Code model config with hook: {final_claude_code_config_with_hook}")
        
                return final_claude_code_config_with_hook
            except Exception as e:
                logger.warning(f"Hook execution failed: {e}")

        final_claude_code_config = {
            "env": env_config,
            "includeCoAuthoredBy": os.getenv("CLAUDE_CODE_INCLUDE_CO_AUTHORED_BY", "true").lower() != "false",
        }
        logger.info(f"Created Claude Code model config: {final_claude_code_config}")
        
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

        logger.info(f"Extracting Claude options from task data: {task_data}")

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

        logger.info(f"Extracted Claude options: {options}")
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
            # Update current progress
            self._update_progress(progress)
            # Report starting progress
            self.report_progress(
                progress, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
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
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.initialize_agent}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
            )
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
            progress = 65
            # Update current progress
            self._update_progress(progress)

            # Check if a client connection already exists for the corresponding task_id
            if self.session_id in self._clients:
                logger.info(
                    f"Reusing existing Claude client for session_id: {self.session_id}"
                )
                self.add_thinking_step(
                    title="Reuse Existing Client",
                    report_immediately=False,
                    use_i18n_keys=False,
                    details={"session_id": self.session_id}
                )
                self.client = self._clients[self.session_id]
            else:
                # Create new client connection
                logger.info(
                    f"Creating new Claude client for session_id: {self.session_id}"
                )
                logger.info(f"Initializing Claude client with options: {self.options}")

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

            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd") + "\n project url:"+ self.task_data.get("git_url")

            progress = 75
            # Update current progress
            self._update_progress(progress)
            # Use session_id to send messages, ensuring messages are in the same session
            # Use the current updated prompt for each execution, even with the same session ID
            logger.info(
                f"Sending query with prompt (length: {len(self.prompt)}) for session_id: {self.session_id}"
            )

            await self.client.query(prompt, session_id=self.session_id)

            logger.info(f"Waiting for response for prompt: {prompt}")
            # Process and handle the response using the external processor
            return await process_response(self.client, self._report_progress_with_thinking, self.thinking_manager)

        except Exception as e:
            return self._handle_execution_error(e, "async execution")

    def _report_progress_with_thinking(self, progress: int, status: str, message: str, result: Dict[str, Any] = None) -> None:
        """
        Report progress including thinking steps

        Args:
            progress: Progress value (0-100)
            status: Task status
            message: Progress message
            result: Result data (optional)
        """
        # If result is not None, ensure it includes thinking steps
        if result is not None:
            # If result doesn't have thinking, add current thinking steps
            if "thinking" not in result:
                result["thinking"] = [step.dict() for step in self.thinking_manager.get_thinking_steps()]
        else:
            # If result is None, create a result containing thinking steps
            result = ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()

        self.report_progress(progress, status, message, result=result)

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
