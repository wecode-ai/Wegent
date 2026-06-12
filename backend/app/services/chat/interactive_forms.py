# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Interactive form pending-state helpers for chat sends."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from app.models.subtask import SubtaskRole
from app.stores.tasks import subtask_store

INTERACTIVE_FORM_TOOL_MARKER = "interactive_form_question"


@dataclass(frozen=True)
class PendingInteractiveForm:
    """Pending interactive form metadata stored in an assistant tool block."""

    tool_use_id: str
    task_id: int
    assistant_subtask_id: int
    message_id: int


@dataclass(frozen=True)
class InteractiveFormValidationResult:
    """Validation result for sending into a task with a possible pending form."""

    ok: bool
    error: str | None = None
    message: str | None = None
    pending_form: PendingInteractiveForm | None = None


def _as_record(value: Any) -> dict[str, Any] | None:
    return value if isinstance(value, dict) else None


def _get_answer_value(answer: Any, key: str) -> Any:
    if isinstance(answer, dict):
        return answer.get(key)
    return getattr(answer, key, None)


def _extract_interactive_form_from_result(
    result: Any,
    *,
    task_id: int,
    assistant_subtask_id: int,
    message_id: int,
) -> PendingInteractiveForm | None:
    result_record = _as_record(result)
    if not result_record:
        return None

    blocks = result_record.get("blocks")
    if not isinstance(blocks, list):
        return None

    for block in reversed(blocks):
        block_record = _as_record(block)
        if not block_record:
            continue

        tool_name = str(block_record.get("tool_name") or "")
        if INTERACTIVE_FORM_TOOL_MARKER not in tool_name:
            continue

        tool_use_id = str(
            block_record.get("tool_use_id") or block_record.get("id") or ""
        ).strip()
        if not tool_use_id:
            continue

        render_payload = _as_record(block_record.get("render_payload"))
        if (
            not render_payload
            or render_payload.get("type") != INTERACTIVE_FORM_TOOL_MARKER
        ):
            continue

        questions = render_payload.get("questions")
        if isinstance(questions, list) and questions:
            return PendingInteractiveForm(
                tool_use_id=tool_use_id,
                task_id=task_id,
                assistant_subtask_id=assistant_subtask_id,
                message_id=message_id,
            )

    return None


def get_pending_interactive_form(
    db: Any,
    *,
    task_id: int,
) -> PendingInteractiveForm | None:
    """Return the latest unresolved interactive form for a task, if any."""
    subtasks = subtask_store.list_by_task_desc(db, task_id=task_id)

    for subtask in subtasks:
        if subtask.role == SubtaskRole.USER:
            return None

        if subtask.role != SubtaskRole.ASSISTANT:
            continue

        pending = _extract_interactive_form_from_result(
            subtask.result,
            task_id=task_id,
            assistant_subtask_id=subtask.id,
            message_id=subtask.message_id,
        )
        if pending:
            return pending

    return None


def validate_interactive_form_answer(
    db: Any,
    *,
    task_id: int,
    answer: Any,
) -> InteractiveFormValidationResult:
    """Validate chat sends against the task's pending interactive form state."""
    pending_form = get_pending_interactive_form(db, task_id=task_id)

    if pending_form is None:
        if answer:
            return InteractiveFormValidationResult(
                ok=False,
                error="interactive_form_not_pending",
                message="No pending interactive form is waiting for an answer.",
            )
        return InteractiveFormValidationResult(ok=True)

    if not answer:
        return InteractiveFormValidationResult(
            ok=False,
            error="pending_interactive_form",
            message="A pending interactive form must be submitted or cancelled first.",
            pending_form=pending_form,
        )

    answer_type = _get_answer_value(answer, "type")
    if answer_type != INTERACTIVE_FORM_TOOL_MARKER:
        return InteractiveFormValidationResult(
            ok=False,
            error="invalid_interactive_form_answer",
            message="Invalid interactive form answer payload.",
            pending_form=pending_form,
        )

    tool_use_id = str(_get_answer_value(answer, "tool_use_id") or "").strip()
    if not tool_use_id:
        return InteractiveFormValidationResult(
            ok=False,
            error="interactive_form_tool_required",
            message="Interactive form answers must include tool_use_id.",
            pending_form=pending_form,
        )

    if tool_use_id != pending_form.tool_use_id:
        return InteractiveFormValidationResult(
            ok=False,
            error="interactive_form_tool_mismatch",
            message="Interactive form answer does not match the pending tool call.",
            pending_form=pending_form,
        )

    return InteractiveFormValidationResult(ok=True, pending_form=pending_form)
