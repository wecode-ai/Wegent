# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tools factory module.

Responsible for:
- Creating LoadSkillTool
- Querying previously used skills from history
- Dynamically creating skill tools
"""

import logging
from typing import Any, Optional

logger = logging.getLogger(__name__)


def prepare_load_skill_tool(
    skill_names: list[str],
    user_id: int,
    db: Any,
    task_id: Optional[int] = None,
) -> Optional[Any]:
    """
    Prepare LoadSkillTool if skills are configured.

    This function creates a LoadSkillTool instance that allows the model
    to dynamically load skill prompts on demand.

    For follow-up messages, it also preloads skills that were previously used
    in the conversation to ensure skill prompts remain effective.

    Args:
        skill_names: List of skill names available for this session
        user_id: User ID for skill lookup
        db: Database session
        task_id: Optional task ID for loading previously used skills from history

    Returns:
        LoadSkillTool instance or None if no skills configured
    """
    if not skill_names:
        return None

    logger.info(
        "[skill_factory] Creating LoadSkillTool for %d skills: %s",
        len(skill_names),
        skill_names,
    )

    # Import LoadSkillTool
    from app.chat_shell.tools.builtin import LoadSkillTool

    # Create LoadSkillTool with the available skills
    load_skill_tool = LoadSkillTool(
        db=db,
        user_id=user_id,
        skill_names=skill_names,
    )

    # Preload skills that were previously used in this conversation
    # This ensures skill prompts remain effective for follow-up messages
    if task_id:
        previously_used_skills = _get_previously_used_skills(db, task_id)
        if previously_used_skills:
            # Filter to only skills that are available in this session
            skills_to_preload = [s for s in previously_used_skills if s in skill_names]
            if skills_to_preload:
                preloaded = load_skill_tool.preload_skills(skills_to_preload)
                logger.info(
                    "[skill_factory] Preloaded %d previously used skills: %s",
                    len(preloaded),
                    preloaded,
                )

    logger.info(
        "[skill_factory] Created LoadSkillTool with skills: %s",
        skill_names,
    )

    return load_skill_tool


def _get_previously_used_skills(db: Any, task_id: int) -> list[str]:
    """
    Get list of skill names that were previously loaded in this conversation.

    Scans the thinking steps in completed subtasks to find load_skill tool calls.

    Args:
        db: Database session
        task_id: Task ID to search for previously used skills

    Returns:
        List of skill names that were previously loaded
    """
    from app.models.subtask import Subtask, SubtaskStatus

    used_skills: set[str] = set()

    try:
        # Query completed subtasks for this task
        subtasks = (
            db.query(Subtask)
            .filter(
                Subtask.task_id == task_id,
                Subtask.status == SubtaskStatus.COMPLETED,
            )
            .all()
        )

        for subtask in subtasks:
            if not subtask.result or not isinstance(subtask.result, dict):
                continue

            thinking = subtask.result.get("thinking", [])
            if not thinking:
                continue

            for step in thinking:
                if not isinstance(step, dict):
                    continue

                details = step.get("details", {})
                if not isinstance(details, dict):
                    continue

                # Check if this is a load_skill tool call
                tool_name = details.get("tool_name") or details.get("name")
                if tool_name == "load_skill":
                    # Extract the skill name from the input
                    tool_input = details.get("input", {})
                    if isinstance(tool_input, dict):
                        skill_name = tool_input.get("skill_name")
                        if skill_name:
                            used_skills.add(skill_name)

        logger.info(
            "[skill_factory] Found %d previously used skills for task %d: %s",
            len(used_skills),
            task_id,
            list(used_skills),
        )

    except Exception as e:
        logger.warning(
            "[skill_factory] Failed to get previously used skills for task %d: %s",
            task_id,
            str(e),
        )

    return list(used_skills)


def prepare_skill_tools(
    task_id: int,
    subtask_id: int,
    user_id: int,
    db_session: Any,
    skill_configs: list[dict[str, Any]],
) -> list[Any]:
    """
    Prepare skill tools dynamically using SkillToolRegistry.

    This function creates tool instances for all skills that have tool declarations
    in their SKILL.md configuration. It uses the plugin-based SkillToolRegistry
    to dynamically load and create tools.

    Args:
        task_id: Task ID for WebSocket room
        subtask_id: Subtask ID for correlation
        user_id: User ID for access control
        db_session: Database session for data access
        skill_configs: List of skill configurations from ChatConfig.skill_configs
            Each config contains: {"name": "...", "description": "...", "tools": [...],
                                   "provider": {...}, "skill_id": int}

    Returns:
        List of tool instances created from skill configurations
    """
    # Import SkillToolRegistry and context
    from app.chat_shell.skills import SkillToolContext, SkillToolRegistry
    from app.models.skill_binary import SkillBinary
    from app.services.chat.ws_emitter import get_ws_emitter

    tools: list[Any] = []

    # Get WebSocket emitter for tools that need real-time communication
    ws_emitter = get_ws_emitter()
    if not ws_emitter:
        logger.warning(
            "[skill_factory] WebSocket emitter not available, some skill tools may not work"
        )

    # Get the registry instance
    registry = SkillToolRegistry.get_instance()

    # Process each skill configuration
    for skill_config in skill_configs:
        skill_name = skill_config.get("name", "unknown")
        tool_declarations = skill_config.get("tools", [])
        provider_config = skill_config.get("provider")
        skill_id = skill_config.get("skill_id")
        skill_user_id = skill_config.get("skill_user_id")

        if not tool_declarations:
            # No tools declared for this skill, skip
            continue

        logger.info(
            "[skill_factory] Processing skill '%s' with %d tool declarations",
            skill_name,
            len(tool_declarations),
        )

        # Load provider from skill package if provider config is present
        # SECURITY: Only public skills (user_id=0) can load code
        if provider_config and skill_id:
            # Check if this is a public skill (user_id=0)
            is_public = skill_user_id == 0

            if not is_public:
                logger.warning(
                    "[skill_factory] SECURITY: Skipping code loading for non-public "
                    "skill '%s' (user_id=%s). Only public skills can load code.",
                    skill_name,
                    skill_user_id,
                )
            else:
                try:
                    # Get skill binary from database
                    skill_binary = (
                        db_session.query(SkillBinary)
                        .filter(SkillBinary.kind_id == skill_id)
                        .first()
                    )

                    if skill_binary and skill_binary.binary_data:
                        # Load and register the provider
                        loaded = registry.ensure_provider_loaded(
                            skill_name=skill_name,
                            provider_config=provider_config,
                            zip_content=skill_binary.binary_data,
                            is_public=is_public,
                        )
                        if loaded:
                            logger.info(
                                "[skill_factory] Loaded provider for skill '%s'",
                                skill_name,
                            )
                        else:
                            logger.warning(
                                "[skill_factory] Failed to load provider for skill '%s'",
                                skill_name,
                            )
                    else:
                        logger.warning(
                            "[skill_factory] No binary data found for skill '%s' (id=%d)",
                            skill_name,
                            skill_id,
                        )
                except Exception as e:
                    logger.error(
                        "[skill_factory] Error loading provider for skill '%s': %s",
                        skill_name,
                        str(e),
                    )

        # Create context for this skill
        context = SkillToolContext(
            task_id=task_id,
            subtask_id=subtask_id,
            user_id=user_id,
            db_session=db_session,
            ws_emitter=ws_emitter,
            skill_config=skill_config,
        )

        # Create tools using the registry
        skill_tools = registry.create_tools_for_skill(skill_config, context)
        tools.extend(skill_tools)

        if skill_tools:
            logger.info(
                "[skill_factory] Created %d tools for skill '%s': %s",
                len(skill_tools),
                skill_name,
                [t.name for t in skill_tools],
            )

    logger.info(
        "[skill_factory] Total skill tools created: %d",
        len(tools),
    )

    return tools
