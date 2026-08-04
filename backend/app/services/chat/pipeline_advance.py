# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared pipeline stage advancement through the normal chat send path."""

import asyncio
import logging
from types import SimpleNamespace
from typing import Any, Optional

from sqlalchemy.orm import Session, make_transient

from app.api.ws.events import ServerEvents
from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.core.socketio import get_sio
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import TaskCreationParams, create_chat_task
from app.services.chat.storage.db import PipelineAutoAdvanceIntent
from app.services.chat.trigger import trigger_ai_response_unified
from app.services.context import context_service
from app.stores.tasks import task_store

logger = logging.getLogger(__name__)


async def advance_pipeline_stage_from_auto_completion(
    intent: PipelineAutoAdvanceIntent,
) -> Optional[dict[str, Any]]:
    """Continue a pipeline after a stage completed without manual confirmation."""
    db = SessionLocal()
    try:
        task = task_store.get_regular_active_task(db, task_id=intent.task_id)
        if not task:
            logger.warning(
                "[PipelineAdvance] Auto advance skipped; task not found: %s",
                intent.task_id,
            )
            return None

        user = db.query(User).filter(User.id == intent.user_id).first()
        if not user:
            logger.warning(
                "[PipelineAdvance] Auto advance skipped; user not found: %s",
                intent.user_id,
            )
            return None

        task_crd = Task.model_validate(task.json)
        team = pipeline_stage_service.get_team_for_task(db, task, task_crd)
        if not team:
            logger.warning(
                "[PipelineAdvance] Auto advance skipped; team not found: task=%s",
                intent.task_id,
            )
            return None

        payload = _default_pipeline_payload(task)
        return await advance_pipeline_stage_and_send(
            db=db,
            user=user,
            team=team,
            task_id=intent.task_id,
            message=None,
            payload=payload,
            skip_sid=None,
            auth_token="",
            completed_subtask_id=intent.completed_subtask_id,
            auto_advance_info=intent.advance_info,
        )
    finally:
        db.close()


async def advance_pipeline_stage_and_send(
    *,
    db: Session,
    user: User,
    team: Kind,
    task_id: int,
    message: Optional[str],
    payload: Any,
    skip_sid: Optional[str],
    auth_token: str,
    completed_subtask_id: Optional[int] = None,
    auto_advance_info: Optional[dict[str, Any]] = None,
) -> dict[str, Any]:
    """Advance a pipeline stage and send the handoff as the next user message."""
    if auto_advance_info is not None:
        if completed_subtask_id is None:
            return {"error": "Completed stage is required for auto-advance"}
        advance_result = pipeline_stage_service.pipeline_auto_advance(
            db=db,
            task_id=task_id,
            user_id=user.id,
            completed_subtask_id=completed_subtask_id,
            advance_info=auto_advance_info,
        )
    else:
        advance_result = pipeline_stage_service.pipeline_confirm(
            db=db,
            task_id=task_id,
            user_id=user.id,
        )

    if not advance_result.get("success"):
        logger.error(
            "[PipelineAdvance] Failed to advance pipeline task=%s: %s",
            task_id,
            advance_result.get("error"),
        )
        return {"error": advance_result.get("error", "Pipeline advance failed")}

    if advance_result.get("is_pipeline_complete"):
        await _emit_task_status(task_id, "COMPLETED", 100)
        return {
            "task_id": task_id,
            "current_stage": advance_result.get("next_stage_index"),
            "total_stages": advance_result.get("total_stages"),
            "pipeline_completed": True,
        }

    handoff_message = (message or "").strip() or advance_result.get(
        "handoff_message", ""
    )
    pipeline_bot_ids = [advance_result["next_stage_bot_id"]]
    previous_bot_id = advance_result.get("current_stage_bot_id")

    _, rag_prompt = await process_context_and_rag(
        message=handoff_message,
        contexts=getattr(payload, "contexts", None),
        should_trigger_ai=True,
        user_id=user.id,
        db=db,
    )

    params = TaskCreationParams(
        message=handoff_message,
        title=getattr(payload, "title", None),
        model_id=getattr(payload, "force_override_bot_model", None),
        force_override_bot_model=getattr(payload, "force_override_bot_model", None)
        is not None,
        force_override_bot_model_type=getattr(
            payload, "force_override_bot_model_type", None
        ),
        model_options=getattr(payload, "model_options", None),
        task_type=getattr(payload, "task_type", None),
        additional_skills=_additional_skills_to_dicts(
            getattr(payload, "additional_skills", None)
        ),
        pipeline_bot_ids=pipeline_bot_ids,
        previous_bot_id=previous_bot_id,
        pipeline_context_passing=advance_result.get("context_passing"),
        skip_status_check=True,
        device_id=getattr(payload, "device_id", None),
        project_id=getattr(payload, "project_id", None),
        client_origin=getattr(payload, "client_origin", CLIENT_ORIGIN_FRONTEND),
        generate_params=_generate_params_to_dict(
            getattr(payload, "generate_params", None)
        ),
    )

    result = await create_chat_task(
        db=db,
        user=user,
        team=team,
        message=handoff_message,
        params=params,
        task_id=task_id,
        should_trigger_ai=True,
        rag_prompt=rag_prompt,
        source="web",
    )

    linked_context_ids = _link_payload_contexts(
        db=db,
        user=user,
        task=result.task,
        user_subtask=result.user_subtask,
        payload=payload,
    )
    if linked_context_ids:
        logger.info(
            "[PipelineAdvance] Linked %s context(s) for handoff subtask %s",
            len(linked_context_ids),
            result.user_subtask.id,
        )

    task_room = f"task:{result.task.id}"
    await _emit_task_status(result.task.id, "RUNNING", 0)
    await _emit_user_message(
        db=db,
        user_subtask=result.user_subtask,
        task_id=result.task.id,
        message=handoff_message,
        user=user,
        task_room=task_room,
        skip_sid=skip_sid,
    )

    if result.assistant_subtask:
        _trigger_next_stage(
            db=db,
            task=result.task,
            team=team,
            assistant_subtask=result.assistant_subtask,
            user=user,
            message=handoff_message,
            payload=payload,
            task_room=task_room,
            user_subtask_id=result.user_subtask.id,
            auth_token=auth_token,
            previous_bot_id=previous_bot_id,
        )

    return {
        "task_id": result.task.id,
        "subtask_id": result.user_subtask.id,
        "message_id": result.user_subtask.message_id,
    }


