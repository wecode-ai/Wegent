# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build untrusted context from explicitly referenced previous tasks."""

from __future__ import annotations

from html import escape
from secrets import token_hex
from typing import Any, Iterable

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.subtask_context import ContextStatus, ContextType
from app.models.task import TaskResource
from app.services.prompt_draft.transcript import extract_assistant_turn_blocks
from app.stores.tasks import subtask_store, task_access_store, task_store
from app.utils.prompt_utils import extract_display_prompt
from shared.prompts.constants import (
    REFERENCED_CONVERSATIONS_CLOSE,
    REFERENCED_CONVERSATIONS_FOCUS_CURRENT,
    REFERENCED_CONVERSATIONS_FOCUS_HISTORY,
    REFERENCED_CONVERSATIONS_PREAMBLE,
    REFERENCED_CONVERSATIONS_TAG,
)

MAX_REFERENCE_MESSAGES = 100
MAX_REFERENCE_CHARS = 100_000
MAX_TOTAL_REFERENCE_CHARS = 200_000
# Tool-attempt notes are cheap but numerous; keep the most recent ones only.
MAX_ATTEMPT_NOTES = 20
# Older assistant replies are shortened to this size before any entry is
# dropped, so more of the referenced task's turns survive the budget.
ASSISTANT_SNIPPET_CHARS = 1_200


def resolve_conversation_reference(
    db: Session,
    *,
    task_id: int,
    user_id: int,
) -> tuple[TaskResource, str]:
    """Return an accessible task and its display title."""
    task = task_store.get_by_id(db, task_id=task_id)
    if task is None or not task_access_store.is_member(
        db, task_id=task_id, user_id=user_id
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Referenced task is unavailable",
        )
    return task, _task_title(task)


def validate_conversation_references(
    db: Session,
    *,
    contexts: Iterable[Any] | None,
    user_id: int,
    current_task_id: int | None = None,
) -> None:
    """Validate conversation references before any task or subtask is persisted."""
    seen_task_ids: set[int] = set()
    for context in contexts or []:
        if context.type != ContextType.CONVERSATION.value:
            continue
        data = context.data if isinstance(context.data, dict) else {}
        try:
            task_id = int(data.get("task_id"))
        except (TypeError, ValueError) as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid conversation reference",
            ) from exc
        if current_task_id is not None and task_id == current_task_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Cannot reference the current task",
            )
        if task_id in seen_task_ids:
            continue
        seen_task_ids.add(task_id)
        resolve_conversation_reference(db, task_id=task_id, user_id=user_id)
        subtasks = subtask_store.list_by_task(
            db,
            task_id=task_id,
            user_id=user_id,
            access_store=task_access_store,
            limit=MAX_REFERENCE_MESSAGES,
            from_latest=True,
        )
        if not _conversation_blocks(subtasks):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Referenced task has no conversation content",
            )


def build_conversation_reference_context(
    db: Session,
    *,
    task_id: int,
    user_id: int,
    max_chars: int = MAX_REFERENCE_CHARS,
    focus: str = "current",
) -> str:
    """Render one accessible task as explicit, untrusted model context.

    ``focus`` marks whether the reference belongs to the message being sent
    (``current``) or was replayed from earlier history, so the model can pick
    the right state when a session and its reference disagree.
    """
    task, title = resolve_conversation_reference(db, task_id=task_id, user_id=user_id)
    subtasks = subtask_store.list_by_task(
        db,
        task_id=task_id,
        user_id=user_id,
        access_store=task_access_store,
        limit=MAX_REFERENCE_MESSAGES + 1,
        from_latest=True,
    )
    window_omitted = max(0, len(subtasks) - MAX_REFERENCE_MESSAGES)
    if window_omitted:
        subtasks = subtasks[-MAX_REFERENCE_MESSAGES:]
    blocks = _conversation_blocks(subtasks)
    if not blocks:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Referenced task has no conversation content",
        )

    rendered, character_omitted = _bounded_transcript(blocks, max_chars=max_chars)
    omitted_count = window_omitted + character_omitted
    omitted_note = (
        f"\n[Earlier messages omitted: {omitted_count}]" if omitted_count else ""
    )
    # A random boundary prevents transcript text from closing the untrusted block.
    boundary = token_hex(8)
    focus_note = (
        REFERENCED_CONVERSATIONS_FOCUS_HISTORY
        if focus == "history"
        else REFERENCED_CONVERSATIONS_FOCUS_CURRENT
    )
    focus_attr = "history" if focus == "history" else "current"
    return "\n".join(
        [
            f'{REFERENCED_CONVERSATIONS_TAG} focus="{focus_attr}">',
            REFERENCED_CONVERSATIONS_PREAMBLE,
            focus_note,
            (
                f'<referenced_conversation id="{boundary}" task_id="{task.id}" '
                f'title="{escape(title, quote=True)}">'
            ),
            f"{omitted_note}{rendered}".strip(),
            f'</referenced_conversation id="{boundary}">',
            REFERENCED_CONVERSATIONS_CLOSE,
        ]
    )


