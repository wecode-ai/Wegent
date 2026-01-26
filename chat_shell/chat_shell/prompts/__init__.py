# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompts module for Chat Shell.

This module provides system prompt building utilities:
- Clarification mode prompt
- Deep thinking mode prompt
- Skill metadata prompt
- Knowledge base prompts (strict/relaxed modes)
- Binary attachment prompts (for sandbox download)
- Unified system prompt builder
"""

from .attachments import (
    append_binary_attachment_prompt,
    build_binary_attachment_prompt,
)
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
    # Binary attachment functions
    "build_binary_attachment_prompt",
    "append_binary_attachment_prompt",
]
