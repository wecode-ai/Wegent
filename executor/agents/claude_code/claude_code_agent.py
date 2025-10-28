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

    def add_thinking_step(self, title: str, action: str, reasoning: str,
                         result: str = "", confidence: float = -1,
                         next_action: str = "continue", report_immediately: bool = True) -> None:
        """
        Add a thinking step

        Args:
            title: Step title
            action: Action description
            reasoning: Reasoning process
            result: Result (optional)
            confidence: Confidence level (0.0-1.0, default -1)
            next_action: Next action (default "continue")
            report_immediately: Whether to report this thinking step immediately (default True)
        """
        self.thinking_manager.add_thinking_step(
            title, action, reasoning, result, confidence, next_action, report_immediately
        )
    
    def add_thinking_step_by_key(self, title_key: str, action_key: str, reasoning_key: str,
                                result_key: str = "", confidence: float = -1,
                                next_action_key: str = "thinking.continue",
                                report_immediately: bool = True) -> None:
        """
        Add a thinking step using i18n key

        Args:
            title_key: i18n key for step title
            action_key: i18n key for action description
            reasoning_key: i18n key for reasoning process
            result_key: i18n key for result (optional)
            confidence: Confidence level (0.0-1.0, default -1)
            next_action_key: i18n key for next action (default "thinking.continue")
            report_immediately: Whether to report this thinking step immediately (default True)
        """
        self.thinking_manager.add_thinking_step_by_key(
            title_key, action_key, reasoning_key, result_key,
            confidence, next_action_key, report_immediately
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
                title_key="thinking.claude.initialize_agent",
                action_key="thinking.claude.starting_initialization",
                reasoning_key="thinking.claude.initializing_with_config",
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

            self.add_thinking_step_by_key(
                title_key="thinking.claude.initialize_completed",
                action_key="thinking.claude.initialization_success",
                reasoning_key="thinking.claude.agent_ready",
                result_key="thinking.claude.initialization_success",
                confidence=0.9,
                next_action_key="thinking.continue",
                report_immediately=False
            )

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Claude Code Agent: {str(e)}")
            self.add_thinking_step_by_key(
                title_key="thinking.claude.initialize_failed",
                action_key="thinking.claude.failed_initialize",
                reasoning_key=f"${{thinking.claude.initialization_error}} {str(e)}",
                next_action_key="thinking.exit",
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
            self.add_thinking_step(
                title="Pre-execution Setup",
                action="Starting pre-execution setup",
                reasoning="Setting up environment",
                report_immediately=True
            )

            git_url = self.task_data.get("git_url")
            # Download code if git_url is provided
            if git_url and git_url != "":
                self.add_thinking_step(
                    title="Download Code",
                    action=f"${{thinking.downloading_code_from}} {self.task_data['git_url']}",
                    reasoning="Code download is required for the task",
                    report_immediately=True
                )
                self.download_code()
                self.add_thinking_step(
                    title="Download Code Completed",
                    action="Code download completed successfully",
                    reasoning="Code has been downloaded and is ready for execution",
                    result="Code downloaded successfully",
                    report_immediately=True
                )

                # Update cwd in options if not already set
                if "cwd" not in self.options and self.project_path is not None and os.path.exists(self.project_path):
                    self.options["cwd"] = self.project_path
                    logger.info(f"Set cwd to {self.project_path}")
                    self.add_thinking_step(
                        title="Set Working Directory",
                        action=f"${{thinking.setting_working_directory}} {self.project_path}",
                        reasoning="Working directory has been set to the downloaded code path",
                        result=f"Working directory set to {self.project_path}",
                        report_immediately=True
                    )

            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Pre-execution failed: {str(e)}")
            self.add_thinking_step(
                title="Pre-execution Failed",
                action="Pre-execution setup failed",
                reasoning=f"Pre-execution failed with error: {str(e)}",
                next_action="exit",
                report_immediately=True
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
            self.add_thinking_step(
                title="Execute Task",
                action="Starting task execution",
                reasoning="Beginning the execution of the Claude Code Agent task",
                report_immediately=False
            )
            # Update current progress
            self._update_progress(progress)
            # Report starting progress
            self.report_progress(
                progress, TaskStatus.RUNNING.value, "${{thinking.claude.starting_agent}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
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
                self.add_thinking_step(
                    title="Async Execution",
                    action="Detected async context, switching to async execution",
                    reasoning="Running in coroutine context, will execute asynchronously",
                    report_immediately=True
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
                    action="No async context detected, creating new event loop",
                    reasoning="Not in coroutine context, will create new event loop for execution",
                    report_immediately=False
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
            self.add_thinking_step(
                title="Async Execution Started",
                action="Starting asynchronous execution",
                reasoning="Task is now executing in async mode",
                report_immediately=False)
            # Update current progress
            self._update_progress(60)
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "${{thinking.claude.starting_agent_async}}", result=ExecutionResult(thinking=self.thinking_manager.get_thinking_steps()).dict()
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
                    action=f"${{thinking.claude.reusing_client_session}} {self.session_id}",
                    reasoning="Client already exists for this session, reusing to maintain context",
                    report_immediately=False
                )
                self.client = self._clients[self.session_id]
            else:
                # Create new client connection
                logger.info(
                    f"Creating new Claude client for session_id: {self.session_id}"
                )
                self.add_thinking_step(
                    title="Create New Client",
                    action=f"${{thinking.claude.creating_client_session}} session_id: {self.session_id}",
                    reasoning="No existing client found for this session, creating a new one",
                    report_immediately=False
                )
                logger.info(f"Initializing Claude client with options: {self.options}")
                if self.options:
                    code_options = ClaudeAgentOptions(**self.options)
                    self.client = ClaudeSDKClient(options=code_options)
                else:
                    self.client = ClaudeSDKClient()

                # Connect the client
                await self.client.connect()

                self.add_thinking_step(
                    title="thinking.claude.client_created_successfully",
                    action="thinking.claude.client_stored_reuse",
                    reasoning="thinking.claude.client_reuse_session",
                    result="thinking.claude.client_created_successfully",
                    report_immediately=False
                )

                # Store client connection for reuse
                self._clients[self.session_id] = self.client

            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd") + "\n project url:"+ self.task_data.get("git_url")

            progress = 75
            # Update current progress
            self._update_progress(progress)
            self.add_thinking_step(
                title="Prepare Prompt",
                action="Preparing execution prompt",
                reasoning=f"${{thinking.claude.prepared_prompt_with_info}} {prompt[:100]}...",
                report_immediately=False
            )

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
                action=f"Completed {execution_type}",
                reasoning=f"{execution_type} completed successfully with content length: {len(result_content)}",
                result=result_content[:200] + "..." if len(result_content) > 200 else result_content,
                confidence=0.9,
                next_action="complete",
                report_immediately=False
            )
            self.report_progress(
                100,
                TaskStatus.COMPLETED.value,
                f"${{thinking.claude.execution_completed}} {execution_type}",
                result=ExecutionResult(value=result_content, thinking=self.thinking_manager.get_thinking_steps()).dict(),
            )
            return TaskStatus.COMPLETED
        else:
            logger.warning(f"No content received from {execution_type}")
            self.add_thinking_step(
                title="Execution Failed",
                action=f"{execution_type} failed - no content received",
                reasoning=f"{execution_type} completed but no content was returned",
                next_action="exit",
                report_immediately=False
            )
            self.report_progress(
                100,
                TaskStatus.FAILED.value,
                f"${{thinking.claude.failed_no_content}} {execution_type}",
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
            title="Execution Error",
            action=f"{execution_type} encountered an error",
            reasoning=f"Error occurred during {execution_type}: {error_message}",
            next_action="exit",
            report_immediately=False
        )

        self.report_progress(
            100,
            TaskStatus.FAILED.value,
            f"${{thinking.claude.execution_failed}} {execution_type}: {error_message}",
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
