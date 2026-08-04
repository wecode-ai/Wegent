# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for REST-created device chat tasks."""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session, make_transient

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.device import DeviceType
from app.schemas.device_chat_task import (
    DeviceChatTaskRequest,
    DeviceChatTaskResponse,
)
from app.services.chat.config import is_deep_research_protocol
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import (
    TaskCreationParams,
    create_chat_task,
    get_task_with_access_check,
)
from app.services.chat.task_device_resolution import (
    resolve_chat_task_dispatch_device_id,
    resolve_online_local_executor_device_id,
)
from app.services.chat.trigger import (
    collect_completed_result,
    persist_completed_result,
    should_trigger_ai_response,
    trigger_ai_response_unified,
)
from app.services.chat.wework_task_defaults import apply_wework_task_defaults
from app.services.device_service import device_service

logger = logging.getLogger(__name__)


async def create_device_chat_task(
    *,
    db: Session,
    user: User,
    request: DeviceChatTaskRequest,
    auth_token: str = "",
) -> DeviceChatTaskResponse:
    """Create or continue a device chat task from a REST request."""

    team = _get_team(db, request.team_id)
    existing_task = _get_existing_task(
        db,
        task_id=request.task_id,
        user_id=user.id,
    )
    if request.task_id and is_deep_research_protocol(db, team):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Deep Research does not support follow-up questions. "
                "Please start a new conversation."
            ),
        )

    trigger_ai = should_trigger_ai_response(
        existing_task.json if existing_task and existing_task.json else {},
        request.message,
        team.name,
        request_is_group_chat=False,
    )
    _, rag_prompt = await process_context_and_rag(
        message=request.message,
        contexts=request.contexts,
        should_trigger_ai=trigger_ai,
        user_id=user.id,
        db=db,
    )

    params = _build_task_creation_params(request)
    if existing_task is not None:
        params.client_origin = existing_task.client_origin or params.client_origin
    elif request.client_origin == CLIENT_ORIGIN_WEWORK:
        params = await apply_wework_task_defaults(db, user=user, params=params)
    params.device_id = await _resolve_device_id(
        db=db,
        user_id=user.id,
        params=params,
        task=existing_task,
        allow_default=not request.device_id,
    )

    result = await create_chat_task(
        db=db,
        user=user,
        team=team,
        message=request.message,
        params=params,
        task_id=request.task_id,
        should_trigger_ai=trigger_ai,
        rag_prompt=rag_prompt,
        source="web",
    )
    _link_contexts_to_user_subtask(
        db=db,
        user=user,
        task=result.task,
        user_subtask=result.user_subtask,
        request=request,
    )

    if result.ai_triggered and result.assistant_subtask:
        _schedule_ai_response(
            db=db,
            user=user,
            team=team,
            task=result.task,
            assistant_subtask=result.assistant_subtask,
            user_subtask=result.user_subtask,
            message=request.message,
            payload=request,
            device_id=params.device_id,
            auth_token=auth_token,
        )

    return DeviceChatTaskResponse(
        taskId=result.task.id,
        userSubtaskId=result.user_subtask.id,
        assistantSubtaskId=(
            result.assistant_subtask.id if result.assistant_subtask else None
        ),
        messageId=result.user_subtask.message_id,
        aiTriggered=result.ai_triggered,
        deviceId=params.device_id,
        chatUrl=f"/devices/chat?taskId={result.task.id}",
    )


def _get_team(db: Session, team_id: int) -> Kind:
    team = (
        db.query(Kind)
        .filter(
            Kind.id == team_id,
            Kind.kind == "Team",
            Kind.is_active == True,
        )
        .first()
    )
    if not team:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Team not found",
        )
    return team


def _get_existing_task(
    db: Session,
    *,
    task_id: int | None,
    user_id: int,
) -> TaskResource | None:
    if not task_id:
        return None
    task, _ = get_task_with_access_check(db, task_id, user_id)
    if not task:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Task {task_id} not found",
        )
    return task


def _build_task_creation_params(request: DeviceChatTaskRequest) -> TaskCreationParams:
    return TaskCreationParams(
        message=request.message,
        title=request.title,
        model_id=request.model_id,
        force_override_bot_model=request.model_id is not None,
        force_override_bot_model_type=request.model_type,
        model_options=request.model_options,
        is_group_chat=False,
        task_type=request.task_type,
        additional_skills=_additional_skills_as_dicts(request),
        device_id=request.device_id,
        project_id=request.project_id,
        client_origin=request.client_origin,
        generate_params=_generate_params_as_dict(request),
    )


