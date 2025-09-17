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
import re

from agno.agent import Agent as AgnoSdkAgent
from agno.models.openai import OpenAIChat
from agno.models.anthropic import Claude
from agno.team import Team
from agno.tools.mcp import MCPTools
from agno.tools.mcp import StreamableHTTPClientParams, SSEClientParams, StdioServerParameters
from executor.agents.base import Agent
from executor.config.config import EXECUTOR_ENV
from shared.logger import setup_logger
from shared.status import TaskStatus
from agno.db.sqlite import SqliteDb
import json

db = SqliteDb(db_file="/tmp/agno_data.db")

logger = setup_logger("agno_agent")


def _resolve_value_from_source(data_sources: Dict[str, Dict[str, Any]], source_spec: str) -> str:
    """
    Resolve value from specified data source using flexible notation

    Args:
        data_sources: Dictionary containing all available data sources
        source_spec: Source specification in format "source_name.path" or just "path"

    Returns:
        The resolved value or empty string if not found
    """
    try:
        # Parse source specification
        if '.' in source_spec:
            # Format: "source_name.path"
            parts = source_spec.split('.', 1)
            source_name = parts[0]
            path = parts[1]
        else:
            # Format: just "path", use default source
            source_name = "agent_config"
            path = source_spec

        # Get the specified data source
        if source_name not in data_sources:
            return ""

        data = data_sources[source_name]

        # Navigate the path
        keys = path.split('.')
        current = data

        for key in keys:
            if isinstance(current, dict) and key in current:
                current = current[key]
            elif isinstance(current, list) and key.isdigit() and int(key) < len(current):
                current = current[int(key)]
            else:
                return ""

        return str(current) if current is not None else ""
    except Exception:
        return ""


def _replace_placeholders_with_sources(template: str, data_sources: Dict[str, Dict[str, Any]]) -> str:
    """
    Replace placeholders in template with values from multiple data sources

    Args:
        template: The template string with placeholders like ${agent_config.env.user} or ${env.user}
        data_sources: Dictionary containing all available data sources

    Returns:
        The template with placeholders replaced with actual values
    """
    # Find all placeholders in format ${source_spec}
    pattern = r'\$\{([^}]+)\}'

    def replace_match(match):
        source_spec = match.group(1)
        value = _resolve_value_from_source(data_sources, source_spec)
        return value

    return re.sub(pattern, replace_match, template)


