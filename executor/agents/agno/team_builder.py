#!/usr/bin/env python

# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

# -*- coding: utf-8 -*-

from typing import Dict, Any, List, Optional, Union, Tuple
from agno.agent import Agent as AgnoSdkAgent
from agno.team import Team
from agno.db.sqlite import SqliteDb
from shared.logger import setup_logger

from .config_utils import ConfigManager
from .model_factory import ModelFactory
from .mcp_manager import MCPManager

logger = setup_logger("agno_team_builder")


class TeamBuilder:
    """
    Builds and manages Agno teams with configured members
    """
    
    def __init__(self, db: SqliteDb, config_manager: ConfigManager):
        """
        Initialize the team builder
        
        Args:
            db: SQLite database instance
            config_manager: Configuration manager instance
        """
        self.db = db
        self.config_manager = config_manager
        self.mcp_manager = MCPManager()
    
    async def create_team(self, options: Dict[str, Any], mode: str, session_id: str, task_data: Dict[str, Any]) -> Team:
        """
        Create a team with configured members
        
        Args:
            options: Team configuration options
            mode: Team mode (coordinate, collaborate, route)
            session_id: Session ID for the team
            task_data: task input

        Returns:
            Configured Team instance
        """
        logger.info("Starting to build team")
        
        # Create team members based on configuration
        team_data = await self._create_team_members(options, task_data)
        team_leader = team_data["leader"]
        team_members = team_data["members"]
        
        # Combine leader and members for the team
        all_team_members = []
        all_team_members.extend(team_members)

        # Get mode configuration
        mode_config = self._get_mode_config(mode)
        
        logger.info(
            f"Creating team with {len(all_team_members)} members (leader: {'Yes' if team_leader else 'No'}, other_members: {len(team_members)}), mode: {mode}, "
        )

        logger.info(f"team_leader.description: {team_leader.description}")

        # Create team
        # agent session: https://docs.agno.com/concepts/agents/sessions
        team = Team(
            name=options.get("team_name", "AgnoTeam"),
            members=all_team_members,
            model=team_leader.model,
            description=team_leader.description,
            session_id=session_id,
            add_member_tools_to_context=True,
            show_members_responses=True,
            add_datetime_to_context=True,
            add_history_to_context=True,
            markdown=True,
            db=self.db,
            telemetry=False,
            **mode_config
        )

        return team
    
    async def _create_team_members(self, options: Dict[str, Any], task_data: Dict[str, Any]) -> Dict[str, Any]:
        """
        Create team members based on configuration, separating team leader from other members
        
        Args:
            options: Team configuration options
            task_data: Task data for member creation
            
        Returns:
            Dictionary containing:
            - leader: Team leader (Optional[AgnoSdkAgent])
            - members: List of other team members (List[AgnoSdkAgent])
        """
        team_members = []
        team_leader = None
        team_members_config = options.get("team_members")
        
        if team_members_config:
            if isinstance(team_members_config, list):
                # Multiple team members
                for member_config in team_members_config:
                    member = await self._create_team_member(member_config, task_data)
                    if member:
                        # Check if this member is a team leader
                        if member_config.get("role") == "leader":
                            if team_leader is None:
                                team_leader = member
                                logger.info(f"Found team leader: {member.name}")
                            else:
                                logger.warning(f"Multiple team leaders found. Using first one, ignoring: {member.name}")
                        else:
                            team_members.append(member)
            else:
                # Single team member
                member = await self._create_team_member(team_members_config, task_data)
                if member:
                    # Check if this member is a team leader
                    if team_members_config.get("role") == "leader":
                        team_leader = member
                        logger.info(f"Found team leader: {member.name}")
                    else:
                        team_members.append(member)
        else:
            # Default team member
            member = await self._create_default_team_member(options, task_data)
            if member:
                # Check if default member is a team leader
                if options.get("role") == "leader":
                    team_leader = member
                    logger.info(f"Found team leader (default): {member.name}")
                else:
                    team_members.append(member)
        
        logger.info(f"Team creation completed: leader={'Yes' if team_leader else 'No'}, other_members={len(team_members)}")
        
        return {
            "leader": team_leader,
            "members": team_members
        }
    
    async def _create_team_member(self, member_config: Dict[str, Any], task_data: Dict[str, Any]) -> Optional[AgnoSdkAgent]:
        """
        Create a single team member
        
        Args:
            member_config: Member configuration
            
        Returns:
            Team member instance or None if creation fails
        """
        try:
            # Setup MCP tools if available
            mcp_tools = await self.mcp_manager.setup_mcp_tools(member_config)
            agent_config = member_config.get("agent_config", {})

            # Prepare data sources for placeholder replacement
            data_sources = {
                "agent_config": agent_config,
                "options": member_config,
                "executor_env": self.config_manager.executor_env,
                "task_data": task_data
            }
            
            # Build default headers with placeholders
            default_headers = self.config_manager.build_default_headers_with_placeholders(data_sources)
            
            member = AgnoSdkAgent(
                name=member_config.get("name", "TeamMember"),
                model=ModelFactory.create_model(agent_config, default_headers),
                add_name_to_context=True,
                add_datetime_to_context=True,
                tools=mcp_tools if mcp_tools else [],
                description=member_config.get("system_prompt", "Team member"),
                db=self.db,
                add_history_to_context=True,
                num_history_runs=3,
                telemetry=False
            )
            
            return member
        except Exception as e:
            logger.error(f"Failed to create team member: {str(e)}")
            return None
    
    async def _create_default_team_member(self, options: Dict[str, Any], task_data: Dict[str, Any]) -> Optional[AgnoSdkAgent]:
        """
        Create a default team member
        
        Args:
            options: Team configuration options
            
        Returns:
            Default team member instance or None if creation fails
        """
        try:
            # Setup MCP tools if available
            mcp_tools = await self.mcp_manager.setup_mcp_tools(options)
            agent_config = options.get("agent_config", {})
            
            # Prepare data sources for placeholder replacement
            data_sources = {
                "agent_config": agent_config,
                "options": options,
                "executor_env": self.config_manager.executor_env,
                "task_data": task_data
            }
            
            # Build default headers with placeholders
            default_headers = self.config_manager.build_default_headers_with_placeholders(data_sources)
            
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
                telemetry=False
            )
            
            return member
        except Exception as e:
            logger.error(f"Failed to create default team member: {str(e)}")
            return None
    
    def _get_team_model_config(self, options: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        """
        Get the team model configuration from options
        
        Args:
            options: Team configuration options
            
        Returns:
            Team model configuration or None
        """
        team_members_config = options.get("team_members")
        
        if team_members_config:
            if isinstance(team_members_config, list) and team_members_config:
                # Use the first member's config
                return team_members_config[0].get("agent_config", {})
            elif isinstance(team_members_config, dict):
                # Use the single member's config
                return team_members_config.get("agent_config", {})
        
        # Fallback to options agent_config
        return options.get("agent_config", {})
    
    def _get_mode_config(self, mode: str) -> Dict[str, Any]:
        """
        Get mode configuration based on team mode
        
        Args:
            mode: Team mode (coordinate, collaborate, route)
            
        Returns:
            Mode configuration dictionary
        """
        if mode == "coordinate":
            # 协调：队长拆分→选择性指派→汇总
            return {
                "delegate_task_to_all_members": False,
                "respond_directly": False,
                "determine_input_for_members": False,
            }
        elif mode == "collaborate":
            # 协作：所有成员并行，队长汇总
            return {
                "delegate_task_to_all_members": True,
            }
        elif mode == "route":
            # 路由：只选最合适的一个成员
            return {
                "respond_directly": True
            }
        else:
            # 默认走协调语义更稳
            return {
                "delegate_task_to_all_members": False,
                "respond_directly": False,
                "determine_input_for_members": False,
            }
    
    async def cleanup(self) -> None:
        """
        Clean up resources used by the team builder
        """
        await self.mcp_manager.cleanup_tools()