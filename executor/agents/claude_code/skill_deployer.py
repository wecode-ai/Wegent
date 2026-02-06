# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Skill deployment module for Claude Code agent.

Handles downloading and deploying skills from the Backend API.
This module provides skill lifecycle management for Claude Code agents.
"""

import os
import re
from typing import Any, Dict, List, Optional

from shared.logger import setup_logger

logger = setup_logger("claude_code_skill_deployer")


def download_and_deploy_skills(
    bot_config: Dict[str, Any],
    task_data: Dict[str, Any],
    mode_strategy: Any,
    config_dir: Optional[str] = None,
) -> None:
    """Download Skills from Backend API and deploy to skills directory.

    Delegates to the mode strategy which handles:
    - Docker mode: deploys to ~/.claude/skills/, clears cache
    - Local mode: deploys to task config directory, preserves cache

    Uses shared SkillDownloader from api_client module.

    Args:
        bot_config: Bot configuration containing skills list
        task_data: Task data dictionary containing auth_token and team_namespace
        mode_strategy: Execution mode strategy for getting deployment options
        config_dir: Optional config directory for Local mode
    """
    try:
        from executor.services.api_client import SkillDownloader

        # Extract skills list from bot_config (skills is at top level, not in spec)
        skills = bot_config.get("skills", [])
        if not skills:
            logger.debug("No skills configured for this bot")
            return

        logger.info(f"Found {len(skills)} skills to deploy: {skills}")

        # Get skills directory from strategy
        skills_dir = mode_strategy.get_skills_directory(config_dir=config_dir)

        # Get auth token
        auth_token = task_data.get("auth_token")
        if not auth_token:
            logger.warning("No auth token available, cannot download skills")
            return

        # Get team namespace for skill lookup
        team_namespace = task_data.get("team_namespace", "default")

        # Create downloader and deploy skills
        downloader = SkillDownloader(
            auth_token=auth_token,
            team_namespace=team_namespace,
            skills_dir=skills_dir,
        )

        # Get deployment options from strategy
        deployment_options = mode_strategy.get_skills_deployment_options()
        result = downloader.download_and_deploy(
            skills=skills,
            clear_cache=deployment_options["clear_cache"],
            skip_existing=deployment_options["skip_existing"],
        )

        logger.info(
            f"Skills deployment complete: {result.success_count}/{result.total_count} "
            f"deployed to {result.skills_dir}"
        )

    except Exception as e:
        logger.error(f"Error in download_and_deploy_skills: {str(e)}")
        # Don't raise - skills deployment failure shouldn't block task execution


def build_skill_emphasis_prompt(user_selected_skills: List[str]) -> str:
    """Build skill emphasis prompt for user-selected skills.

    When users explicitly select skills in the frontend, this generates
    a prompt prefix that emphasizes these skills, encouraging the model to
    prioritize using them.

    Args:
        user_selected_skills: List of skill names that the user explicitly selected

    Returns:
        Skill emphasis prompt to prepend to the user's message
    """
    if not user_selected_skills:
        return ""

    # Build skill list with emphasis markers
    skill_list = "\n".join(
        f"  - **{skill}** [USER SELECTED - PRIORITIZE]"
        for skill in user_selected_skills
    )

    emphasis_prompt = f"""## User-Selected Skills

The user has explicitly selected the following skills for this task. You should **prioritize using these skills** when they are relevant to the task:

{skill_list}

**Important**: These skills were specifically chosen by the user. When the task can benefit from these skills, prefer to use them over other approaches.

---

