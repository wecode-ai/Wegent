# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared pipeline stage advancement through the normal chat send path."""

import logging
from dataclasses import dataclass
from types import SimpleNamespace
from typing import Any, Optional

from app.api.ws.events import ServerEvents
from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.core.socketio import get_sio
from app.core.web_background_tasks import web_background_task_manager
from app.models.kind import Kind
from app.models.subtask import Subtask
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import (
    TaskCreationParams,
    create_chat_task_nonblocking,
)
from app.services.chat.storage.db import (
    PipelineAutoAdvanceIntent,
    get_db_session,
    run_sync_in_executor,
)
from app.services.chat.trigger import trigger_ai_response_unified
from app.stores.tasks import subtask_store, task_store

logger = logging.getLogger(__name__)


@dataclass
class _PipelineAdvancePreparation:
    advance_result: dict[str, Any]
    user: Optional[User]
    team: Optional[Kind]
    payload: Any


async def advance_pipeline_stage_from_auto_completion(
    intent: PipelineAutoAdvanceIntent,
) -> Optional[dict[str, Any]]:
    """Continue a pipeline after a stage completed without manual confirmation."""
    return await advance_pipeline_stage_and_send(
        user_id=intent.user_id,
        team_id=None,
        task_id=intent.task_id,
        message=None,
        payload=None,
        skip_sid=None,
        auth_token="",
        completed_subtask_id=intent.completed_subtask_id,
        auto_advance_info=intent.advance_info,
        detach_execution=False,
    )


async def advance_pipeline_stage_and_send(
    *,
    user_id: int,
    team_id: Optional[int],
    task_id: int,
    message: Optional[str],
    payload: Any,
    skip_sid: Optional[str],
    auth_token: str,
    completed_subtask_id: Optional[int] = None,
    auto_advance_info: Optional[dict[str, Any]] = None,
    detach_execution: bool = True,
) -> dict[str, Any]:
    """Advance a pipeline stage and send the handoff as the next user message."""
    preparation = await run_sync_in_executor(
        _prepare_pipeline_advance,
        user_id,
        team_id,
        task_id,
        payload,
        completed_subtask_id,
        auto_advance_info,
    )
    advance_result = preparation.advance_result

    if not advance_result.get("success"):
        logger.error(
            "[PipelineAdvance] Failed to advance pipeline task=%s: %s",
            task_id,
            advance_result.get("error"),
        )
        return {"error": advance_result.get("error", "Pipeline advance failed")}

    user = preparation.user
    team = preparation.team
    payload = preparation.payload
    if user is None or team is None:
        return {"error": "Pipeline task context not found"}

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
        user_id=user_id,
        db=None,
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

    result = await create_chat_task_nonblocking(
        user_id=user_id,
        team_id=team.id,
        message=handoff_message,
        params=params,
        task_id=task_id,
        should_trigger_ai=True,
        rag_prompt=rag_prompt,
        detach_memory_save=detach_execution,
    )

    message_payload, linked_context_count = await run_sync_in_executor(
        _prepare_pipeline_user_message,
        user_id,
        task_id,
        result.user_subtask.id,
        handoff_message,
        payload,
    )
    if linked_context_count:
        logger.info(
            "[PipelineAdvance] Linked %s context(s) for handoff subtask %s",
            linked_context_count,
            result.user_subtask.id,
        )

    task_room = f"task:{result.task.id}"
    await _emit_task_status(result.task.id, "RUNNING", 0)
    await _emit_user_message(
        message_payload=message_payload,
        task_room=task_room,
        skip_sid=skip_sid,
    )

    if result.assistant_subtask:
        await _trigger_next_stage(
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
            detach_execution=detach_execution,
        )

    return {
        "task_id": result.task.id,
        "subtask_id": result.user_subtask.id,
        "message_id": result.user_subtask.message_id,
    }


