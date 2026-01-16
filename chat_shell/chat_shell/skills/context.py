# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Skill tool context for dependency injection.

This module provides the SkillToolContext dataclass that carries
all dependencies needed by tool providers to create tool instances.
"""

from dataclasses import dataclass, field
from typing import Any


@dataclass
class SkillToolContext:
    """Context for creating skill-specific tools.

    This context provides all the dependencies that a tool provider
    might need to create tool instances. It follows the dependency
    injection pattern to avoid tight coupling.

    Attributes:
        task_id: Current task ID for WebSocket room targeting
        subtask_id: Current subtask ID for correlation
        user_id: User ID for access control and personalization
        db_session: Database session for data access
        ws_emitter: WebSocket emitter for real-time communication
        skill_config: Skill-specific configuration from SKILL.md
    """

    task_id: int
    subtask_id: int
    user_id: int
    db_session: Any  # SQLAlchemy AsyncSession
    ws_emitter: Any  # WebSocket emitter
    skill_config: dict[str, Any] = field(default_factory=dict)
    user_name: str = ""

    def get_config(self, key: str, default: Any = None) -> Any:
        """Get a configuration value from skill config.

        Args:
            key: Configuration key to retrieve
            default: Default value if key not found

        Returns:
            Configuration value or default
        """
        return self.skill_config.get(key, default)
