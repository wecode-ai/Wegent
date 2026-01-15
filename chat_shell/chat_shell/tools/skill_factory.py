# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tools factory module.

Responsible for:
- Creating LoadSkillTool
- Dynamically creating skill tools

In HTTP mode, skill binaries are downloaded from backend API.
"""

import logging
from typing import Any, Optional

import httpx

from chat_shell.core.config import settings

logger = logging.getLogger(__name__)


def prepare_load_skill_tool(
    skill_names: list[str],
    user_id: int,
    skill_configs: list[dict] | None = None,
) -> Optional[Any]:
    """
    Prepare LoadSkillTool if skills are configured.

    This function creates a LoadSkillTool instance that allows the model
    to dynamically load skill prompts on demand.

    Skills with preload=True are filtered out from the available skill list,
    as they will be preloaded via preload_skill_prompt() and don't need to be
    loaded dynamically.

    Args:
        skill_names: List of skill names available for this session
        user_id: User ID for skill lookup
        skill_configs: Optional skill configurations containing prompts and preload flags

    Returns:
        LoadSkillTool instance or None if no skills configured
    """
    if not skill_names:
        return None

    # Import LoadSkillTool
    from chat_shell.tools.builtin import LoadSkillTool

    # Build skill metadata from skill_configs
    skill_metadata = {}
    if skill_configs:
        for config in skill_configs:
            name = config.get("name")
            if name:
                skill_metadata[name] = {
                    "description": config.get("description", ""),
                    "prompt": config.get("prompt", ""),
                    "displayName": config.get("displayName", ""),
                }

    # Create LoadSkillTool with the available skills
    load_skill_tool = LoadSkillTool(
        user_id=user_id,
        skill_names=skill_names,
        skill_metadata=skill_metadata,
    )

    logger.info(
        "[skill_factory] Created LoadSkillTool with skills: %s",
        skill_names,
    )

    return load_skill_tool


async def _download_skill_binary(download_url: str, skill_name: str) -> Optional[bytes]:
    """
    Download skill binary from backend API.

    Args:
        download_url: URL to download skill binary from
        skill_name: Skill name for logging

    Returns:
        Binary data or None if download failed
    """
    try:
        # Get service token from settings
        service_token = getattr(settings, "INTERNAL_SERVICE_TOKEN", None)
        if not service_token:
            service_token = getattr(settings, "REMOTE_STORAGE_TOKEN", "")

        headers = {}
        if service_token:
            headers["Authorization"] = f"Bearer {service_token}"

        async with httpx.AsyncClient(timeout=30.0) as client:
            response = await client.get(download_url, headers=headers)
            response.raise_for_status()

            logger.debug(
                "[skill_factory] Downloaded skill binary for '%s': %d bytes",
                skill_name,
                len(response.content),
            )
            return response.content

    except httpx.HTTPStatusError as e:
        logger.error(
            "[skill_factory] HTTP error downloading skill '%s' from %s: %d %s",
            skill_name,
            download_url,
            e.response.status_code,
            e.response.text[:200] if e.response.text else "",
        )
    except Exception as e:
        logger.error(
            "[skill_factory] Error downloading skill '%s' from %s: %s",
            skill_name,
            download_url,
            str(e),
        )

    return None


async def prepare_skill_tools(
    task_id: int,
    subtask_id: int,
    user_id: int,
    skill_configs: list[dict[str, Any]],
    ws_emitter: Any = None,
    load_skill_tool: Optional[Any] = None,
    preload_skills: Optional[list[str]] = None,
    user_name: str = "",
) -> list[Any]:
    """
    Prepare skill tools dynamically using SkillToolRegistry.

    This function creates tool instances for all skills that have tool declarations
    in their SKILL.md configuration. It uses the plugin-based SkillToolRegistry
    to dynamically load and create tools.

    Skill binaries are downloaded from backend API using REMOTE_STORAGE_URL.

    When a load_skill_tool is provided, this function will preload skills specified
    in preload_skills by calling preload_skill_prompt(). These skills will be automatically
    injected into the system prompt via prompt_modifier.

    Args:
        task_id: Task ID for WebSocket room
        subtask_id: Subtask ID for correlation
        user_id: User ID for access control
        skill_configs: List of skill configurations from ChatConfig.skill_configs
            Each config contains: {"name": "...", "description": "...", "tools": [...],
                                   "provider": {...}, "skill_id": int}
        ws_emitter: Optional WebSocket emitter for real-time communication
        load_skill_tool: Optional LoadSkillTool instance to preload skill prompts
        preload_skills: Optional list of skill names to preload into system prompt.
                       Skills in this list will have their prompts injected automatically.
        user_name: Username for identifying the user

    Returns:
        List of tool instances created from skill configurations
    """
    from chat_shell.skills import SkillToolContext, SkillToolRegistry

    tools: list[Any] = []

    if not ws_emitter:
        # In HTTP mode, WebSocket is not used, so this is expected
        logger.debug(
            "[skill_factory] WebSocket emitter not available (expected in HTTP mode)"
        )

    # Get the registry instance
    registry = SkillToolRegistry.get_instance()

    # Get base URL for skill binary downloads
    remote_url = getattr(settings, "REMOTE_STORAGE_URL", "").rstrip("/")

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

        logger.debug(
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
                    binary_data = None

                    # Download from backend API
                    if remote_url and skill_id:
                        download_url = f"{remote_url}/skills/{skill_id}/binary"
                        binary_data = await _download_skill_binary(
                            download_url, skill_name
                        )

                    if binary_data:
                        # Load and register the provider
                        loaded = registry.ensure_provider_loaded(
                            skill_name=skill_name,
                            provider_config=provider_config,
                            zip_content=binary_data,
                            is_public=is_public,
                        )
                        if not loaded:
                            logger.warning(
                                "[skill_factory] Failed to load provider for skill '%s'",
                                skill_name,
                            )
                    else:
                        logger.warning(
                            "[skill_factory] No binary data found for skill '%s' (id=%s)",
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
            db_session=None,
            ws_emitter=ws_emitter,
            skill_config=skill_config,
            user_name=user_name,
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

            # Preload skill prompt into LoadSkillTool if skill is in preload_skills list
            # This ensures the skill prompt is injected into system message
            # via prompt_modifier when the skill should be preloaded
            should_preload = preload_skills is not None and skill_name in preload_skills
            if load_skill_tool is not None and should_preload:
                skill_prompt = skill_config.get("prompt", "")
                if skill_prompt:
                    load_skill_tool.preload_skill_prompt(skill_name, skill_config)
                    logger.info(
                        "[skill_factory] Preloaded skill prompt for '%s' (in preload_skills list)",
                        skill_name,
                    )
            elif not should_preload:
                logger.debug(
                    "[skill_factory] Skipped preload for skill '%s' (not in preload_skills list, will use load_skill tool)",
                    skill_name,
                )

    # Log summary of all skills loaded
    if tools:
        tool_names = [t.name for t in tools]
        logger.info(
            "[skill_factory] Loaded %d skill tools: %s",
            len(tools),
            tool_names,
        )

    return tools