def _prepare_pipeline_advance(
    user_id: int,
    team_id: Optional[int],
    task_id: int,
    payload: Any,
    completed_subtask_id: Optional[int],
    auto_advance_info: Optional[dict[str, Any]],
) -> _PipelineAdvancePreparation:
    """Advance pipeline storage and detach runtime inputs in one DB worker."""
    with get_db_session() as db:
        task = task_store.get_regular_active_task(db, task_id=task_id)
        if not task:
            return _PipelineAdvancePreparation(
                advance_result={"success": False, "error": "Task not found"},
                user=None,
                team=None,
                payload=payload,
            )
        user = db.query(User).filter(User.id == user_id).first()
        if not user:
            return _PipelineAdvancePreparation(
                advance_result={"success": False, "error": "User not found"},
                user=None,
                team=None,
                payload=payload,
            )
        team = (
            db.query(Kind)
            .filter(
                Kind.id == team_id,
                Kind.kind == "Team",
                Kind.is_active == True,
            )
            .first()
            if team_id is not None
            else pipeline_stage_service.get_team_for_task(
                db,
                task,
                Task.model_validate(task.json),
            )
        )
        if not team:
            return _PipelineAdvancePreparation(
                advance_result={"success": False, "error": "Team not found"},
                user=None,
                team=None,
                payload=payload,
            )

        if auto_advance_info is not None:
            if completed_subtask_id is None:
                advance_result = {
                    "success": False,
                    "error": "Completed stage is required for auto-advance",
                }
            else:
                advance_result = pipeline_stage_service.pipeline_auto_advance(
                    db=db,
                    task_id=task_id,
                    user_id=user_id,
                    completed_subtask_id=completed_subtask_id,
                    advance_info=auto_advance_info,
                )
        else:
            advance_result = pipeline_stage_service.pipeline_confirm(
                db=db,
                task_id=task_id,
                user_id=user_id,
            )

        resolved_payload = payload or _default_pipeline_payload(task)
        db.refresh(user)
        db.refresh(team)
        db.expunge(user)
        db.expunge(team)
        return _PipelineAdvancePreparation(
            advance_result=advance_result,
            user=user,
            team=team,
            payload=resolved_payload,
        )


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
        "model": getattr(generate_params, "model", None),
        "model_display_name": getattr(generate_params, "model_display_name", None),
        "generation_mode_id": getattr(generate_params, "generation_mode_id", None),
        "size": getattr(generate_params, "size", None),
    }


def _prepare_pipeline_user_message(
    user_id: int,
    task_id: int,
    user_subtask_id: int,
    message: str,
    payload: Any,
) -> tuple[dict[str, Any], int]:
    from app.services.chat.preprocessing import link_contexts_to_subtask
    from app.services.context import context_service

    with get_db_session() as db:
        task = task_store.get_regular_active_task(db, task_id=task_id)
        user = db.query(User).filter(User.id == user_id).first()
        user_subtask = subtask_store.get_by_id(db, subtask_id=user_subtask_id)
        if not task or not user or not user_subtask or user_subtask.task_id != task_id:
            raise ValueError("Pipeline message context not found")

        attachment_ids = list(getattr(payload, "attachment_ids", None) or [])
        attachment_id = getattr(payload, "attachment_id", None)
        if not attachment_ids and attachment_id:
            attachment_ids = [attachment_id]
        contexts = getattr(payload, "contexts", None)
        linked_context_ids = []
        if attachment_ids or contexts:
            linked_context_ids = link_contexts_to_subtask(
                db=db,
                subtask_id=user_subtask.id,
                user_id=user.id,
                attachment_ids=attachment_ids or None,
                contexts=contexts,
                task=task,
                user_name=user.user_name,
            )

        serialized_contexts = [
            context.model_dump(mode="json")
            for context in context_service.get_briefs_by_subtask(db, user_subtask.id)
        ]
        return (
            {
                "subtask_id": user_subtask.id,
                "task_id": task_id,
                "message_id": user_subtask.message_id,
                "role": "user",
                "content": message,
                "sender": {"user_id": user.id, "user_name": user.user_name},
                "created_at": user_subtask.created_at.isoformat(),
                "attachment": None,
                "attachments": [],
                "contexts": serialized_contexts,
            },
            len(linked_context_ids),
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
    message_payload: dict[str, Any],
    task_room: str,
    skip_sid: Optional[str],
) -> None:
    await get_sio().emit(
        ServerEvents.CHAT_MESSAGE,
        message_payload,
        room=task_room,
        skip_sid=skip_sid,
        namespace="/chat",
    )


async def _trigger_next_stage(
    *,
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
    detach_execution: bool,
) -> None:
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

    if detach_execution:
        await web_background_task_manager.submit(
            _trigger_ai,
            name=f"pipeline-ai-trigger-{assistant_subtask.id}",
        )
        return
    await _trigger_ai()
