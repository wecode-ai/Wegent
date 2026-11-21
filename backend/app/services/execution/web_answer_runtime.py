"""Delegate native Web Chat turns to the single Python answer lifecycle."""

import logging
from typing import Any

from fastapi import BackgroundTasks, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.user import User
from app.services.chat.config import get_shell_type
from app.services.chat.storage.db import TerminalPersistenceError, run_sync_in_executor
from app.services.knowledge.answer_evidence import ANSWER_SAVE_UNCONFIRMED_MESSAGE
from app.stores.tasks import subtask_store, task_access_store
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class WebAnswerOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    task_id: int = Field(gt=0)
    answer_id: int = Field(gt=0)
    actor_id: int = Field(gt=0)
    user_subtask_id: int | None = None
    message: str = ""
    options: dict[str, Any] = Field(default_factory=dict)
    additional_skills: list[dict[str, Any]] = Field(default_factory=list)
    interactive_form_answer: dict[str, Any] | None = None


def _selected_shell(db: Any, answer: Any, team: Kind) -> str:
    """Use the same assigned-bot resolution as the execution request builder."""
    from app.schemas.kind import Team
    from app.services.execution.request_builder import TaskRequestBuilder

    bot = TaskRequestBuilder(db)._get_bot_for_subtask(
        answer, team, Team.model_validate(team.json)
    )
    return get_shell_type(db, bot, bot.user_id) if bot is not None else ""


def _has_native_knowledge(db: Any, task: Any, operation: WebAnswerOperation) -> bool:
    """Select the native KB feature without taking over unrelated runtimes."""
    from app.services.chat.selected_knowledge import (
        build_inherited_selected_knowledge_refs,
    )
    from app.services.context import context_service

    ids: set[int | None] = {
        int(ref.knowledge_base_id)
        for ref in build_inherited_selected_knowledge_refs(db, task, operation.actor_id)
        if ref.provider == "wegent"
    }
    for context in context_service.get_by_subtask(db, operation.user_subtask_id or 0):
        data = context.type_data or {}
        if context.context_type == "knowledge_base":
            ids.add(data.get("knowledge_id"))
        elif context.context_type == "selected_documents":
            ids.add(data.get("knowledge_base_id"))
    ids.discard(None)
    if not ids:
        return False
    return any(
        not (kb.json or {}).get("spec", {}).get("source")
        for kb in db.query(Kind)
        .filter(Kind.id.in_(ids), Kind.kind == "KnowledgeBase", Kind.is_active)
        .all()
    )


def _prepare(operation: WebAnswerOperation) -> dict | None:
    """Select pending native Web answers for Python evidence execution."""
    from app.api.ws.chat_namespace import _detach_retry_dispatch_objects
    from app.api.ws.events import ChatSendPayload

    with SessionLocal() as db:
        answer = subtask_store.get_basic_by_id(db, subtask_id=operation.answer_id)
        if answer is None or answer.task_id != operation.task_id:
            raise HTTPException(404, "Answer not found")
        task = task_access_store.get_task(db, task_id=operation.task_id)
        if task is None or not task_access_store.is_member(
            db, task_id=operation.task_id, user_id=operation.actor_id
        ):
            raise HTTPException(403, "Answer access denied")
        if task.client_origin != "frontend" or (task.json or {}).get("spec", {}).get(
            "device_id"
        ):
            return None
        team = db.get(Kind, answer.team_id)
        user = db.get(User, operation.actor_id)
        if user is None or team is None or answer.role != SubtaskRole.ASSISTANT:
            raise HTTPException(404, "Execution identity not found")
        if _selected_shell(db, answer, team) != "Chat":
            return None
        if not _has_native_knowledge(db, task, operation):
            return None
        if answer.status != SubtaskStatus.PENDING:
            raise HTTPException(409, "Answer is no longer pending")
        user_turn = subtask_store.get_basic_by_id(
            db, subtask_id=operation.user_subtask_id or 0
        )
        if (
            user_turn is None
            or user_turn.task_id != task.id
            or user_turn.role != SubtaskRole.USER
        ):
            raise HTTPException(409, "User turn does not belong to this task")
        payload = ChatSendPayload(
            task_id=task.id,
            team_id=team.id,
            message=operation.message,
            is_group_chat=bool(getattr(task, "is_group_chat", False)),
            additional_skills=operation.additional_skills or None,
            interactive_form_answer=operation.interactive_form_answer,
            **{
                key: operation.options[key]
                for key in (
                    "enable_deep_thinking",
                    "enable_web_search",
                    "enable_clarification",
                    "model_options",
                )
                if key in operation.options
            },
        )
        kwargs = dict(
            task=task,
            assistant_subtask=answer,
            team=team,
            user=user,
            message=operation.message,
            payload=payload,
            user_subtask_id=user_turn.id,
            task_room=f"task:{task.id}",
            enable_deep_thinking=payload.enable_deep_thinking,
        )
        _detach_retry_dispatch_objects(db, task, team, answer, user)
        return kwargs


async def _execute(kwargs: dict) -> None:
    """Use the established dispatcher, storage and post-commit event contract."""
    from app.services.chat.trigger.unified import trigger_ai_response_unified
    from app.services.execution.emitters import (
        StatusUpdatingEmitter,
        WebSocketResultEmitter,
    )

    answer = kwargs["assistant_subtask"]
    try:
        await trigger_ai_response_unified(**kwargs, enable_answer_evidence=True)
    except TerminalPersistenceError:
        await WebSocketResultEmitter(
            task_id=answer.task_id, subtask_id=answer.id
        ).emit_error(
            answer.task_id,
            answer.id,
            ANSWER_SAVE_UNCONFIRMED_MESSAGE,
            error_code="answer_save_unconfirmed",
        )
    except Exception as exc:
        if getattr(exc, "_frontend_error_emitted", False):
            return
        logger.error(
            "Web answer preparation failed: id=%s error_type=%s",
            answer.id,
            type(exc).__name__,
        )
        emitter = StatusUpdatingEmitter(
            WebSocketResultEmitter(task_id=answer.task_id, subtask_id=answer.id),
            task_id=answer.task_id,
            subtask_id=answer.id,
        )
        await emitter.emit_error(answer.task_id, answer.id, "Answer preparation failed")


@trace_async("web.answer.runtime", "backend.chat")
async def execute_web_answer(
    operation: WebAnswerOperation, background_tasks: BackgroundTasks
) -> dict:
    prepared = await run_sync_in_executor(_prepare, operation)
    if prepared is None:
        return {"handled": False}
    background_tasks.add_task(_execute, prepared)
    return {"handled": True, "success": True}