class AgnoAgent(Agent):
    """
    Agno Agent that integrates with Agno SDK
    """

    # Static dictionary for storing client connections to enable connection reuse
    _clients: Dict[str, Team] = {}

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
        self.mode = task_data.get("mode", "")

        # Extract Agno options from task_data
        self.options = self._extract_agno_options(task_data)
        # --- robust parsing for EXECUTOR_ENV and DEFAULT_HEADERS ---
        # Parse EXECUTOR_ENV which might be a JSON string or dict-like
        try:
            if isinstance(EXECUTOR_ENV, str):
                env_raw = EXECUTOR_ENV.strip()
            else:
                # Fall back to JSON-dumping if it's already a dict-like
                env_raw = json.dumps(EXECUTOR_ENV)
            self.executor_env = json.loads(env_raw) if env_raw else {}
        except Exception as e:
            logger.warning(f"Failed to parse EXECUTOR_ENV; using empty dict. Error: {e}")
            self.executor_env = {}

        # Derive DEFAULT_HEADERS: prefer executor_env.DEFAULT_HEADERS, else OS env
        self.default_headers = {}
        self._default_headers_raw_str = None  # keep raw string for placeholder replacement later
        try:
            dh = None
            logger.info(f"EXECUTOR_ENV: {self.executor_env}")
            if isinstance(self.executor_env, dict):
                dh = self.executor_env.get("DEFAULT_HEADERS")
            if not dh:
                dh = os.environ.get("DEFAULT_HEADERS")

            logger.info(f"dh: {dh}")
            if isinstance(dh, dict):
                self.default_headers = dh
            elif isinstance(dh, str):
                raw = dh.strip()
                self._default_headers_raw_str = raw or None
                if raw:
                    try:
                        # try parsing as JSON string first
                        self.default_headers = json.loads(raw)
                    except Exception:
                        # if it isn't JSON, we'll keep raw for later placeholder expansion
                        self.default_headers = {}
            # else: leave as empty dict
        except Exception as e:
            logger.warning(f"Failed to load DEFAULT_HEADERS; using empty headers. Error: {e}")
            self.default_headers = {}
        # --- end robust parsing ---

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

        # Handle both single bot object and bot array
        if bot_config:
            if isinstance(bot_config, list):
                # Handle bot array - use the first bot configuration
                team_members = []
                for tmp_bot in bot_config:
                    tmp_bot_options = {}
                    logger.info(
                        f"Found bot array with {len(bot_config)} bots, using bot: {tmp_bot.get('name', 'unnamed')}")
                    # Extract all non-None parameters from the first bot
                    for key in valid_options:
                        if key in tmp_bot and tmp_bot[key] is not None:
                            tmp_bot_options[key] = tmp_bot[key]
                    team_members.append(tmp_bot)

                options["team_members"] = team_members
            else:
                # Handle single bot object (original logic)
                logger.info("Found single bot configuration")
                for key in valid_options:
                    if key in bot_config and bot_config[key] is not None:
                        options[key] = bot_config[key]

        logger.info(f"Extracted Agno options: {options}")
        return options

    def _get_model(self, agent_config):
        """
        Get the model configuration based on options
        """
        env = agent_config.get("env", {})
        model_config = env.get("model", "claude")
        # Build default headers robustly (use values parsed in __init__)
        default_headers = {}
        try:
            # Prepare data sources for placeholder replacement
            data_sources = {
                "agent_config": agent_config,
                "task_data": self.task_data,
                "options": self.options,
                "executor_env": getattr(self, "executor_env", {})
            }

            logger.info(f"data_sources: {data_sources}, self.default_headers: {self.default_headers}")
            # Apply placeholder replacement on individual string values inside the dict
            replaced = {}
            for k, v in self.default_headers.items():
                if isinstance(v, str):
                    replaced[k] = _replace_placeholders_with_sources(v, data_sources)
                else:
                    replaced[k] = v
            default_headers = replaced
        except Exception as e:
            logger.warning(f"Failed to build default headers; proceeding without. Error: {e}")
            default_headers = {}

        logger.info(f"Model config: {agent_config}")
        if model_config == "claude":
            return Claude(
                id=env.get("model_id", os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")),
                api_key=env.get("api_key", os.environ.get("ANTHROPIC_API_KEY")),
                default_headers=default_headers
            )
        elif model_config == "openai":
            return OpenAIChat(
                id=env.get("model_id", os.environ.get("OPENAI_MODEL", "gpt-4")),
                api_key=env.get("api_key", os.environ.get("OPENAI_API_KEY")),
                base_url=env.get("base_url", os.environ.get("OPENAI_BASE_URL")),
                default_headers=default_headers
            )
        else:
            # Default to Claude
            return Claude(
                id=env.get("model_id", os.environ.get("ANTHROPIC_MODEL", "claude-3-5-sonnet-20241022")),
                api_key=env.get("api_key", os.environ.get("ANTHROPIC_API_KEY")),
                default_headers=default_headers
            )

    async def _setup_mcp_tools(self, config) -> Optional[List[MCPTools]]:
        """
        Setup MCP tools if configured
        """
        mcp_servers = config.get("mcp_servers")
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

                    mcpType = server_config.get("type")
                    if not mcpType:
                        mcpType = "streamable-http"

                    if mcpType == "streamable-http":
                        # Extract server parameters
                        server_params = StreamableHTTPClientParams(
                            url=server_config.get("url"),
                            headers=server_config.get("headers", {})
                        )
                        mcp_tools = MCPTools(transport="streamable-http", server_params=server_params)
                    elif mcpType == "sse":
                        # Extract server parameters
                        server_params = SSEClientParams(
                            url=server_config.get("url"),
                            headers=server_config.get("headers", {})
                        )
                        mcp_tools = MCPTools(transport="sse", server_params=server_params)
                    elif mcpType == "stdio":
                        # Extract server parameters

                        # {
                        #     "github": {
                        #         "env": {
                        #             "GITHUB_PERSONAL_ACCESS_TOKEN": "github_pat_xxxxxxx"
                        #         },
                        #         "args": [
                        #             "run",
                        #             "-i",
                        #             "--rm",
                        #             "-e",
                        #             "GITHUB_PERSONAL_ACCESS_TOKEN",
                        #             "-e",
                        #             "GITHUB_TOOLSETS",
                        #             "-e",
                        #             "GITHUB_READ_ONLY",
                        #             "ghcr.io/github/github-mcp-server"
                        #         ],
                        #         "command": "docker"
                        #     }
                        # }
                        server_params = StdioServerParameters(
                            env=server_config.get("env"),
                            args=server_config.get("args", []),
                            command=server_config.get("command"),
                        )
                        mcp_tools = MCPTools(transport="stdio", server_params=server_params)
                    else:
                        # Add support for other MCP types here
                        raise ValueError(f"Unsupported MCP type: {mcpType}")

                    mcp_tools_list.append(mcp_tools)

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

            if mcp_tools_list:
                logger.info("Setting up MCP tools")
                # Connect all MCP tools in the list
                for mcp_tool in mcp_tools_list:
                    await mcp_tool.connect()

            return mcp_tools_list
        except Exception as e:
            logger.error(f"Failed to setup MCP tools: {str(e)}")

        return None

    async def _create_team(self) -> Team:
        """
        Create a team with configured members
        """
        team_members = []

        logger.info("start Setting up MCP tools")

        # Create team members based on configuration
        team_members_config = self.options.get("team_members")
        team_model_config = None
        if team_members_config:
            if isinstance(team_members_config, list):
                for member_config in team_members_config:
                    # Setup MCP tools if available
                    mcp_tools = await self._setup_mcp_tools(member_config)
                    agent_config = member_config.get("agent_config", {})
                    if not team_model_config:
                        team_model_config = agent_config
                    member = AgnoSdkAgent(
                        name=member_config.get("name", "TeamMember"),
                        model=self._get_model(agent_config),
                        add_name_to_context=True,
                        add_datetime_to_context=True,
                        tools=mcp_tools if mcp_tools else [],
                        description=member_config.get("system_prompt", "Team member"),
                        db=db,
                        add_history_to_context=True,
                        num_history_runs=3,
                        telemetry=False
                    )
                    team_members.append(member)
            else:
                # Single member configuration
                # Setup MCP tools if available
                mcp_tools = await self._setup_mcp_tools(self.options)
                agent_config = self.options.get("agent_config", {})
                team_model_config = agent_config
                member = AgnoSdkAgent(
                    name=team_members_config.get("name", "TeamMember"),
                    model=self._get_model(agent_config),
                    add_name_to_context=True,
                    add_datetime_to_context=True,
                    tools=mcp_tools if mcp_tools else [],
                    description=team_members_config.get("system_prompt", "Team member"),
                    db=db,
                    add_history_to_context=True,
                    num_history_runs=3,
                    telemetry=False
                )
                team_members.append(member)
        else:
            # Default team member
            mcp_tools = await self._setup_mcp_tools(self.options)
            agent_config = self.options.get("agent_config", {})
            team_model_config = agent_config
            member = AgnoSdkAgent(
                name="DefaultAgent",
                model=self._get_model(agent_config),
                tools=mcp_tools if mcp_tools else [],
                description="Default team member",
                add_name_to_context=True,
                add_datetime_to_context=True,
                db=db,
                add_history_to_context=True,
                num_history_runs=3,
                telemetry=False
            )
            team_members.append(member)

        if self.mode == "coordinate":
            # 协调：队长拆分→选择性指派→汇总
            mode_config = {
                "delegate_task_to_all_members": False,
                "respond_directly": False,
                "determine_input_for_members": False,
            }

        elif self.mode == "collaborate":
            # 协作：所有成员并行，队长汇总
            mode_config = {
                "delegate_task_to_all_members": True,
            }

        elif self.mode == "route":
            # 路由：只选最合适的一个成员
            mode_config = {
                "respond_directly": True
            }

        else:
            # 默认走协调语义更稳
            mode_config = {
                "delegate_task_to_all_members": False,
                "respond_directly": False,
                "determine_input_for_members": False,
            }

        logger.info(
            f"start create team. team_members.size: {len(team_members)}, mode: {self.mode}, team_model_config: {team_model_config}")

        # Create team
        # agent session: https://docs.agno.com/concepts/agents/sessions
        team = Team(
            name=self.options.get("team_name", "AgnoTeam"),
            members=team_members,
            model=self._get_model(team_model_config),
            description=self.options.get("team_description", "Agno team for task execution"),
            session_id=self.session_id,
            **({"instructions": [self.team_prompt]} if self.team_prompt else {}),
            add_member_tools_to_context=True,
            show_members_responses=True,
            add_datetime_to_context=True,
            add_history_to_context=True,
            markdown=True,
            db=db,
            telemetry=False,
            **mode_config
        )

        return team

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
            # Run to completion (non-streaming) and gather final output
            result = await self.team.arun(
                prompt,
                stream=False,
                add_history_to_context=True,
                session_id=self.session_id,
                user_id=self.session_id,
                debug_mode=True,
            )

            # Normalize the result into a string
            result_content: str = ""
            try:
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
