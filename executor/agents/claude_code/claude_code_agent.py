#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import json
import random
import string
from typing import Dict, Any
from pathlib import Path

from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions
from executor.agents.claude_code.response_processor import process_response
from executor.agents.base import Agent
from shared.logger import setup_logger
from shared.status import TaskStatus

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

    def get_name(self) -> str:
        return "ClaudeCode"

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

        # Extract Claude Code options from task_data
        self.options = self._extract_claude_options(task_data)
        self.options["permission_mode"] = "bypassPermissions"

        # Set git-related environment variables
        self._set_git_env_variables(task_data)

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
        
        # Determine wecode-model-id: use last segment if model_id contains comma, otherwise use model_id as is
        wecode_model_id = model_id.split(",")[-1].strip() if "," in model_id else model_id
        
        env_config = {
            "ANTHROPIC_MODEL": model_id,
            "ANTHROPIC_SMALL_FAST_MODEL": env.get("small_model", model_id),
            "ANTHROPIC_AUTH_TOKEN": env.get("api_key", ""),
            "ANTHROPIC_CUSTOM_HEADERS": f"wecode-user: {user_name}\nwecode-model-id: {wecode_model_id}\nwecode-action: claude-code\ngit_url: {git_url}",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": 1,
        }
        
        if model_id == 'wecode,sina-glm-4.5':
            env_config["CLAUDE_CODE_MAX_OUTPUT_TOKENS"] = 96000
        
        base_url = env.get("base_url", "")
        if base_url:
            env_config["ANTHROPIC_BASE_URL"] = base_url.removesuffix("/v1")

        final_claude_code_config = {
            "env": env_config,
            "includeCoAuthoredBy": False,
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
        # Download code if git_url is provided
        if "git_url" in self.task_data:
            self.download_code()

            # Update cwd in options if not already set
            if "cwd" not in self.options and self.project_path is not None and os.path.exists(self.project_path):
                self.options["cwd"] = self.project_path
                logger.info(f"Set cwd to {self.project_path}")

        return TaskStatus.SUCCESS

    def execute(self) -> TaskStatus:
        """
        Execute the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Report starting progress
            self.report_progress(
                55, TaskStatus.RUNNING.value, "Starting Claude Code Agent"
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
                loop = asyncio.new_event_loop()
                asyncio.set_event_loop(loop)
                try:
                    return loop.run_until_complete(self._async_execute())
                finally:
                    loop.close()
        except Exception as e:
            logger.exception(f"Error executing Claude Code Agent: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def execute_async(self) -> TaskStatus:
        """
        Execute Claude Code Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "Starting Claude Code Agent (async)"
            )
            return await self._async_execute()
        except Exception as e:
            logger.exception(
                f"Error executing Claude Code Agent asynchronously: {str(e)}"
            )
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Async execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def _async_execute(self) -> TaskStatus:
        """
        Asynchronous execution of the Claude Code Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if a client connection already exists for the corresponding task_id
            if self.session_id in self._clients:
                logger.info(
                    f"Reusing existing Claude client for session_id: {self.session_id}"
                )
                self.client = self._clients[self.session_id]
            else:
                # Create new client connection
                logger.info(
                    f"Creating new Claude client for session_id: {self.session_id}"
                )
                logger.info(f"Initializing Claude client with options: {self.options}")
                if self.options:
                    code_options = ClaudeAgentOptions(**self.options)
                    self.client = ClaudeSDKClient(options=code_options)
                else:
                    self.client = ClaudeSDKClient()

                # Connect the client
                await self.client.connect()

                # Store client connection for reuse
                self._clients[self.session_id] = self.client

            # Use session_id to send messages, ensuring messages are in the same session
            # Use the current updated prompt for each execution, even with the same session ID
            logger.info(
                f"Sending query with prompt (length: {len(self.prompt)}) for session_id: {self.session_id}"
            )
            
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd") + "\n project url:"+ self.task_data.get("git_url")
            await self.client.query(prompt, session_id=self.session_id)

            logger.info(f"Waiting for response for prompt: {prompt}")
            # Process and handle the response using the external processor
            return await process_response(self.client, self.report_progress)

        except Exception as e:
            logger.exception(f"Error in async execution: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Execution failed: {str(e)}"
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