def _default_pipeline_payload(task: TaskResource) -> SimpleNamespace:
    return SimpleNamespace(
        title=None,
        force_override_bot_model=None,
        force_override_bot_model_type=None,
        model_options=None,
        task_type=None,
        additional_skills=None,
        device_id=None,
        project_id=task.project_id,
        client_origin=task.client_origin,
        generate_params=None,
        contexts=None,
        attachment_ids=None,
        attachment_id=None,
        enable_deep_thinking=True,
        enable_web_search=False,
        enable_clarification=False,
        interactive_form_answer=None,
    )


def _additional_skills_to_dicts(
    additional_skills: Any,
) -> Optional[list[dict[str, Any]]]:
    if not additional_skills:
        return None
    result: list[dict[str, Any]] = []
    for skill in additional_skills:
        result.append(
            {
                "name": getattr(skill, "name", None),
                "namespace": getattr(skill, "namespace", None),
                "is_public": getattr(skill, "is_public", False),
            }
        )
    return result


def _generate_params_to_dict(generate_params: Any) -> Optional[dict[str, Any]]:
    if not generate_params:
        return None
    return {
        "resolution": getattr(generate_params, "resolution", None),
        "ratio": getattr(generate_params, "ratio", None),
        "duration": getattr(generate_params, "duration", None),
    }


def _link_payload_contexts(
    *,
    db: Session,
    user: User,
    task: TaskResource,
    user_subtask: Subtask,
    payload: Any,
) -> list[int]:
    from app.services.chat.preprocessing import link_contexts_to_subtask

    attachment_ids = list(getattr(payload, "attachment_ids", None) or [])
    attachment_id = getattr(payload, "attachment_id", None)
    if not attachment_ids and attachment_id:
        attachment_ids = [attachment_id]

    contexts = getattr(payload, "contexts", None)
    knowledge_base_id = getattr(payload, "knowledge_base_id", None)
    if not attachment_ids and not contexts and knowledge_base_id is None:
        return []

    return link_contexts_to_subtask(
        db=db,
        subtask_id=user_subtask.id,
        user_id=user.id,
        attachment_ids=attachment_ids or None,
        contexts=contexts,
        task=task,
        knowledge_base_id=knowledge_base_id,
    )


async def _emit_task_status(task_id: int, status: str, progress: int) -> None:
    await get_sio().emit(
        ServerEvents.TASK_STATUS,
        {
            "task_id": task_id,
            "status": status,
            "progress": progress,
        },
        room=f"task:{task_id}",
        namespace="/chat",
    )


async def _emit_user_message(
    *,
    db: Session,
    user_subtask: Subtask,
    task_id: int,
    message: str,
    user: User,
    task_room: str,
    skip_sid: Optional[str],
) -> None:
    contexts = [
        context.model_dump(mode="json")
        for context in context_service.get_briefs_by_subtask(db, user_subtask.id)
    ]
    await get_sio().emit(
        ServerEvents.CHAT_MESSAGE,
        {
            "subtask_id": user_subtask.id,
            "task_id": task_id,
            "message_id": user_subtask.message_id,
            "role": "user",
            "content": message,
            "sender": {
                "user_id": user.id,
                "user_name": user.user_name,
            },
            "created_at": user_subtask.created_at.isoformat(),
            "attachment": None,
            "attachments": [],
            "contexts": contexts,
        },
        room=task_room,
        skip_sid=skip_sid,
        namespace="/chat",
    )


def _trigger_next_stage(
    *,
    db: Session,
    task: TaskResource,
    team: Kind,
    assistant_subtask: Subtask,
    user: User,
    message: str,
    payload: Any,
    task_room: str,
    user_subtask_id: int,
    auth_token: str,
    previous_bot_id: Optional[int],
) -> None:
    db.refresh(task)
    db.refresh(team)
    db.refresh(assistant_subtask)
    db.refresh(user)
    make_transient(task)
    make_transient(team)
    make_transient(assistant_subtask)
    make_transient(user)

    async def _trigger_ai() -> None:
        try:
            await trigger_ai_response_unified(
                task=task,
                assistant_subtask=assistant_subtask,
                team=team,
                user=user,
                message=message,
                payload=payload,
                task_room=task_room,
                user_subtask_id=user_subtask_id,
                auth_token=auth_token,
                previous_bot_id=previous_bot_id,
            )
        except Exception:
            logger.exception(
                "[PipelineAdvance] Failed to trigger next stage: task_id=%s subtask_id=%s",
                task.id,
                assistant_subtask.id,
            )

    asyncio.create_task(_trigger_ai())
