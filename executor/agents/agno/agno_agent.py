#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

import asyncio
import json
import os
from typing import Dict, Any, Optional

from agno.team import Team
from agno.agent import Agent as AgnoSDKAgent
from agno.db.sqlite import SqliteDb
from executor.agents.base import Agent
from executor.config.config import EXECUTOR_ENV, DEBUG_RUN
from shared.logger import setup_logger
from shared.status import TaskStatus

from .config_utils import ConfigManager
from .member_builder import MemberBuilder
from .model_factory import ModelFactory
from .mcp_manager import MCPManager
from .team_builder import TeamBuilder

db = SqliteDb(db_file="/tmp/agno_data.db")
logger = setup_logger("agno_agent")


class AgnoAgent(Agent):
    """
    Agno Agent that integrates with Agno SDK
    """

    # Static dictionary for storing client connections to enable connection reuse
    _clients: Dict[str, Any] = {}

    def get_name(self) -> str:
        return "Agno"

    def __init__(self, task_data: Dict[str, Any]):
        """
        Initialize the Agno Agent

        Args:
            task_data: The task data dictionary
        """
        super().__init__(task_data)
        self.client = None
        self.session_id = self.task_id
        self.prompt = task_data.get("prompt", "")
        self.project_path = None

        self.team: Optional[Team] = None
        self.single_agent: Optional[AgnoSDKAgent] = None

        self.mode = task_data.get("mode", "")
        self.task_data = task_data

        # Initialize configuration manager
        self.config_manager = ConfigManager(EXECUTOR_ENV)
        
        # Extract Agno options from task_data
        self.options = self.config_manager.extract_agno_options(task_data)
        
        # Initialize team builder
        self.team_builder = TeamBuilder(db, self.config_manager)

        # Initialize member builder
        self.member_builder = MemberBuilder(db, self.config_manager)

        # debug mode
        self.debug_mode: bool = DEBUG_RUN != ""

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
        Initialize the Agno Agent with configuration from task_data.

        Returns:
            TaskStatus: Initialization status
        """
        try:
            logger.info("Initializing Agno Agent")
            return TaskStatus.SUCCESS
        except Exception as e:
            logger.error(f"Failed to initialize Agno Agent: {str(e)}")
            return TaskStatus.FAILED

    async def _create_agent(self) -> Optional[AgnoSDKAgent]:
        """
        Create a team with configured members
        """
        agents = await self.member_builder.create_members_from_config(self.options["team_members"], self.task_data)
        if len(agents) < 0:
            return None
        return agents[0]

    async def _create_team(self) -> Optional[Team]:
        """
        Create a team with configured members
        """
        return await self.team_builder.create_team(self.options, self.mode, self.session_id, self.task_data)

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution setup for Agno Agent

        Returns:
            TaskStatus: Pre-execution status
        """
        # Download code if git_url is provided
        try:
            if "git_url" in self.task_data:
                self.download_code()
        except:
            return TaskStatus.SUCCESS

        return TaskStatus.SUCCESS

    def execute(self) -> TaskStatus:
        """
        Execute the Agno Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Report starting progress
            self.report_progress(
                55, TaskStatus.RUNNING.value, "Starting Agno Agent"
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
            logger.exception(f"Error executing Agno Agent: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def execute_async(self) -> TaskStatus:
        """
        Execute Agno Agent task asynchronously
        Use this method instead of execute() when called in async context

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Report starting progress
            self.report_progress(
                60, TaskStatus.RUNNING.value, "Starting Agno Agent (async)"
            )
            return await self._async_execute()
        except Exception as e:
            logger.exception(
                f"Error executing Agno Agent asynchronously: {str(e)}"
            )
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Async execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def _async_execute(self) -> TaskStatus:
        """
        Asynchronous execution of the Agno Agent task

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Check if a team already exists for the corresponding task_id
            if self.session_id in self._clients:
                logger.info(
                    f"Reusing existing Agno team for session_id: {self.session_id}"
                )
                tmp = self._clients[self.session_id]
                if isinstance(tmp, Team):
                    self.team = tmp
                elif isinstance(tmp, AgnoSDKAgent):
                    self.single_agent = tmp

            else:
                # Create new team
                logger.info(
                    f"Creating new Agno team for session_id: {self.session_id}"
                )
                self.team = await self._create_team()
                if self.team is not None:
                    # Store team for reuse
                    self._clients[self.session_id] = self.team
                else:
                    self.single_agent = await self._create_agent()
                    self._clients[self.session_id] = self.single_agent

            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd")
            if self.task_data.get("git_url"):
                prompt = prompt + "\nProject URL: " + self.task_data.get("git_url")

            logger.info(f"Executing Agno team with prompt: {prompt}")

            # Execute the team run
            result = await self._run_async(prompt)

            return result

        except Exception as e:
            logger.exception(f"Error in async execution: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def _run_async(self, prompt: str) -> TaskStatus:
        if self.team:
            logger.info("_run_team_async")
            return await self._run_team_async(prompt)
        elif self.single_agent:
            logger.info("_run_agent_async")
            return await self._run_agent_async(prompt)
        else:
            logger.error(f"The team and agent is None.")
            return TaskStatus.FAILED

    async def _run_agent_async(self, prompt: str) -> TaskStatus:
        """
        Run the agent asynchronously with the given prompt

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            # Run to completion (non-streaming) and gather final output
            result = await self.single_agent.arun(
                prompt,
                stream=False,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2
            )

            # Normalize the result into a string
            result_content: str = ""
            try:
                logger.info(f"agent run success. result:{json.dumps(result.to_dict())}")
                if result is None:
                    result_content = ""
                elif hasattr(result, "content") and getattr(result, "content") is not None:
                    result_content = str(getattr(result, "content"))
                elif hasattr(result, "to_dict"):
                    result_content = json.dumps(result.to_dict(), ensure_ascii=False)
                else:
                    result_content = str(result)
            except Exception:
                # Fallback to string coercion
                result_content = str(result)

            if result_content:
                logger.info(
                    f"Agent execution completed with content length: {len(result_content)}"
                )
                self.report_progress(
                    100,
                    TaskStatus.COMPLETED.value,
                    "Agno execution completed",
                    result={"value": result_content},
                )
                return TaskStatus.COMPLETED
            else:
                logger.warning("No content received from team execution")
                self.report_progress(
                    100,
                    TaskStatus.FAILED.value,
                    "No content received from team execution",
                )
                return TaskStatus.FAILED

        except Exception as e:
            logger.exception(f"Error running agent: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Agent execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    async def _run_team_async(self, prompt: str) -> TaskStatus:
        """
        Run the team asynchronously with the given prompt

        Args:
            prompt: The prompt to execute

        Returns:
            TaskStatus: Execution status
        """
        try:
            ext_config = {}
            if self.mode == "coordinate":
                ext_config = {
                    "show_full_reasoning": True,
                }

            # Run to completion (non-streaming) and gather final output
            result = await self.team.arun(
                prompt,
                stream=False,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=self.debug_mode,
                debug_level=2,
                show_members_responses=True,
                stream_intermediate_steps=True,
                markdown=True,
                **ext_config
            )

            # Normalize the result into a string
            result_content: str = ""
            try:
                logger.info(f"team run success. result:{json.dumps(result.to_dict(), ensure_ascii=False)}")
                if result is None:
                    result_content = ""
                elif hasattr(result, "content") and getattr(result, "content") is not None:
                    result_content = str(getattr(result, "content"))
                elif hasattr(result, "to_dict"):
                    result_content = json.dumps(result.to_dict(), ensure_ascii=False)
                else:
                    result_content = str(result)
            except Exception:
                # Fallback to string coercion
                result_content = str(result)

            if result_content:
                logger.info(
                    f"Team execution completed with content length: {len(result_content)}"
                )
                self.report_progress(
                    100,
                    TaskStatus.COMPLETED.value,
                    "Agno team execution completed",
                    result={"value": result_content},
                )
                return TaskStatus.COMPLETED
            else:
                logger.warning("No content received from team execution")
                self.report_progress(
                    100,
                    TaskStatus.FAILED.value,
                    "No content received from team execution",
                )
                return TaskStatus.FAILED

        except Exception as e:
            logger.exception(f"Error running team: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Team execution failed: {str(e)}"
            )
            return TaskStatus.FAILED

    @classmethod
    async def close_client(cls, session_id: str) -> TaskStatus:
        try:
            if session_id in cls._clients:
                team = cls._clients[session_id]
                # Clean up team resources if needed
                team.cancel_run(session_id)
                del cls._clients[session_id]
                logger.info(f"Closed Agno team for session_id: {session_id}")
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
        for session_id, team in list(cls._clients.items()):
            try:
                # Clean up team resources if needed
                team.cancel_run(session_id)
                logger.info(f"Closed Agno team for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()
    
    async def cleanup(self) -> None:
        """
        Clean up resources used by the agent
        """
        await self.team_builder.cleanup()
