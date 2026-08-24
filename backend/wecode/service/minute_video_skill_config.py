# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Build private one-minute-video Skill runtime configuration."""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from sqlalchemy.orm import Session, selectinload

from app.models.subtask import Subtask, SubtaskRole
from app.models.subtask_context import SubtaskContext
from app.schemas.kind import Bot
from app.stores.tasks import subtask_store
from shared.models import ExecutionRequest
from shared.models.db import Kind

INJECT_GENERATION_CONTEXT = "inject_generation_context"
MAX_HISTORY_ITEMS = 5
HISTORY_SCAN_BATCH_SIZE = 20
MINUTE_VIDEO_DURATION_SECONDS = 60


def inject_minute_video_skill_config(
    db: Session,
    request: ExecutionRequest,
) -> None:
    """Inject the current video selection and materials into opted-in Skills."""
    target_skills = [
        skill
        for skill in request.skill_configs or []
        if _accepts_generation_context(skill)
    ]
    if not target_skills:
        return

    current_user_subtask = _get_current_user_subtask(db, request)
    if current_user_subtask is None:
        raise ValueError("Cannot resolve the user message for video Skill execution")

    fallback_model = _get_bot_primary_model(db, request)
    payload = _build_runtime_payload(
        db=db,
        current_user_subtask=current_user_subtask,
        fallback_model=fallback_model,
    )
    for skill in target_skills:
        config = dict(skill.get("config") or {})
        config.update(payload)
        skill["config"] = config


def _accepts_generation_context(skill: dict[str, Any]) -> bool:
    config = skill.get("config")
    return isinstance(config, dict) and config.get(INJECT_GENERATION_CONTEXT) is True


def _get_current_user_subtask(
    db: Session,
    request: ExecutionRequest,
) -> Subtask | None:
    assistant = subtask_store.get_by_id(
        db,
        subtask_id=request.subtask_id,
    )
    if assistant is None:
        return None
    if assistant.role == SubtaskRole.USER:
        return assistant
    if not assistant.parent_id:
        return None
    return subtask_store.get_user_by_task_message_id(
        db,
        task_id=assistant.task_id,
        message_id=assistant.parent_id,
    )


def _build_runtime_payload(
    *,
    db: Session,
    current_user_subtask: Subtask,
    fallback_model: str,
) -> dict[str, Any]:
    generation, material_errors = _build_generation(
        current_user_subtask,
        fallback_model=fallback_model,
    )
    payload: dict[str, Any] = {
        "prompt": current_user_subtask.prompt or "",
        "generation": generation,
    }
    history = _build_history(
        db,
        current_user_subtask=current_user_subtask,
        fallback_model=fallback_model,
    )
    if history:
        payload["history_generation"] = history
    if material_errors:
        payload["material_errors"] = material_errors
    return payload


def _build_history(
    db: Session,
    *,
    current_user_subtask: Subtask,
    fallback_model: str,
) -> list[dict[str, Any]]:
    history: list[dict[str, Any]] = []
    message_cursor = current_user_subtask.message_id
    while len(history) < MAX_HISTORY_ITEMS:
        subtasks = (
            db.query(Subtask)
            .options(selectinload(Subtask.contexts))
            .filter(
                Subtask.task_id == current_user_subtask.task_id,
                Subtask.role == SubtaskRole.USER,
                Subtask.message_id < message_cursor,
            )
            .order_by(Subtask.message_id.desc())
            .limit(HISTORY_SCAN_BATCH_SIZE)
            .all()
        )
        if not subtasks:
            break

        for subtask in subtasks:
            if not _is_previous_generation_turn(subtask, current_user_subtask):
                continue
            generation, _ = _build_generation(
                subtask,
                fallback_model=fallback_model,
            )
            history.append(
                {
                    "prompt": subtask.prompt or "",
                    "generation": generation,
                }
            )
            if len(history) == MAX_HISTORY_ITEMS:
                break
        message_cursor = subtasks[-1].message_id
    return history


def _is_previous_generation_turn(
    candidate: Subtask,
    current: Subtask,
) -> bool:
    return bool(
        candidate.role == SubtaskRole.USER
        and candidate.message_id < current.message_id
        and _has_generation_input(candidate)
    )


def _has_generation_input(subtask: Subtask) -> bool:
    result = subtask.result if isinstance(subtask.result, dict) else {}
    if isinstance(result.get("video_config"), dict):
        return True
    return any(_is_supported_media(context.mime_type) for context in subtask.contexts)


def _build_generation(
    subtask: Subtask,
    *,
    fallback_model: str,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    result = subtask.result if isinstance(subtask.result, dict) else {}
    video_config = result.get("video_config")
    if not isinstance(video_config, dict):
        video_config = {}

    model_name = str(video_config.get("model") or fallback_model).strip()
    if not model_name:
        raise ValueError("The one-minute-video Bot has no primary video model")

    content, material_errors = _build_material_content(subtask.contexts)
    content.append(
        {
            "type": "generate_params",
            "value": _build_generate_params(video_config),
        }
    )
    return (
        {
            "modelName": model_name,
            "modelDisplayName": str(
                video_config.get("model_display_name") or model_name
            ),
            "content": content,
        },
        material_errors,
    )


def _build_generate_params(video_config: dict[str, Any]) -> dict[str, Any]:
    params = {
        key: video_config.get(key)
        for key in ("resolution", "ratio", "generation_mode_id")
        if video_config.get(key) is not None
    }
    params["duration"] = MINUTE_VIDEO_DURATION_SECONDS
    return params


def _build_material_content(
    contexts: Iterable[SubtaskContext],
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    content: list[dict[str, Any]] = []
    errors: list[dict[str, Any]] = []
    seen: set[tuple[str, str]] = set()
    for context in contexts:
        media_type = _material_type(context.mime_type)
        if media_type is None:
            continue
        file_id = _material_file_id(context, media_type)
        if not file_id:
            errors.append(
                {
                    "attachment_id": context.id,
                    "name": context.original_filename,
                    "reason": f"missing_{media_type}_id",
                }
            )
            continue
        identity = (media_type, file_id)
        if identity in seen:
            continue
        seen.add(identity)
        content.append({"type": f"input_{media_type}", "file_id": file_id})
    return content, errors


def _is_supported_media(mime_type: str) -> bool:
    return _material_type(mime_type) is not None


def _material_type(mime_type: str) -> str | None:
    for media_type in ("image", "video", "audio"):
        if str(mime_type or "").startswith(f"{media_type}/"):
            return media_type
    return None


def _material_file_id(context: SubtaskContext, media_type: str) -> str:
    type_data = context.type_data if isinstance(context.type_data, dict) else {}
    if media_type == "image":
        return str(type_data.get("image_pid") or "").strip()
    upload = type_data.get(f"weibo_{media_type}_upload")
    if not isinstance(upload, dict):
        return ""
    return str(upload.get("media_id") or "").strip()


def _get_bot_primary_model(db: Session, request: ExecutionRequest) -> str:
    team = (
        db.query(Kind)
        .filter(
            Kind.id == request.team_id,
            Kind.kind == "Team",
            Kind.is_active,
        )
        .first()
    )
    if team is None:
        return ""
    bot = (
        db.query(Kind)
        .filter(
            Kind.user_id == team.user_id,
            Kind.kind == "Bot",
            Kind.namespace == request.bot_namespace,
            Kind.name == request.bot_name,
            Kind.is_active,
        )
        .first()
    )
    if bot is None:
        return ""
    bot_crd = Bot.model_validate(bot.json)
    if not bot_crd.spec or not bot_crd.spec.modelRef:
        return ""
    return bot_crd.spec.modelRef.name
