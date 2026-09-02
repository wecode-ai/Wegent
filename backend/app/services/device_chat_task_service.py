# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service for REST-created device chat tasks."""

from __future__ import annotations

import copy
import logging
from dataclasses import dataclass
from typing import Any

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from app.core.constants import CLIENT_ORIGIN_WEWORK
from app.core.web_background_tasks import web_background_task_manager
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
    get_task_with_access_check,
)
from app.services.chat.storage.task_manager import create_chat_task_ids_nonblocking
from app.services.chat.task_device_resolution import (
    resolve_chat_task_device_id,
    resolve_local_executor_device_id,
)
from app.services.chat.trigger import (
    collect_completed_result,
    persist_completed_result,
    should_trigger_ai_response,
    trigger_ai_response_unified,
)
from app.services.chat.wework_task_defaults import (
    apply_wework_task_defaults_nonblocking,
)
from app.services.device_service import device_service
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class _DeviceChatUserDefaults:
    id: int
    preferences: Any


@dataclass(frozen=True)
class _DeviceChatPreparation:
    user: _DeviceChatUserDefaults
    team_id: int
    existing_task_id: int | None
    trigger_ai: bool
    params: TaskCreationParams


@dataclass(frozen=True)
class _DeviceChatTrigger:
    task: TaskResource
    assistant_subtask: Subtask
    team: Kind
    user: User


@dataclass(frozen=True)
class _DeviceChatAfterCreation:
    message_id: int
    trigger: _DeviceChatTrigger | None


async def create_device_chat_task(
    *,
    user_id: int,
    request: DeviceChatTaskRequest,
    auth_token: str = "",
) -> DeviceChatTaskResponse:
    """Create or continue a device chat task from a REST request."""

    from app.services.chat.storage.db import run_sync_in_executor

    preparation = await run_sync_in_executor(
        _prepare_device_chat_request,
        user_id,
        request,
    )
    _, rag_prompt = await process_context_and_rag(
        message=request.message,
        contexts=request.contexts,
        should_trigger_ai=preparation.trigger_ai,
        user_id=user_id,
        db=None,
    )

    params = preparation.params
    if (
        preparation.existing_task_id is None
        and request.client_origin == CLIENT_ORIGIN_WEWORK
    ):
        params = await apply_wework_task_defaults_nonblocking(
            user=preparation.user,  # type: ignore[arg-type]
            params=params,
        )
    params.device_id = await run_sync_in_executor(
        _resolve_device_id_with_session,
        user_id,
        params,
        preparation.existing_task_id,
        preparation.existing_task_id is None and not request.device_id,
    )

    result = await create_chat_task_ids_nonblocking(
        user_id=user_id,
        team_id=preparation.team_id,
        message=request.message,
        params=params,
        task_id=request.task_id,
        should_trigger_ai=preparation.trigger_ai,
        rag_prompt=rag_prompt,
        detach_memory_save=True,
    )
    after_creation = await run_sync_in_executor(
        _prepare_device_chat_after_creation,
        user_id,
        preparation.team_id,
        result.task_id,
        result.user_subtask_id,
        result.assistant_subtask_id,
        request,
    )

    if result.ai_triggered and after_creation.trigger is not None:
        trigger = after_creation.trigger
        await _schedule_ai_response(
            user=trigger.user,
            team=trigger.team,
            task=trigger.task,
            assistant_subtask=trigger.assistant_subtask,
            message=request.message,
            payload=request,
            device_id=params.device_id,
            user_subtask_id=result.user_subtask_id,
            auth_token=auth_token,
        )

    return DeviceChatTaskResponse(
        taskId=result.task_id,
        userSubtaskId=result.user_subtask_id,
        assistantSubtaskId=result.assistant_subtask_id,
        messageId=after_creation.message_id,
        aiTriggered=result.ai_triggered,
        deviceId=params.device_id,
        chatUrl=f"/devices/chat?taskId={result.task_id}",
    )