def build_conversation_references_prompt(
    db: Session,
    *,
    contexts: Iterable[Any],
    user_id: int,
    focus: str = "current",
) -> str:
    """Build all conversation reference blocks for a user message."""
    references: list[str] = []
    seen_task_ids: set[int] = set()
    remaining_chars = MAX_TOTAL_REFERENCE_CHARS
    omitted_references = 0
    unavailable_references = 0
    for context in contexts:
        if context.context_type != ContextType.CONVERSATION.value:
            continue
        if context.status != ContextStatus.READY.value:
            continue
        type_data = context.type_data if isinstance(context.type_data, dict) else {}
        try:
            task_id = int(type_data.get("task_id"))
        except (TypeError, ValueError):
            continue
        if task_id in seen_task_ids:
            continue
        seen_task_ids.add(task_id)
        if remaining_chars <= 0:
            omitted_references += 1
            continue
        try:
            reference = build_conversation_reference_context(
                db,
                task_id=task_id,
                user_id=user_id,
                max_chars=min(MAX_REFERENCE_CHARS, remaining_chars),
                focus=focus,
            )
        except HTTPException:
            # A referenced task can be deleted or lose the reader's access
            # between validation and rendering; one stale reference must not
            # drop the rest.
            unavailable_references += 1
            continue
        references.append(reference)
        remaining_chars -= len(reference)
    if omitted_references:
        references.append(
            "[Additional referenced conversations omitted because the context budget "
            f"was exhausted: {omitted_references}]"
        )
    if unavailable_references:
        references.append(
            "[Referenced conversations skipped because they are no longer "
            f"available: {unavailable_references}]"
        )
    return "\n\n".join(references)


def prepend_conversation_reference_context(
    message: Any,
    reference_prompt: str,
) -> Any:
    """Prepend reference context as its own block.

    The context must stay a separate content block: chat_shell persists only
    the user's own text block back to ``Subtask.prompt``, so keeping the
    transcripts apart is what stops them from showing up as the user's
    message.
    """
    if not reference_prompt:
        return message
    reference_block = {"type": "input_text", "text": reference_prompt}
    if isinstance(message, list):
        return [reference_block, *message]
    return [reference_block, {"type": "input_text", "text": message}]


def _task_title(task: TaskResource) -> str:
    """Return the task title used in the reference wrapper."""
    task_json = task.json if isinstance(task.json, dict) else {}
    spec = task_json.get("spec") if isinstance(task_json.get("spec"), dict) else {}
    title = str(spec.get("title") or task.name or task.id).strip()
    return title or str(task.id)


def _conversation_blocks(subtasks: Iterable[Any]) -> list[tuple[str, str]]:
    """Render stored subtasks into ordered role/content pairs."""
    blocks: list[tuple[str, str]] = []
    for subtask in subtasks:
        if subtask.status == SubtaskStatus.DELETE:
            continue
        if subtask.role == SubtaskRole.USER:
            content = (extract_display_prompt(subtask.prompt) or "").strip()
            if content:
                blocks.append(("user", content))
            continue
        if subtask.role == SubtaskRole.ASSISTANT:
            assistant_blocks = extract_assistant_turn_blocks(subtask.result)
            blocks.extend(assistant_blocks or _assistant_text_blocks(subtask.result))
    return blocks


def _assistant_text_blocks(result: Any) -> list[tuple[str, str]]:
    """Extract assistant text blocks when no final value is stored."""
    if not isinstance(result, dict):
        return []
    stored_blocks = result.get("blocks")
    if not isinstance(stored_blocks, list):
        return []
    texts: list[str] = []
    for block in stored_blocks:
        if not isinstance(block, dict) or block.get("type") != "text":
            continue
        content = block.get("content") or block.get("text")
        if isinstance(content, str) and content.strip():
            texts.append(content.strip())
    return [("assistant", "\n".join(texts))] if texts else []


