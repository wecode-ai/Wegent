# SPDX-FileCopyrightText: 2025 WeCode, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Base classes for skill tool dynamic loading.

This module re-exports the core abstractions for the skill-tool binding system
from their respective modules for backward compatibility:
- SkillToolContext: Context object with dependencies for tool creation
- SkillToolProvider: Abstract base class for tool providers
- SkillToolRegistry: Singleton registry for tool providers

The registry supports dynamic loading of providers from skill packages
stored in the database, allowing skills to bundle their own provider implementations.

Note: This module exists for backward compatibility. New code should import
directly from the specific modules:
- from app.services.chat_v2.skills.context import SkillToolContext
- from app.services.chat_v2.skills.provider import SkillToolProvider
- from app.services.chat_v2.skills.registry import SkillToolRegistry
"""

from .context import SkillToolContext
from .provider import SkillToolProvider
from .registry import SkillToolRegistry

__all__ = [
    "SkillToolContext",
    "SkillToolProvider",
    "SkillToolRegistry",
]
