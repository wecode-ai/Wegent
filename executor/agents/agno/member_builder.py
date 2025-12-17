#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Any, Dict, List, Optional

from agno.agent import Agent as AgnoSdkAgent
from agno.db.sqlite import SqliteDb
from shared.logger import setup_logger

from .config_utils import ConfigManager
from .mcp_manager import MCPManager
from .model_factory import ModelFactory

logger = setup_logger("agno_member_builder")


class MemberBuilder:
    """
    Builds and manages individual team members with configurable options
    """

    def __init__(
        self, db: SqliteDb, config_manager: ConfigManager, thinking_manager=None
    ):
        """
        Initialize member builder

        Args:
            db: SQLite database instance
            config_manager: Configuration manager instance
            thinking_manager: Thinking step manager instance (optional)
        """
        self.db = db
        self.config_manager = config_manager
        self.mcp_manager = MCPManager(thinking_manager)

    async def create_member(
        self, member_config: Dict[str, Any], task_data: Dict[str, Any]
    ) -> Optional[AgnoSdkAgent]:
        """
        Create a single team member with comprehensive configuration

        Args:
            member_config: Member configuration dictionary
            task_data: Task data for member creation

        Returns:
            Team member instance or None if creation fails
        """
        try:
            logger.info(f"Creating team member: {member_config.get('name', 'Unnamed')}")

            # Setup MCP tools if available (pass task_data for variable replacement)
            mcp_tools = await self.mcp_manager.setup_mcp_tools(member_config, task_data)
            agent_config = member_config.get("agent_config", {})

            # Prepare data sources for placeholder replacement
            data_sources = {
                "agent_config": agent_config,
                "options": member_config,
                "executor_env": self.config_manager.executor_env,
                "task_data": task_data,
            }

            # Build default headers with placeholders
            default_headers = (
                self.config_manager.build_default_headers_with_placeholders(
                    data_sources
                )
            )

            # Get member-specific configuration
            member_name = self._get_member_name(member_config)
            member_description = self._get_member_description(member_config)
            member_model = ModelFactory.create_model(agent_config, default_headers)

            # Create the team member
            member = AgnoSdkAgent(
                name=member_name,
                model=member_model,
                role=member_description,
                add_name_to_context=True,
                add_datetime_to_context=True,
                tools=mcp_tools if mcp_tools else [],
                description=member_description,
                db=self.db,
                add_history_to_context=True,
                num_history_runs=3,
                telemetry=False,
            )

            logger.info(f"Successfully created team member: {member_name}")
            return member

        except Exception as e:
            logger.error(f"Failed to create team member: {str(e)}")
            return None

    async def create_default_member(
        self, options: Dict[str, Any], task_data: Dict[str, Any]
    ) -> Optional[AgnoSdkAgent]:
        """
        Create a default team member with basic configuration

        Args:
            options: Team configuration options
            task_data: Task data for member creation

        Returns:
            Default team member instance or None if creation fails
        """
        try:
            logger.info("Creating default team member")

            # Setup MCP tools if available (pass task_data for variable replacement)
            mcp_tools = await self.mcp_manager.setup_mcp_tools(options, task_data)
            agent_config = options.get("agent_config", {})

            # Prepare data sources for placeholder replacement
            data_sources = {
                "agent_config": agent_config,
                "options": options,
                "executor_env": self.config_manager.executor_env,
                "task_data": task_data,
            }

            # Build default headers with placeholders
            default_headers = (
                self.config_manager.build_default_headers_with_placeholders(
                    data_sources
                )
            )

            # Create the default member
            member = AgnoSdkAgent(
                name="DefaultAgent",
                model=ModelFactory.create_model(agent_config, default_headers),
                tools=mcp_tools if mcp_tools else [],
                description="Default team member",
                add_name_to_context=True,
                add_datetime_to_context=True,
                db=self.db,
                add_history_to_context=True,
                num_history_runs=3,
                telemetry=False,
            )

            logger.info("Successfully created default team member")
            return member

        except Exception as e:
            logger.error(f"Failed to create default team member: {str(e)}")
            return None

    async def create_members_from_config(
        self, team_members_config: List[Dict[str, Any]], task_data: Dict[str, Any]
    ) -> List[AgnoSdkAgent]:
        """
        Create multiple team members from configuration list

        Args:
            team_members_config: List of member configurations
            task_data: Task data for member creation

        Returns:
            List of created team members
        """
        members = []

        if not team_members_config:
            logger.warning("No team members configuration provided")
            return members

        for member_config in team_members_config:
            member = await self.create_member(member_config, task_data)
            if member:
                members.append(member)
            else:
                logger.warning(f"Failed to create member from config: {member_config}")

        logger.info(f"Created {len(members)} team members from configuration")
        return members

    async def create_member_with_role(
        self, member_config: Dict[str, Any], task_data: Dict[str, Any], role: str
    ) -> Optional[AgnoSdkAgent]:
        """
        Create a team member with a specific role

        Args:
            member_config: Member configuration dictionary
            task_data: Task data for member creation
            role: Role to assign to the member (e.g., "leader", "member")

        Returns:
            Team member instance or None if creation fails
        """
        try:
            # Add role to member configuration
            member_config_with_role = member_config.copy()
            member_config_with_role["role"] = role

            # Create the member
            member = await self.create_member(member_config_with_role, task_data)

            if member:
                logger.info(f"Created team member with role '{role}': {member.name}")

            return member

        except Exception as e:
            logger.error(f"Failed to create team member with role '{role}': {str(e)}")
            return None

    def _get_member_name(self, member_config: Dict[str, Any]) -> str:
        """
        Get the member name from configuration, with fallback

        Args:
            member_config: Member configuration dictionary

        Returns:
            Member name string
        """
        return member_config.get("name", "TeamMember")

    def _get_member_description(self, member_config: Dict[str, Any]) -> str:
        """
        Get the member description from configuration, with fallback

        Args:
            member_config: Member configuration dictionary

        Returns:
            Member description string
        """
        return member_config.get("system_prompt", "Team member")

    def _validate_member_config(self, member_config: Dict[str, Any]) -> bool:
        """
        Validate member configuration

        Args:
            member_config: Member configuration dictionary

        Returns:
            True if valid, False otherwise
        """
        if not isinstance(member_config, dict):
            logger.error("Member configuration must be a dictionary")
            return False

        # Check for required fields
        if "agent_config" not in member_config:
            logger.warning(
                "Member configuration missing 'agent_config', using defaults"
            )

        return True

    async def cleanup_member_resources(self, member: AgnoSdkAgent) -> None:
        """
        Clean up resources used by a specific member

        Args:
            member: Team member instance to clean up
        """
        try:
            logger.info(f"Cleaning up resources for member: {member.name}")

            # Clean up MCP tools if any
            await self.mcp_manager.cleanup_tools()

            logger.info(f"Successfully cleaned up resources for member: {member.name}")

        except Exception as e:
            logger.error(
                f"Failed to clean up resources for member {member.name}: {str(e)}"
            )

    async def cleanup_all_resources(self) -> None:
        """
        Clean up all resources used by the member builder
        """
        try:
            logger.info("Cleaning up all member builder resources")

            # Clean up MCP tools
            await self.mcp_manager.cleanup_tools()

            logger.info("Successfully cleaned up all member builder resources")

        except Exception as e:
            logger.error(f"Failed to clean up member builder resources: {str(e)}")
