# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Schemas for Claude Code subagent configuration in coordinate team mode.

This module defines the data structures used to convert Team configurations
to Claude Code subagent format for the coordinate collaboration model.
"""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class SubagentConfig(BaseModel):
    """
    Configuration for a single Claude Code subagent.

    This represents a team member that will be converted to a
    .claude/agents/*.md file for Claude Code's native subagent mechanism.
    """

    name: str = Field(..., description="Unique identifier for the subagent (kebab-case)")
    description: str = Field(
        ..., description="Natural language description of the subagent's purpose"
    )
    tools: Optional[List[str]] = Field(
        default=None,
        description="List of tools the subagent can use. If None, inherits all tools",
    )
    model: Optional[str] = Field(
        default=None,
        description="Model alias for the subagent (sonnet/opus/haiku/inherit)",
    )
    system_prompt: str = Field(
        ..., description="The system prompt for the subagent"
    )
    member_prompt: Optional[str] = Field(
        default=None, description="Additional prompt from team member configuration"
    )
    role: Optional[str] = Field(
        default=None, description="Role of the subagent in the team"
    )
    file_content: str = Field(
        ..., description="Complete Markdown file content for the subagent"
    )


class CoordinatorTeamConfig(BaseModel):
    """
    Configuration for a coordinate team mode in Claude Code.

    This contains the coordinator (leader) configuration and all subagent
    configurations that will be written to .claude/agents/ directory.
    """

    coordinator: SubagentConfig = Field(
        ..., description="The coordinator (leader) configuration"
    )
    subagents: List[SubagentConfig] = Field(
        default_factory=list,
        description="List of subagent configurations (non-leader members)",
    )
    agent_files: Dict[str, str] = Field(
        default_factory=dict,
        description="Mapping of filename to Markdown content for each subagent",
    )
    coordinator_system_prompt: str = Field(
        default="",
        description="Enhanced system prompt for the coordinator with team context",
    )


class TeamAgentConversionRequest(BaseModel):
    """
    Request data for team to agent conversion.

    This is used to pass team configuration data to the converter service.
    """

    team_id: int = Field(..., description="Team ID")
    collaboration_model: str = Field(..., description="Team collaboration model")
    members: List[Dict[str, Any]] = Field(
        ..., description="List of team member configurations"
    )
    bots: List[Dict[str, Any]] = Field(
        ..., description="List of bot configurations with ghost and shell info"
    )
