# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompts module for Chat Shell.

This module provides system prompt building utilities:
- Clarification mode prompt
- Deep thinking mode prompt
- Skill metadata prompt
- Knowledge base prompts (strict/relaxed modes)
- Unified system prompt builder
"""

from .builder import (
    CLARIFICATION_PROMPT,
    DEEP_THINKING_PROMPT,
    SKILL_METADATA_PROMPT,
    append_clarification_prompt,
    append_deep_thinking_prompt,
    append_skill_metadata_prompt,
    build_system_prompt,
    get_clarification_prompt,
    get_deep_thinking_prompt,
)
from .knowledge_base import (
    KB_PROMPT_RELAXED,
    KB_PROMPT_STRICT,
)

__all__ = [
    # Prompts
    "CLARIFICATION_PROMPT",
    "DEEP_THINKING_PROMPT",
    "SKILL_METADATA_PROMPT",
    "KB_PROMPT_STRICT",
    "KB_PROMPT_RELAXED",
    # Functions
    "get_clarification_prompt",
    "append_clarification_prompt",
    "get_deep_thinking_prompt",
    "append_deep_thinking_prompt",
    "append_skill_metadata_prompt",
    "build_system_prompt",
]