"""
    return emphasis_prompt


def setup_claudecode_dir(project_path: str, custom_rules: Dict[str, str]) -> None:
    """Setup .claudecode directory with custom instruction files.

    Creates .claudecode directory in the project and copies custom instruction
    files for Claude Code compatibility.

    Args:
        project_path: Project root directory
        custom_rules: Dictionary of {file_path: content} for custom instruction files
    """
    try:
        claudecode_dir = os.path.join(project_path, ".claudecode")

        # Create .claudecode directory if it doesn't exist
        os.makedirs(claudecode_dir, exist_ok=True)
        logger.debug(f"Created .claudecode directory at {claudecode_dir}")

        # Copy custom instruction files to .claudecode directory
        for file_path, content in custom_rules.items():
            # Get just the filename (not the full path)
            filename = os.path.basename(file_path)
            target_path = os.path.join(claudecode_dir, filename)

            try:
                with open(target_path, "w", encoding="utf-8") as f:
                    f.write(content)
                logger.info(
                    f"Copied custom instruction file to .claudecode: {filename}"
                )
            except Exception as e:
                logger.warning(f"Failed to copy {filename} to .claudecode: {e}")

        logger.info(
            f"Setup .claudecode directory with {len(custom_rules)} custom instruction files"
        )

    except Exception as e:
        logger.warning(f"Failed to setup .claudecode directory: {e}")


def setup_coordinate_mode(
    task_data: Dict[str, Any],
    project_path: Optional[str],
    options: Dict[str, Any],
) -> None:
    """Setup SubAgent configuration files for coordinate mode.

    In coordinate mode with multiple bots, the Leader (bot[0]) coordinates
    work among members (bot[1:]). This method generates .claude/agents/*.md
    configuration files for each member bot so that Claude Code can invoke
    them as SubAgents.

    SubAgent config files are placed in {target_path}/.claude/agents/ where
    target_path is determined by priority:
    1. project_path (if git repo was cloned)
    2. options["cwd"] (if already set)
    3. Default workspace: /workspace/{task_id}

    Args:
        task_data: Task data dictionary
        project_path: Optional project path
        options: Options dictionary (may be modified to set cwd)
    """
    from executor.agents.claude_code.git_operations import add_to_git_exclude
    from executor.config import config

    bots = task_data.get("bot", [])
    mode = task_data.get("mode")
    task_id = task_data.get("task_id")

    # Only setup for coordinate mode with multiple bots
    if mode != "coordinate" or len(bots) <= 1:
        logger.debug(f"Skipping SubAgent setup: mode={mode}, bots_count={len(bots)}")
        return

    # Determine target path for SubAgent configs
    target_path = project_path or options.get("cwd")
    if not target_path:
        # Create default workspace directory
        target_path = os.path.join(config.get_workspace_root(), str(task_id))
        os.makedirs(target_path, exist_ok=True)
        # Also update options["cwd"] so Claude Code uses this directory
        options["cwd"] = target_path
        logger.info(f"Created default workspace for SubAgent configs: {target_path}")

    # Leader is bot[0], members are bot[1:]
    member_bots = bots[1:]

    if not member_bots:
        logger.debug("Skipping SubAgent setup: no member bots after leader")
        return

    # Create .claude/agents directory
    agents_dir = os.path.join(target_path, ".claude", "agents")
    os.makedirs(agents_dir, exist_ok=True)

    # Generate SubAgent config file for each member
    for bot in member_bots:
        _generate_subagent_file(agents_dir, bot)

    # Add to git exclude to prevent showing in git diff (only if .git exists)
    add_to_git_exclude(target_path, ".claude/agents/")

    logger.info(
        f"Generated {len(member_bots)} SubAgent config files for coordinate mode "
        f"in {agents_dir}"
    )


def _generate_subagent_file(agents_dir: str, bot: Dict[str, Any]) -> None:
    """Generate SubAgent Markdown configuration file.

    The generated file follows Claude Code's SubAgent format with YAML frontmatter
    containing name, description, and model settings.

    Args:
        agents_dir: Path to the .claude/agents directory
        bot: Bot configuration dictionary containing name, system_prompt, etc.
    """
    # Normalize bot name for filename
    raw_name = bot.get("name", "unnamed")
    bot_id = bot.get("id", "")

    # Remove unsafe filesystem characters and normalize
    name = re.sub(r"[^\w\s-]", "", raw_name).lower().replace("_", "-").replace(" ", "-")

    # Ensure name is not empty after sanitization
    if not name:
        name = "unnamed"

    # Append bot ID to prevent filename collisions
    if bot_id:
        name = f"{name}-{bot_id}"

    # Get system prompt from bot config
    system_prompt = bot.get("system_prompt", "")

    # Generate description from bot name or use existing description
    description = bot.get("description") or f"Handle tasks related to {raw_name}"

    # Escape YAML special characters in description
    escaped_description = description.replace('"', '\\"').replace("\n", " ")
    escaped_description = f'"{escaped_description}"'

    # Build SubAgent config content
    content = f"""---
name: {name}
description: {escaped_description}
model: inherit
---

{system_prompt}
"""

    filepath = os.path.join(agents_dir, f"{name}.md")
    try:
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(content)
        logger.info(f"Generated SubAgent config: {filepath}")
    except Exception as e:
        logger.warning(f"Failed to generate SubAgent config for {raw_name}: {e}")