def _bounded_transcript(
    blocks: list[tuple[str, str]],
    *,
    max_chars: int,
) -> tuple[str, int]:
    """Fit a transcript into a character budget, degrading in fixed stages.

    Entries are escaped before they are measured, so a transcript full of
    ``&``/``<`` cannot expand past the budget once it reaches the prompt.

    Degradation order, cheapest loss first: drop tool-attempt notes, shorten
    older assistant replies, then drop whole entries from the oldest end. The
    newest assistant reply is never shortened, so the referenced task's latest
    conclusion always reaches the model intact.
    """
    blocks = _select_transcript_blocks(blocks)
    omitted = 0

    rendered = _render_transcript(blocks)
    if len(rendered) <= max_chars:
        return rendered, omitted

    without_attempts = [
        (role, content) for role, content in blocks if role != "assistant_attempt"
    ]
    if len(without_attempts) != len(blocks):
        blocks = without_attempts
        rendered = _render_transcript(blocks)
        if len(rendered) <= max_chars:
            return rendered, omitted

    newest_assistant = max(
        (index for index, (role, _) in enumerate(blocks) if role == "assistant"),
        default=None,
    )
    shortened: list[tuple[str, str]] = []
    changed = False
    for index, (role, content) in enumerate(blocks):
        if (
            role == "assistant"
            and index != newest_assistant
            and len(content) > ASSISTANT_SNIPPET_CHARS
        ):
            shortened.append((role, _shorten_assistant_reply(content)))
            changed = True
            continue
        shortened.append((role, content))
    if changed:
        blocks = shortened
        rendered = _render_transcript(blocks)
        if len(rendered) <= max_chars:
            return rendered, omitted

    kept: list[str] = []
    total_chars = 0
    for role, content in reversed(blocks):
        rendered = _render_block(role, escape(content, quote=False))
        separator_chars = 1 if kept else 0
        if total_chars + len(rendered) + separator_chars > max_chars:
            if not kept:
                rendered = rendered[-max_chars:]
                kept.append(rendered)
            break
        kept.append(rendered)
        total_chars += len(rendered) + separator_chars
    kept.reverse()
    omitted += max(0, len(blocks) - len(kept))
    return "\n".join(kept), omitted


def _select_transcript_blocks(
    blocks: list[tuple[str, str]],
) -> list[tuple[str, str]]:
    """Drop repeated replies and cap how many tool-attempt notes are kept.

    Only assistant replies are deduplicated: repeated user messages (for
    example a terse "next round" instruction) are part of the conversation's
    turn structure and dropping them would leave their replies orphaned.
    """
    seen: set[tuple[str, str]] = set()
    deduplicated: list[tuple[str, str]] = []
    for role, content in reversed(blocks):
        if role == "assistant" and content in seen:
            continue
        if role == "assistant":
            seen.add(content)
        deduplicated.append((role, content))
    deduplicated.reverse()

    attempt_indexes = [
        index
        for index, (role, _) in enumerate(deduplicated)
        if role == "assistant_attempt"
    ]
    if len(attempt_indexes) <= MAX_ATTEMPT_NOTES:
        return deduplicated
    dropped = set(attempt_indexes[:-MAX_ATTEMPT_NOTES])
    return [block for index, block in enumerate(deduplicated) if index not in dropped]


def _render_transcript(blocks: list[tuple[str, str]]) -> str:
    return "\n".join(
        _render_block(role, escape(content, quote=False)) for role, content in blocks
    )


def _shorten_assistant_reply(content: str) -> str:
    """Keep the head and tail of a long reply so its conclusion survives."""
    head_chars = ASSISTANT_SNIPPET_CHARS * 3 // 5
    tail_chars = ASSISTANT_SNIPPET_CHARS - head_chars
    omitted = len(content) - ASSISTANT_SNIPPET_CHARS
    return (
        f"{content[:head_chars].rstrip()}\n"
        f"[…{omitted} characters omitted…]\n"
        f"{content[-tail_chars:].lstrip()}"
    )


def _render_block(role: str, content: str) -> str:
    """Render one transcript entry with a normalized role label."""
    normalized_role = "assistant" if role == "assistant_attempt" else role
    return f"[{normalized_role}]\n{content.strip()}"
