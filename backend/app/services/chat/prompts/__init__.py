# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompts module for Chat Service.

This module provides system prompt building utilities:
- Clarification mode prompt
- Deep thinking mode prompt
- Skill metadata prompt
"""

from .builder import (
    CLARIFICATION_PROMPT,
    DEEP_THINKING_PROMPT,
    SKILL_METADATA_PROMPT,
    append_clarification_prompt,
    append_deep_thinking_prompt,
    append_skill_metadata_prompt,
    get_clarification_prompt,
    get_deep_thinking_prompt,
)

__all__ = [
    # Prompts
    "CLARIFICATION_PROMPT",
    "DEEP_THINKING_PROMPT",
    "SKILL_METADATA_PROMPT",
    # Functions
    "get_clarification_prompt",
    "append_clarification_prompt",
    "get_deep_thinking_prompt",
    "append_deep_thinking_prompt",
    "append_skill_metadata_prompt",
]
