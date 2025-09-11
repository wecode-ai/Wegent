#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import os
import json
from typing import Dict, Any, Optional, List, Union, Tuple
from pathlib import Path

from claude_code_sdk import ClaudeSDKClient, ClaudeCodeOptions
from claude_code_sdk.types import Message
from executor.agents.claude_code.response_processor import process_response
from shared.utils import git_util
from executor.agents.base import Agent
from shared.logger import setup_logger
from executor.config import config
from shared.status import TaskStatus

logger = setup_logger("claude_code_agent")


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
            if "bot" in self.task_data and "agent_config" in self.task_data["bot"]:
                # Get config from bot
                agent_config = self.task_data["bot"]["agent_config"]
                if agent_config:
                    # Ensure ~/.claude directory exists
                    claude_dir = os.path.expanduser("~/.claude")
                    Path(claude_dir).mkdir(parents=True, exist_ok=True)

                    # Save config to settings.json
                    settings_path = os.path.join(claude_dir, "settings.json")
                    with open(settings_path, "w") as f:
                        json.dump(agent_config, f, indent=2)
                    logger.info(f"Saved Claude Code settings to {settings_path}")
            else:
                logger.info("No bot config found for Claude Code Agent")
            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Claude Code Agent: {str(e)}")
            return TaskStatus.FAILED

    def _extract_claude_options(self, task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract Claude Code options from task data
        Collects all non-None configuration parameters from task_data

        Args:
            task_data: The task data dictionary

        Returns:
            Dict containing valid Claude Code options
        """
        # List of valid options for ClaudeCodeOptions
        valid_options = [
            "allowed_tools",
            "max_thinking_tokens",
            "system_prompt",
            "append_system_prompt",
            "mcp_tools",
            "mcp_servers",
            "permission_mode",
            "continue_conversation",
            "resume",
            "max_turns",
            "disallowed_tools",
            "model",
            "permission_prompt_tool_name",
            "cwd",
        ]

        # Collect all non-None configuration parameters
        options = {}
        bot_config = task_data.get("bot", {})

        # Extract all non-None parameters from bot_config
        if bot_config:
            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]

        if options.get("system_prompt"):
            options["append_system_prompt"] = options.pop("system_prompt")
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
                    code_options = ClaudeCodeOptions(**self.options)
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
