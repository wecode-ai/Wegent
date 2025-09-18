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
from .member_builder import MemberBuilder

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
        self.member_builder = MemberBuilder(db, config_manager)
    
    async def create_team(self, options: Dict[str, Any], mode: str, session_id: str, task_data: Dict[str, Any]) -> Optional[Team]:
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

        # It is believed that the agent mode needs to be used for operation
        if team_leader is None and len(team_members) == 1:
            logger.info("create_team fail. team_leader is None and len(team_members) == 1")
            return None
        
        # Combine leader and members for the team
        all_team_members = []
        all_team_members.extend(team_members)

        # Get mode configuration
        mode_config = self._get_mode_config(mode)
        if team_leader is None:
            team_leader = all_team_members[0]
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
                    member = await self.member_builder.create_member(member_config, task_data)
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
                member = await self.member_builder.create_member(team_members_config, task_data)
                if member:
                    # Check if this member is a team leader
                    if team_members_config.get("role") == "leader":
                        team_leader = member
                        logger.info(f"Found team leader: {member.name}")
                    else:
                        team_members.append(member)
        else:
            # Default team member
            member = await self.member_builder.create_default_member(options, task_data)
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
        Create a single team member (delegated to MemberBuilder)
        
        Args:
            member_config: Member configuration
            task_data: Task data for member creation
            
        Returns:
            Team member instance or None if creation fails
        """
        return await self.member_builder.create_member(member_config, task_data)
    
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
        await self.member_builder.cleanup_all_resources()