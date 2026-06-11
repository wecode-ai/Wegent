# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for passing context between pipeline bot stages."""

from typing import Any

from sqlalchemy.orm import Session

from app.models.subtask import Subtask, SubtaskRole
from app.utils.prompt_utils import extract_display_prompt

CONTEXT_PASSING_NONE = "none"
CONTEXT_PASSING_ORIGINAL_USER = "original_user"
CONTEXT_PASSING_PREVIOUS_BOT = "previous_bot"
CONTEXT_PASSING_ORIGINAL_AND_PREVIOUS = "original_and_previous"

VALID_CONTEXT_PASSING_MODES = {
    CONTEXT_PASSING_NONE,
    CONTEXT_PASSING_ORIGINAL_USER,
    CONTEXT_PASSING_PREVIOUS_BOT,
    CONTEXT_PASSING_ORIGINAL_AND_PREVIOUS,
}


def normalize_context_passing(value: str | None) -> str:
    """Return a supported context-passing mode."""
    if value in VALID_CONTEXT_PASSING_MODES:
        return value
    return CONTEXT_PASSING_NONE


def build_pipeline_context_prompt(
    db: Session,
    *,
    task_id: int,
    current_subtask: Subtask,
    context_passing: str | None,
) -> str:
    """Build the prompt to pass from one pipeline stage to the next."""
    mode = normalize_context_passing(context_passing)
    if mode == CONTEXT_PASSING_NONE:
        return ""

    parts: list[str] = []
    if mode in (CONTEXT_PASSING_ORIGINAL_USER, CONTEXT_PASSING_ORIGINAL_AND_PREVIOUS):
        original_prompt = _get_original_user_prompt(db, task_id, current_subtask)
        if original_prompt:
            parts.append(f"Original user request:\n{original_prompt}")

    if mode in (CONTEXT_PASSING_PREVIOUS_BOT, CONTEXT_PASSING_ORIGINAL_AND_PREVIOUS):
        previous_output = _extract_previous_stage_output(current_subtask.result)
        if previous_output:
            parts.append(f"Previous stage output:\n{previous_output}")

    return "\n\n".join(parts)


def _get_original_user_prompt(
    db: Session,
    task_id: int,
    current_subtask: Subtask,
) -> str:
    user_subtask = (
        db.query(Subtask)
        .filter(
            Subtask.task_id == task_id,
            Subtask.role == SubtaskRole.USER,
            Subtask.message_id < current_subtask.message_id,
        )
        .order_by(Subtask.message_id.asc())
        .first()
    )
    if not user_subtask:
        return ""
    return (extract_display_prompt(user_subtask.prompt) or "").strip()


def _extract_previous_stage_output(result: Any) -> str:
    if not isinstance(result, dict):
        return ""

    value = result.get("value")
    if isinstance(value, str) and value.strip():
        return value.strip()

    messages_chain = result.get("messages_chain")
    if not isinstance(messages_chain, list):
        return ""

    for message in reversed(messages_chain):
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = _content_to_text(message.get("content"))
        if content:
            return content
    return ""


def _content_to_text(content: Any) -> str:
    if isinstance(content, str):
        return content.strip()
    if not isinstance(content, list):
        return ""

    text_parts: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        text = block.get("text")
        if isinstance(text, str) and text.strip():
            text_parts.append(text.strip())
    return "\n".join(text_parts)
