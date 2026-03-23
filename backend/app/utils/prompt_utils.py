# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Utilities for normalising user prompt values for display.

When chat mode sends a message with `inject_datetime=True`, the user message is
stored in ``Subtask.prompt`` as a JSON array of content blocks:

    [{"type": "text", "text": "<user text>"}, {"type": "text", "text": "<system-reminder>..."}]

The system-reminder block carries the current time for the LLM but must not be
shown to users in the chat UI.  This module provides a single helper that strips
internal blocks and returns only the human-visible portion of the prompt.
"""

import logging
from typing import Optional

from shared.prompts.constants import parse_prompt_blocks

logger = logging.getLogger(__name__)


def extract_display_prompt(prompt: Optional[str]) -> Optional[str]:
    """Return the user-visible text from a stored prompt value.

    * Plain-text prompts are returned as-is.
    * JSON-array prompts (multi-block format) return only the text of the first
      ``type=text`` block, which is always the user's original message.

    Args:
        prompt: Raw ``Subtask.prompt`` value from the database.

    Returns:
        The human-readable text, or ``None`` if the input is ``None`` / empty.
    """
    if not prompt:
        return prompt

    text_content, extra_blocks = parse_prompt_blocks(prompt)
    # When extra_blocks is non-empty the prompt was a JSON array; return
    # only the first text block (the user's message).
    if extra_blocks or text_content != prompt:
        return text_content

    return prompt
