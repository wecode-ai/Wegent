# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Prompt draft generation service."""

from __future__ import annotations

import asyncio
import logging
from typing import Any, AsyncIterator

from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.models.user import User
from app.services import chat_shell_model_service
from app.services.prompt_draft.modeling import (
    resolve_prompt_draft_model_config as _resolve_prompt_draft_model_config,
)
from app.services.prompt_draft.pipeline import (
    generate_prompt_draft_stream_result as _generate_prompt_draft_stream_result,
)
from app.services.prompt_draft.pipeline import (
    run_skill_generation as _run_prompt_draft_skill_generation,
)
from app.services.prompt_draft.pipeline import (
    stream_prompt_text_generation as _stream_prompt_draft_text_generation,
)
from app.services.prompt_draft.transcript import (
    collect_conversation_blocks as _collect_prompt_draft_conversation_blocks,
)
from app.services.task_member_service import task_member_service

logger = logging.getLogger(__name__)


class PromptDraftTaskNotFoundError(Exception):
    """Raised when the target task cannot be accessed by current user."""


class PromptDraftConversationTooShortError(Exception):
    """Raised when conversation content is insufficient for prompt extraction."""


class PromptDraftModelUnavailableError(Exception):
    """Raised when prompt draft generation has no usable model."""


class PromptDraftGenerationFailedError(Exception):
    """Raised when prompt draft generation fails."""


def _collect_conversation_blocks(db: Session, task_id: int) -> list[tuple[str, str]]:
    return _collect_prompt_draft_conversation_blocks(db, task_id)


def _resolve_model_config(
    db: Session,
    current_user: User,
    requested_model_name: str | None,
) -> tuple[dict[str, Any] | None, str]:
    return _resolve_prompt_draft_model_config(db, current_user, requested_model_name)


async def _run_skill_generation(
    model_config: dict[str, Any],
    conversation_blocks: list[tuple[str, str]],
    selected_model_name: str,
    task_id: int,
    user_id: int,
    current_prompt: str | None = None,
    regenerate: bool = False,
) -> dict[str, Any]:
    return await _run_prompt_draft_skill_generation(
        model_config=model_config,
        conversation_blocks=conversation_blocks,
        selected_model_name=selected_model_name,
        task_id=task_id,
        user_id=user_id,
        current_prompt=current_prompt,
        regenerate=regenerate,
    )


async def _stream_prompt_text_generation(
    *,
    model_id: str,
    input_messages: list[dict[str, str]],
    prompt_instructions: str,
    metadata: dict[str, Any],
    model_config: dict[str, Any],
) -> AsyncIterator[str]:
    async for delta in _stream_prompt_draft_text_generation(
        model_id=model_id,
        input_messages=input_messages,
        prompt_instructions=prompt_instructions,
        metadata=metadata,
        model_config=model_config,
    ):
        yield delta


def _prepare_prompt_draft_context(
    db: Session,
    task_id: int,
    current_user: User,
    model: str | None,
) -> dict[str, Any]:
    task = (
        db.query(TaskResource)
        .filter(
            TaskResource.id == task_id,
            TaskResource.kind == "Task",
            TaskResource.is_active.in_(
                [TaskResource.STATE_ACTIVE, TaskResource.STATE_SUBSCRIPTION]
            ),
        )
        .first()
    )
    if not task or not task_member_service.is_member(db, task_id, current_user.id):
        raise PromptDraftTaskNotFoundError("task_not_found")

    blocks = _collect_conversation_blocks(db, task_id)
    if len(blocks) < 2:
        raise PromptDraftConversationTooShortError("conversation_too_short")

    model_config, selected_model = _resolve_model_config(db, current_user, model)
    if not model_config:
        raise PromptDraftModelUnavailableError("prompt_draft_model_unavailable")

    return {
        "task": task,
        "blocks": blocks,
        "model_config": model_config,
        "selected_model": selected_model,
    }


def validate_prompt_draft_context(
    db: Session,
    task_id: int,
    current_user: User,
    model: str | None = None,
) -> None:
    """Validate preconditions for prompt draft generation."""

    _prepare_prompt_draft_context(
        db=db,
        task_id=task_id,
        current_user=current_user,
        model=model,
    )


async def generate_prompt_draft_stream(
    db: Session,
    task_id: int,
    current_user: User,
    model: str | None = None,
    source: str | None = None,
    current_prompt: str | None = None,
    regenerate: bool = False,
) -> AsyncIterator[dict[str, Any]]:
    """Generate prompt draft as stream events without DB persistence."""

    del source

    context = _prepare_prompt_draft_context(
        db=db,
        task_id=task_id,
        current_user=current_user,
        model=model,
    )
    try:
        async for event in _generate_prompt_draft_stream_result(
            selected_model=context["selected_model"],
            model_config=context["model_config"],
            conversation_blocks=context["blocks"],
            current_prompt=current_prompt,
            regenerate=regenerate,
        ):
            yield event
    except Exception as exc:
        logger.exception(
            "Prompt draft streaming generation failed: task_id=%s user_id=%s model=%s",
            task_id,
            current_user.id,
            context["selected_model"],
        )
        raise PromptDraftGenerationFailedError(
            "prompt_draft_generation_failed"
        ) from exc


def generate_prompt_draft(
    db: Session,
    task_id: int,
    current_user: User,
    model: str | None = None,
    source: str | None = None,
    current_prompt: str | None = None,
    regenerate: bool = False,
) -> dict[str, Any]:
    """Generate a prompt draft from task conversation."""

    del source

    context = _prepare_prompt_draft_context(
        db=db,
        task_id=task_id,
        current_user=current_user,
        model=model,
    )
    task = context["task"]
    try:
        return asyncio.run(
            _run_skill_generation(
                model_config=context["model_config"],
                conversation_blocks=context["blocks"],
                selected_model_name=context["selected_model"],
                task_id=task.id,
                user_id=current_user.id,
                current_prompt=current_prompt,
                regenerate=regenerate,
            )
        )
    except Exception as exc:
        logger.exception(
            "Prompt draft generation failed: task_id=%s user_id=%s model=%s",
            task.id,
            current_user.id,
            context["selected_model"],
        )
        raise PromptDraftGenerationFailedError(
            "prompt_draft_generation_failed"
        ) from exc