def _additional_skills_as_dicts(
    request: DeviceChatTaskRequest,
) -> list[dict[str, Any]] | None:
    if not request.additional_skills:
        return None
    return [
        skill.model_dump(mode="json") if hasattr(skill, "model_dump") else dict(skill)
        for skill in request.additional_skills
    ]


def _generate_params_as_dict(
    request: DeviceChatTaskRequest,
) -> dict[str, Any] | None:
    if not request.generate_params:
        return None
    return request.generate_params.model_dump(mode="json")


async def _resolve_device_id(
    *,
    db: Session,
    user_id: int,
    params: TaskCreationParams,
    task: TaskResource | None,
    allow_default: bool,
) -> str:
    resolved = await resolve_chat_task_dispatch_device_id(
        db,
        user_id=user_id,
        params=params,
        task=task,
    )
    if resolved:
        return resolved

    if allow_default:
        default_device = device_service.get_default_device_for_type(
            db,
            user_id,
            DeviceType.LOCAL,
        )
        if default_device:
            default_id = await resolve_online_local_executor_device_id(
                db,
                user_id=user_id,
                device_id=default_device.name,
            )
            if default_id:
                return default_id

    raise HTTPException(
        status_code=status.HTTP_400_BAD_REQUEST,
        detail="Default local device is not configured",
    )


def _link_contexts_to_user_subtask(
    *,
    db: Session,
    user: User,
    task: TaskResource,
    user_subtask: Subtask | Any,
    request: DeviceChatTaskRequest,
) -> None:
    if not request.attachment_ids and not request.contexts:
        return

    from app.services.chat.preprocessing import link_contexts_to_subtask

    link_contexts_to_subtask(
        db=db,
        subtask_id=user_subtask.id,
        user_id=user.id,
        attachment_ids=request.attachment_ids,
        contexts=request.contexts,
        task=task,
    )


def _schedule_ai_response(
    *,
    db: Session,
    user: User,
    team: Kind,
    task: TaskResource,
    assistant_subtask: Subtask,
    user_subtask: Subtask,
    message: str,
    payload: DeviceChatTaskRequest,
    device_id: str | None,
    auth_token: str,
) -> None:
    db.refresh(task)
    db.refresh(team)
    db.refresh(assistant_subtask)
    db.refresh(user)

    make_transient(task)
    make_transient(team)
    make_transient(assistant_subtask)
    make_transient(user)

    asyncio.create_task(
        _run_ai_response(
            task=task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=payload,
            device_id=device_id,
            user_subtask_id=user_subtask.id,
            auth_token=auth_token,
        )
    )


async def _run_ai_response(
    *,
    task: TaskResource,
    assistant_subtask: Subtask,
    team: Kind,
    user: User,
    message: str,
    payload: DeviceChatTaskRequest,
    device_id: str | None,
    user_subtask_id: int,
    auth_token: str,
) -> None:
    try:
        await trigger_ai_response_unified(
            task=task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=payload,
            task_room=f"task:{task.id}",
            device_id=device_id,
            user_subtask_id=user_subtask_id,
            auth_token=auth_token,
            enable_tools=payload.enable_deep_thinking,
            enable_deep_thinking=payload.enable_deep_thinking,
        )
    except Exception as exc:
        logger.exception(
            "Device chat task AI trigger failed: task_id=%s, subtask_id=%s",
            task.id,
            assistant_subtask.id,
        )
        if getattr(exc, "_frontend_error_emitted", False):
            return
        await _persist_failed_ai_trigger(
            task_id=task.id,
            assistant_subtask_id=assistant_subtask.id,
            error=exc,
        )


async def _persist_failed_ai_trigger(
    *,
    task_id: int,
    assistant_subtask_id: int,
    error: Exception,
) -> None:
    from shared.utils.error_classifier import classify_error, format_error_message

    error_code = classify_error(error)
    error_message = format_error_message(error)
    final_result = await collect_completed_result(
        assistant_subtask_id,
        status="FAILED",
        error_message=error_message,
        error_code=error_code,
    )
    await persist_completed_result(
        subtask_id=assistant_subtask_id,
        task_id=task_id,
        status="FAILED",
        result=final_result,
        error=error_message,
    )
