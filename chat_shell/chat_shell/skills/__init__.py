# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tool dynamic loading module.

This module provides a configuration-driven, plugin-based architecture for
skill-tool bindings. Skills declare their tool dependencies in SKILL.md,
and tools are dynamically loaded at runtime based on skill configuration.

Providers are loaded on-demand from skill packages stored in the database,
not from hardcoded built-in providers. This allows skills to bundle their
own provider implementations.

Example usage:
    from chat_shell.skills import (
        SkillToolContext,
        SkillToolRegistry,
    )

    # Get registry instance
    registry = SkillToolRegistry.get_instance()

    # Load provider from skill (from database)
    registry.ensure_provider_loaded(
        skill_name="my-skill",
        provider_config={"module": "provider", "class": "MySkillToolProvider"},
        zip_content=skill_binary_data
    )

    # Create context
    context = SkillToolContext(
        task_id=task_id,
        subtask_id=subtask_id,
        user_id=user_id,
        db_session=db,
        ws_emitter=ws_emitter,
        skill_config=config,
    )

    # Create tools for a skill
    tools = registry.create_tools_for_skill(skill_config, context)
"""

from .context import SkillToolContext
from .provider import SkillToolProvider
from .registry import SkillToolRegistry

__all__ = [
    "SkillToolContext",
    "SkillToolProvider",
    "SkillToolRegistry",
]