def _prepare_device_chat_request(
    user_id: int,
    request: DeviceChatTaskRequest,
) -> _DeviceChatPreparation:
    """Validate storage state and return values safe to cross the DB worker boundary."""

    from app.services.chat.storage.db import get_db_session

    with get_db_session() as db:
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="User not found",
            )
        team = _get_team(db, request.team_id)
        existing_task = _get_existing_task(
            db,
            task_id=request.task_id,
            user_id=user_id,
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
            (
                copy.deepcopy(existing_task.json)
                if existing_task and existing_task.json
                else {}
            ),
            request.message,
            team.name,
            request_is_group_chat=False,
        )
        params = _build_task_creation_params(request)
        if existing_task is not None:
            params.client_origin = existing_task.client_origin or params.client_origin
        return _DeviceChatPreparation(
            user=_DeviceChatUserDefaults(
                id=user.id,
                preferences=copy.deepcopy(user.preferences),
            ),
            team_id=team.id,
            existing_task_id=existing_task.id if existing_task else None,
            trigger_ai=trigger_ai,
            params=copy.deepcopy(params),
        )


def _resolve_device_id_with_session(
    user_id: int,
    params: TaskCreationParams,
    task_id: int | None,
    allow_default: bool,
) -> str:
    """Resolve the execution device in a worker-owned database transaction."""

    from app.services.chat.storage.db import get_db_session

    with get_db_session() as db:
        task = _get_existing_task(db, task_id=task_id, user_id=user_id)
        return _resolve_device_id(
            db=db,
            user_id=user_id,
            params=params,
            task=task,
            allow_default=allow_default,
        )


def _prepare_device_chat_after_creation(
    user_id: int,
    team_id: int,
    task_id: int,
    user_subtask_id: int,
    assistant_subtask_id: int | None,
    request: DeviceChatTaskRequest,
) -> _DeviceChatAfterCreation:
    """Link contexts and detach the models needed by the async trigger."""

    from app.services.chat.storage.db import get_db_session

    with get_db_session() as db:
        user = db.query(User).filter(User.id == user_id).first()
        team = _get_team(db, team_id)
        task = task_store.get_owned_task_by_state(
            db,
            task_id=task_id,
            user_id=user_id,
            state=TaskResource.STATE_ACTIVE,
        )
        user_subtask = subtask_store.get_by_id(db, subtask_id=user_subtask_id)
        if user_subtask is not None and user_subtask.task_id != task_id:
            user_subtask = None
        if not user or not task or not user_subtask:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Created device chat task state was not found",
            )

        _link_contexts_to_user_subtask(
            db=db,
            user=user,
            task=task,
            user_subtask=user_subtask,
            request=request,
        )
        db.flush()
        message_id = user_subtask.message_id
        if assistant_subtask_id is None:
            return _DeviceChatAfterCreation(message_id=message_id, trigger=None)

        assistant_subtask = subtask_store.get_by_id(db, subtask_id=assistant_subtask_id)
        if assistant_subtask is not None and assistant_subtask.task_id != task_id:
            assistant_subtask = None
        if not assistant_subtask:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Created assistant subtask was not found",
            )

        for model in (task, team, assistant_subtask, user):
            db.refresh(model)
            db.expunge(model)
        return _DeviceChatAfterCreation(
            message_id=message_id,
            trigger=_DeviceChatTrigger(
                task=task,
                assistant_subtask=assistant_subtask,
                team=team,
                user=user,
            ),
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
        source="web",
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


def _resolve_device_id(
    *,
    db: Session,
    user_id: int,
    params: TaskCreationParams,
    task: TaskResource | None,
    allow_default: bool,
) -> str:
    resolved = resolve_chat_task_device_id(
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
            default_id = resolve_local_executor_device_id(
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
        user_name=user.user_name,
    )


async def _schedule_ai_response(
    *,
    user: User,
    team: Kind,
    task: TaskResource,
    assistant_subtask: Subtask,
    message: str,
    payload: DeviceChatTaskRequest,
    device_id: str | None,
    user_subtask_id: int,
    auth_token: str,
) -> None:
    await web_background_task_manager.submit(
        lambda: _run_ai_response(
            task=task,
            assistant_subtask=assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=payload,
            device_id=device_id,
            user_subtask_id=user_subtask_id,
            auth_token=auth_token,
        ),
        name=f"device-chat-ai-trigger-{assistant_subtask.id}",
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
