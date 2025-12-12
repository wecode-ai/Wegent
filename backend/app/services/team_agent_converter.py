# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Team Agent Converter Service.

This service converts Team CRD configurations to Claude Code subagent format,
enabling the coordinate team mode in Claude Code through its native subagent mechanism.
"""

import logging
import re
from typing import Any, Dict, List, Optional, Tuple

from app.schemas.team_agent import CoordinatorTeamConfig, SubagentConfig

logger = logging.getLogger(__name__)


# Default Claude Code tools that are commonly available
DEFAULT_CLAUDE_CODE_TOOLS = [
    "Read",
    "Edit",
    "Write",
    "Bash",
    "Grep",
    "Glob",
    "Task",
    "WebFetch",
    "WebSearch",
]

# Mapping from Ghost skills to Claude Code tools
SKILL_TO_TOOL_MAPPING = {
    "file-read": "Read",
    "file-write": "Write",
    "file-edit": "Edit",
    "bash": "Bash",
    "search": "Grep",
    "glob": "Glob",
    "web-fetch": "WebFetch",
    "web-search": "WebSearch",
    "task": "Task",
}

# Model name patterns for alias resolution
MODEL_ALIAS_PATTERNS = {
    "sonnet": ["sonnet", "claude-3-5-sonnet", "claude-3-sonnet"],
    "opus": ["opus", "claude-3-opus"],
    "haiku": ["haiku", "claude-3-haiku", "claude-3-5-haiku"],
}


class TeamAgentConverter:
    """
    Converts Team CRD configurations to Claude Code subagent format.

    This converter transforms Wegent's Team configuration (with collaborationModel: coordinate)
    into Claude Code's native subagent mechanism by generating .claude/agents/*.md files.
    """

    def convert_team_to_agents(
        self, bots_with_config: List[Dict[str, Any]], collaboration_model: str
    ) -> Optional[CoordinatorTeamConfig]:
        """
        Convert team configuration to Claude Code subagent configuration.

        Args:
            bots_with_config: List of bot configurations containing:
                - name: Bot name
                - system_prompt: Combined Ghost systemPrompt + member prompt
                - mcp_servers: MCP server configurations
                - skills: List of skill names
                - role: Team member role (e.g., 'leader')
                - agent_config: Model configuration
            collaboration_model: Team collaboration model

        Returns:
            CoordinatorTeamConfig if successful, None otherwise
        """
        if collaboration_model != "coordinate":
            logger.debug(
                f"Skipping team agent conversion for non-coordinate mode: {collaboration_model}"
            )
            return None

        if not bots_with_config:
            logger.warning("No bots provided for team agent conversion")
            return None

        logger.info(
            f"Converting team with {len(bots_with_config)} bots to Claude Code subagent format"
        )

        # Separate leader from other members
        coordinator_bot, member_bots = self._separate_leader_and_members(
            bots_with_config
        )

        if not coordinator_bot:
            logger.warning("No leader found in coordinate team, using first bot as coordinator")
            coordinator_bot = bots_with_config[0]
            member_bots = bots_with_config[1:] if len(bots_with_config) > 1 else []

        # Convert coordinator
        coordinator_config = self._convert_bot_to_subagent(
            coordinator_bot, is_coordinator=True
        )

        # Convert other members to subagents
        subagents = []
        agent_files = {}
        for bot in member_bots:
            subagent_config = self._convert_bot_to_subagent(bot, is_coordinator=False)
            if subagent_config:
                subagents.append(subagent_config)
                # Generate filename from bot name
                filename = self._generate_agent_filename(bot.get("name", "agent"))
                agent_files[filename] = subagent_config.file_content

        # Generate enhanced coordinator system prompt with team context
        coordinator_system_prompt = self._generate_coordinator_system_prompt(
            coordinator_config, subagents
        )

        return CoordinatorTeamConfig(
            coordinator=coordinator_config,
            subagents=subagents,
            agent_files=agent_files,
            coordinator_system_prompt=coordinator_system_prompt,
        )

    def _separate_leader_and_members(
        self, bots: List[Dict[str, Any]]
    ) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, Any]]]:
        """
        Separate the leader from other team members.

        Args:
            bots: List of bot configurations

        Returns:
            Tuple of (leader_bot, other_bots)
        """
        leader = None
        members = []

        for bot in bots:
            if bot.get("role") == "leader":
                if leader is None:
                    leader = bot
                    logger.info(f"Found team leader: {bot.get('name', 'unnamed')}")
                else:
                    logger.warning(
                        f"Multiple leaders found, ignoring: {bot.get('name', 'unnamed')}"
                    )
                    members.append(bot)
            else:
                members.append(bot)

        return leader, members

    def _convert_bot_to_subagent(
        self, bot: Dict[str, Any], is_coordinator: bool = False
    ) -> SubagentConfig:
        """
        Convert a single bot configuration to Claude Code subagent format.

        Args:
            bot: Bot configuration dictionary
            is_coordinator: Whether this bot is the coordinator

        Returns:
            SubagentConfig instance
        """
        name = self._normalize_agent_name(bot.get("name", "agent"))
        role = bot.get("role", "")
        system_prompt = bot.get("system_prompt", "")
        skills = bot.get("skills", [])
        agent_config = bot.get("agent_config", {})

        # Generate description from role and system prompt
        description = self._generate_description(role, system_prompt, is_coordinator)

        # Convert skills to tools
        tools = self._convert_skills_to_tools(skills)

        # Resolve model alias
        model = self._resolve_model_alias(agent_config)

        # Generate the markdown file content
        file_content = self._generate_agent_markdown(
            name=name,
            description=description,
            tools=tools,
            model=model,
            system_prompt=system_prompt,
            role=role,
        )

        return SubagentConfig(
            name=name,
            description=description,
            tools=tools,
            model=model,
            system_prompt=system_prompt,
            role=role,
            file_content=file_content,
        )

    def _normalize_agent_name(self, name: str) -> str:
        """
        Normalize agent name to kebab-case.

        Args:
            name: Original agent name

        Returns:
            Normalized kebab-case name
        """
        # Replace underscores and spaces with hyphens
        normalized = re.sub(r"[_\s]+", "-", name.lower())
        # Remove any characters that are not alphanumeric or hyphens
        normalized = re.sub(r"[^a-z0-9-]", "", normalized)
        # Remove leading/trailing hyphens and collapse multiple hyphens
        normalized = re.sub(r"-+", "-", normalized).strip("-")
        return normalized or "agent"

    def _generate_description(
        self, role: str, system_prompt: str, is_coordinator: bool
    ) -> str:
        """
        Generate a description for the subagent.

        Args:
            role: Team member role
            system_prompt: System prompt content
            is_coordinator: Whether this is the coordinator

        Returns:
            Generated description string
        """
        # Extract first meaningful sentence from system prompt
        first_sentence = ""
        if system_prompt:
            # Find first sentence (ending with period, question mark, or exclamation)
            match = re.search(r"^[^.!?]*[.!?]", system_prompt.strip())
            if match:
                first_sentence = match.group(0).strip()
            else:
                # Use first 100 characters if no sentence found
                first_sentence = system_prompt[:100].strip()
                if len(system_prompt) > 100:
                    first_sentence += "..."

        if role:
            if is_coordinator:
                return f"[{role}] Team coordinator. {first_sentence}"
            return f"[{role}] {first_sentence}"

        return first_sentence or "A specialized agent for task execution."

    def _convert_skills_to_tools(self, skills: List[str]) -> Optional[List[str]]:
        """
        Convert Ghost skills to Claude Code tool names.

        Args:
            skills: List of skill names from Ghost configuration

        Returns:
            List of Claude Code tool names, or None to inherit all tools
        """
        if not skills:
            # No skills specified, inherit all tools
            return None

        tools = []
        for skill in skills:
            skill_lower = skill.lower()
            if skill_lower in SKILL_TO_TOOL_MAPPING:
                tools.append(SKILL_TO_TOOL_MAPPING[skill_lower])
            elif skill in DEFAULT_CLAUDE_CODE_TOOLS:
                # Skill name matches a Claude Code tool directly
                tools.append(skill)

        # If no tools were mapped, return default tools
        if not tools:
            return None

        # Remove duplicates while preserving order
        seen = set()
        unique_tools = []
        for tool in tools:
            if tool not in seen:
                seen.add(tool)
                unique_tools.append(tool)

        return unique_tools

    def _resolve_model_alias(self, agent_config: Dict[str, Any]) -> Optional[str]:
        """
        Resolve bot model configuration to Claude Code model alias.

        Args:
            agent_config: Agent configuration containing model info

        Returns:
            Model alias (sonnet/opus/haiku) or None for inherit
        """
        if not agent_config:
            return None

        env = agent_config.get("env", {})
        model_id = env.get("model_id", "") or env.get("model", "")

        if not model_id:
            return None

        model_id_lower = model_id.lower()

        for alias, patterns in MODEL_ALIAS_PATTERNS.items():
            for pattern in patterns:
                if pattern in model_id_lower:
                    return alias

        # Default to sonnet if model is specified but not recognized
        return "sonnet"

    def _generate_agent_markdown(
        self,
        name: str,
        description: str,
        tools: Optional[List[str]],
        model: Optional[str],
        system_prompt: str,
        role: Optional[str] = None,
    ) -> str:
        """
        Generate the Markdown file content for a Claude Code subagent.

        Args:
            name: Subagent name
            description: Subagent description
            tools: List of tools (or None for inherit all)
            model: Model alias (or None for default)
            system_prompt: System prompt content
            role: Optional role description

        Returns:
            Complete Markdown file content
        """
        lines = ["---"]
        lines.append(f"name: {name}")
        lines.append(f"description: {description}")

        if tools:
            tools_str = ", ".join(tools)
            lines.append(f"tools: {tools_str}")

        if model:
            lines.append(f"model: {model}")

        lines.append("---")
        lines.append("")

        # Add system prompt as the body
        if system_prompt:
            lines.append(system_prompt)

        return "\n".join(lines)

    def _generate_agent_filename(self, name: str) -> str:
        """
        Generate the filename for a subagent Markdown file.

        Args:
            name: Agent name

        Returns:
            Filename with .md extension
        """
        normalized = self._normalize_agent_name(name)
        return f"{normalized}.md"

    def _generate_coordinator_system_prompt(
        self,
        coordinator: SubagentConfig,
        subagents: List[SubagentConfig],
    ) -> str:
        """
        Generate an enhanced system prompt for the coordinator with team context.

        Args:
            coordinator: Coordinator configuration
            subagents: List of subagent configurations

        Returns:
            Enhanced system prompt with team coordination instructions
        """
        base_prompt = coordinator.system_prompt

        if not subagents:
            return base_prompt

        # Build team context section
        team_context = [
            "",
            "",
            "## Team Coordination",
            "",
            "You are the team coordinator. You have access to the following specialized subagents:",
            "",
        ]

        for subagent in subagents:
            role_info = f" ({subagent.role})" if subagent.role else ""
            team_context.append(f"- **{subagent.name}**{role_info}: {subagent.description}")

        team_context.extend(
            [
                "",
                "### Coordination Guidelines",
                "",
                "1. Analyze incoming tasks and determine which subagent(s) are best suited for each part",
                "2. Delegate specific subtasks to appropriate subagents using the Task tool",
                "3. Coordinate and synthesize results from multiple subagents when needed",
                "4. Handle tasks that don't fit any specific subagent's expertise directly",
                "5. Ensure clear communication and handoffs between subtasks",
                "",
            ]
        )

        return base_prompt + "\n".join(team_context)


# Singleton instance
team_agent_converter = TeamAgentConverter()
