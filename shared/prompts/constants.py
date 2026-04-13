# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared prompt constants used across backend and chat_shell modules."""

import json
from typing import Any

# Marker that separates attachment/KB context from the actual user question.
# Used when context (attachments, documents, knowledge base) is prepended to
# a user message as a single string.  Both the producers (context preprocessing)
# and consumers (history loader, image/video agents) must use the same marker
# to ensure prefix-cache consistency across conversation turns.
USER_QUESTION_MARKER = "[User Question]:"


# XML tag used by the system-reminder block.  Frontend strips content
# wrapped in this tag when displaying messages.
_SYSTEM_REMINDER_OPEN = "<system-reminder>"

# Patterns that identify system-context text blocks in old stored formats.
# These blocks contain attachment metadata or markers — NOT user text.
_SYSTEM_CONTEXT_PREFIXES = ("<system-reminder>", "<attachment>", "<selected_documents>")


def _is_system_context_block(text: str) -> bool:
    """Return True when *text* looks like a system-injected context block."""
    stripped = text.lstrip()
    return stripped.startswith(_SYSTEM_CONTEXT_PREFIXES)


def parse_prompt_blocks(raw_prompt: str) -> tuple[str, list[dict[str, Any]]]:
    """Parse a stored prompt value into its text content and extra blocks.

    Identifies the user's actual message among stored content blocks and
    separates it from system-injected metadata (``<system-reminder>``,
    ``<attachment>``, etc.).

    **New format** (post-fix)::

        [{"type": "text", "text": "user message"},
         {"type": "text", "text": "<system-reminder>...</system-reminder>"}]

    **Old format** (pre-fix, images with marker)::

        [{"type": "text", "text": "<attachment>...</attachment>"},
         {"type": "text", "text": "[User Question]:\\nuser message"},
         {"type": "text", "text": "<system-reminder>...</system-reminder>"}]

    In both cases ``text_content`` is the user's own message (markers
    stripped) and ``extra_blocks`` contains blocks useful for LLM history
    reconstruction (``<system-reminder>`` blocks only; old ``<attachment>``
    blocks are discarded because they are rebuilt from ``SubtaskContext``).

    For plain-text prompts (not JSON) the original string is returned.
    If the string contains ``USER_QUESTION_MARKER``, only the user's question
    portion is extracted.

    Args:
        raw_prompt: Raw ``Subtask.prompt`` value from the database.

    Returns:
        A tuple of ``(text_content, extra_blocks)``.
    """
    # --- Try JSON array format first ---
    try:
        parsed = json.loads(raw_prompt)
        if isinstance(parsed, list) and all(isinstance(b, dict) for b in parsed):
            return _parse_block_list(parsed, raw_prompt)
    except (json.JSONDecodeError, ValueError):
        pass

    # --- Plain-text fallback ---
    # Old text-only attachment format may look like:
    #   "<attachment>...\n\n[User Question]:\nmessage"
    if USER_QUESTION_MARKER in raw_prompt:
        return extract_user_question(raw_prompt), []

    return raw_prompt, []


def _parse_block_list(
    blocks: list[dict[str, Any]],
    raw_prompt: str,
) -> tuple[str, list[dict[str, Any]]]:
    """Extract user message and extra blocks from a parsed JSON block list."""
    _TEXT_TYPES = {"text", "input_text"}
    user_text: str | None = None
    extra_blocks: list[dict[str, Any]] = []

    for block in blocks:
        if block.get("type") not in _TEXT_TYPES:
            # Skip non-text blocks (image_url, input_image, etc.)
            continue

        text = block.get("text", "")

        # System-reminder blocks → always kept as extra_blocks for LLM history
        if text.lstrip().startswith(_SYSTEM_REMINDER_OPEN):
            extra_blocks.append(block)
            continue

        # Old-format [User Question]: block → extract actual question
        if text.lstrip().startswith(USER_QUESTION_MARKER):
            if user_text is None:
                user_text = extract_user_question(text)
            continue

        # System-context blocks (<attachment>, <selected_documents>, etc.)
        # are discarded — they are rebuilt from SubtaskContext at load time.
        if _is_system_context_block(text):
            continue

        # First non-system text block → user message
        if user_text is None:
            user_text = text
        # Additional non-system text blocks → extra_blocks
        else:
            extra_blocks.append(block)

    if user_text is None:
        user_text = raw_prompt
    return user_text, extra_blocks


def extract_user_question(text: str) -> str:
    """Extract user-visible question from a context-wrapped prompt.

    The chat context preprocessor may build prompts like::

        "<attachment>...metadata...</attachment>\\n\\n[User Question]:\\n<message>"

    This function splits on the ``USER_QUESTION_MARKER`` and returns only the
    user's own text, stripping surrounding whitespace.  If the marker is absent
    the full text is returned as-is (stripped).

    Args:
        text: Raw prompt string, possibly containing context + marker + question.

    Returns:
        The user question portion of the prompt.
    """
    if not isinstance(text, str):
        return str(text)

    if USER_QUESTION_MARKER in text:
        after = text.split(USER_QUESTION_MARKER, 1)[1]
        return after.lstrip("\n").strip()

    return text.strip()
