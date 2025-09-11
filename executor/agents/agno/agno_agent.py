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

from agno.agent import Agent as AgnoSdkAgent
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from agno.team import Team
from agno.tools.mcp import MCPTools
from agno.tools.mcp import StreamableHTTPClientParams
from executor.agents.agno.response_processor import process_response
from executor.agents.base import Agent
from shared.logger import setup_logger
from executor.config import config
from shared.status import TaskStatus

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
        self.team = None
        self.mcp_tools = None

        # Extract Agno options from task_data
        self.options = self._extract_agno_options(task_data)

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

    def _extract_agno_options(self, task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Extract Agno options from task data
        Collects all non-None configuration parameters from task_data

        Args:
            task_data: The task data dictionary

        Returns:
            Dict containing valid Agno options
        """
        # List of valid options for Agno
        valid_options = [
            "model",
            "model_id",
            "api_key",
            "system_prompt",
            "tools",
            "mcp_servers",
            "mcpServers",
            "team_members",
            "team_description",
        ]

        # Collect all non-None configuration parameters
        options = {}
        bot_config = task_data.get("bot", {})

        # Extract all non-None parameters from bot_config
        if bot_config:
            for key in valid_options:
                if key in bot_config and bot_config[key] is not None:
                    options[key] = bot_config[key]

        logger.info(f"Extracted Agno options: {options}")
        return options

    def _get_model(self):
        """
        Get the model configuration based on options
        """
        model_config = self.options.get("model", "claude")
        
        if model_config == "claude":
            return Claude(
                id=self.options.get("model_id", os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")),
                api_key=self.options.get("api_key", os.environ.get("ANTHROPIC_API_KEY")),
            )
        elif model_config == "openai":
            return OpenAIChat(
                id=self.options.get("model_id", os.environ.get("OPENAI_MODEL", "gpt-4")),
                api_key=self.options.get("api_key", os.environ.get("OPENAI_API_KEY")),
            )
        else:
            # Default to Claude
            return Claude(
                id=os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022"),
                api_key=os.environ.get("ANTHROPIC_API_KEY"),
            )

    def _setup_mcp_tools(self) -> Optional[List[MCPTools]]:
        """
        Setup MCP tools if configured
        """
        mcp_servers = self.options.get("mcp_servers")
        if not mcp_servers:
            return None

        mcp_tools_list = []
        
        try:
            # Handle dict format where keys are server names and values are server configs
            if isinstance(mcp_servers, dict):
                logger.info(f"MCP Tools configured for servers: {mcp_servers}")
                for server_name, server_config in mcp_servers.items():
                    # Skip if server_config is not a dict
                    if not isinstance(server_config, dict):
                        continue
                    
                    # Extract server parameters
                    server_params = StreamableHTTPClientParams(
                        url=server_config.get("url"),
                        headers=server_config.get("headers", {})
                    )
                    mcp_tools = MCPTools(transport="streamable-http", server_params=server_params)
                    mcp_tools_list.append(mcp_tools)
                
                return mcp_tools_list if mcp_tools_list else None
                
            # Handle list format for backward compatibility
            elif isinstance(mcp_servers, list) and len(mcp_servers) > 0:
                # Use the first server in the list
                server_config = mcp_servers[0]

                server_params = StreamableHTTPClientParams(
                    url=server_config.get("url"),
                    headers=server_config.get("headers", {})
                )
                mcp_tools = MCPTools(transport="streamable-http", server_params=server_params)
                mcp_tools_list.append(mcp_tools)
                return mcp_tools_list
        except Exception as e:
            logger.error(f"Failed to setup MCP tools: {str(e)}")
        
        return None

    async def _create_team(self) -> Team:
        """
        Create a team with configured members
        """
        model = self._get_model()
        team_members = []
        
        # Setup MCP tools if available
        self.mcp_tools = self._setup_mcp_tools()

        logger.info("start Setting up MCP tools")
        if self.mcp_tools:
            logger.info("Setting up MCP tools")
            # Connect all MCP tools in the list
            for mcp_tool in self.mcp_tools:
                await mcp_tool.connect()
        
        # Create team members based on configuration
        team_members_config = self.options.get("team_members")
        if team_members_config:
            if isinstance(team_members_config, list):
                for member_config in team_members_config:
                    member = AgnoSdkAgent(
                        name=member_config.get("name", "TeamMember"),
                        model=model,
                        tools=self.mcp_tools if self.mcp_tools else [],
                        description=member_config.get("description", "Team member")
                    )
                    team_members.append(member)
            else:
                # Single member configuration
                member = AgnoSdkAgent(
                    name=team_members_config.get("name", "TeamMember"),
                    model=model,
                    tools=self.mcp_tools if self.mcp_tools else [],
                    description=team_members_config.get("description", "Team member")
                )
                team_members.append(member)
        else:
            # Default team member
            member = AgnoSdkAgent(
                name="DefaultAgent",
                model=model,
                tools=self.mcp_tools if self.mcp_tools else [],
                description="Default team member"
            )
            team_members.append(member)

        # Create team
        team = Team(
            name=self.options.get("team_name", "AgnoTeam"),
            members=team_members,
            model=model,
            description=self.options.get("team_description", "Agno team for task execution")
        )
        
        return team

    def pre_execute(self) -> TaskStatus:
        """
        Pre-execution setup for Agno Agent

        Returns:
            TaskStatus: Pre-execution status
        """
        # Download code if git_url is provided
        if "git_url" in self.task_data:
            self.download_code()

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
                self.team = self._clients[self.session_id]
            else:
                # Create new team
                logger.info(
                    f"Creating new Agno team for session_id: {self.session_id}"
                )
                self.team = await self._create_team()

                # Store team for reuse
                self._clients[self.session_id] = self.team

            # Prepare prompt
            prompt = self.prompt
            if self.options.get("cwd"):
                prompt = prompt + "\nCurrent working directory: " + self.options.get("cwd")
            if self.task_data.get("git_url"):
                prompt = prompt + "\nProject URL: " + self.task_data.get("git_url")

            logger.info(f"Executing Agno team with prompt: {prompt}")
            
            # Execute the team run
            result = await self._run_team_async(prompt)
            
            return result

        except Exception as e:
            logger.exception(f"Error in async execution: {str(e)}")
            self.report_progress(
                100, TaskStatus.FAILED.value, f"Execution failed: {str(e)}"
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
            content_pieces = []
            final_response = None

            # Run the team with streaming
            agen = self.team.arun(prompt, stream=True, stream_intermediate_steps=True)
            
            try:
                async for chunk in agen:
                    # Process different event types
                    from agno.run.team import TeamRunEvent
                    from agno.run.agent import RunEvent
                    from agno.run.base import RunStatus

                    if hasattr(chunk, 'event'):
                        if chunk.event in [TeamRunEvent.run_content]:
                            content = getattr(chunk, 'content', '')
                            if content:
                                logger.info(f"Team content: {content}")
                                content_pieces.append(content)
                                # Report progress
                                self.report_progress(
                                    70, TaskStatus.RUNNING.value, f"Processing: {content[:100]}..."
                                )
                        
                        elif hasattr(chunk, 'status') and chunk.status == RunStatus.completed:
                            final_response = chunk
                            logger.info("Team run completed successfully")
                        
                        elif chunk.event in [TeamRunEvent.run_cancelled, RunEvent.run_cancelled]:
                            logger.warning("Team run was cancelled")
                            return TaskStatus.CANCELLED
                    
                    # Handle chunk content directly
                    if hasattr(chunk, 'content') and chunk.content:
                        content_pieces.append(str(chunk.content))

            finally:
                try:
                    await agen.aclose()
                except Exception as e:
                    logger.error(f"Stream close error: {e}")

            # Process the result
            if final_response or content_pieces:
                result_content = "".join(content_pieces)
                logger.info(f"Team execution completed with content length: {len(result_content)}")
                
                # Report completion with result
                self.report_progress(
                    100, TaskStatus.COMPLETED.value, "Agno team execution completed",
                    result={"content": result_content}
                )
                return TaskStatus.COMPLETED
            else:
                logger.warning("No content received from team execution")
                self.report_progress(
                    100, TaskStatus.FAILED.value, "No content received from team execution"
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
                logger.info(f"Closed Agno team for session_id: {session_id}")
            except Exception as e:
                logger.exception(
                    f"Error closing client for session_id {session_id}: {str(e)}"
                )
        cls._clients.clear()