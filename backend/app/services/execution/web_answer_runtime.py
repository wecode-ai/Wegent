"""Delegate native Web Chat turns to the single Python answer lifecycle."""

import logging
from typing import Any, Literal

from fastapi import BackgroundTasks, HTTPException
from pydantic import BaseModel, ConfigDict, Field

from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.services.chat.config import get_shell_type
from app.services.chat.storage.answer_attempt import accept_answer_attempt
from app.services.chat.storage.db import run_sync_in_executor
from app.stores.tasks import subtask_store, task_access_store, task_store
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


class AcceptedPreparationFailure(RuntimeError):
    """Carry the captured identity without exposing the underlying failure."""

    def __init__(self, operation: "WebAnswerOperation", generation: str):
        super().__init__("Accepted answer preparation failed")
        self.operation = operation
        self.generation = generation


class WebAnswerOperation(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["start", "retry", "cancel"]
    task_id: int = Field(gt=0)
    answer_id: int = Field(gt=0)
    actor_id: int = Field(gt=0)
    user_subtask_id: int | None = None
    message: str = ""
    options: dict[str, Any] = Field(default_factory=dict)
    additional_skills: list[dict[str, Any]] = Field(default_factory=list)
    interactive_form_answer: dict[str, Any] | None = None
    retry: dict[str, Any] = Field(default_factory=dict)


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
    """Select only persisted native Web Chat; capture identity before preparation."""
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
        if (
            task.client_origin != "frontend"
            or (task.json or {}).get("spec", {}).get("device_id")
            or _selected_shell(db, answer, team) != "Chat"
            or operation.options.get("generation")
        ):
            return None
        if operation.action == "retry":
            return {"selected": True} if answer.answer_generation_id else None
        if operation.action == "cancel":
            return (
                {"generation_id": answer.answer_generation_id}
                if answer.answer_generation_id
                else None
            )
        if not _has_native_knowledge(db, task, operation):
            return None
        if answer.status != SubtaskStatus.PENDING or answer.answer_generation_id:
            raise HTTPException(409, "Answer attempt is no longer pending")
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
        generation = accept_answer_attempt(db, answer)
        try:
            _detach_retry_dispatch_objects(db, task, team, answer, user)
        except Exception:
            db.rollback()
            raise AcceptedPreparationFailure(operation, generation) from None
        answer.answer_generation_id = generation
        return kwargs


async def _execute(kwargs: dict) -> None:
    """Use the established dispatcher, storage and post-commit event contract."""
    from app.services.chat.trigger.unified import trigger_ai_response_unified

    answer = kwargs["assistant_subtask"]
    try:
        await trigger_ai_response_unified(**kwargs, enable_answer_evidence=True)
    except Exception as exc:
        if getattr(exc, "_frontend_error_emitted", False):
            return
        logger.error(
            "Web answer preparation failed: id=%s error_type=%s",
            answer.id,
            type(exc).__name__,
        )
        await _preparation_failed(
            answer.task_id, answer.id, answer.answer_generation_id
        )


async def _preparation_failed(task_id: int, answer_id: int, generation: str) -> None:
    """Settle only the captured pending attempt after preparation fails."""
    from app.services.execution.emitters import (
        StatusUpdatingEmitter,
        WebSocketResultEmitter,
    )

    emitter = StatusUpdatingEmitter(
        WebSocketResultEmitter(task_id=task_id, subtask_id=answer_id),
        task_id=task_id,
        subtask_id=answer_id,
        generation_id=generation,
        expected_status="PENDING",
    )
    await emitter.emit_error(task_id, answer_id, "Answer preparation failed")


def _cancel(
    operation: WebAnswerOperation, generation: str | None, result: dict
) -> bool:
    """Cancel only the accepted attempt, retaining partial result and lock order."""
    from app.services.chat.operations.cancel import (
        update_subtask_on_cancel,
        update_task_on_cancel,
    )

    with SessionLocal() as db:
        task = task_store.get_by_id_for_update(db, task_id=operation.task_id)
        answer = subtask_store.get_basic_by_id_for_update(
            db, subtask_id=operation.answer_id
        )
        if (
            task is None
            or task.is_active not in TaskResource.is_active_query()
            or answer is None
            or answer.task_id != task.id
        ):
            return False
        if not update_subtask_on_cancel(
            db, answer, result=result, generation_id=generation
        ):
            db.rollback()
            return False
        update_task_on_cancel(db, task)
        db.commit()
        return True


@trace_async("web.answer.runtime", "backend.chat")
async def execute_web_answer(
    operation: WebAnswerOperation, background_tasks: BackgroundTasks
) -> dict:
    try:
        prepared = await run_sync_in_executor(_prepare, operation)
    except AcceptedPreparationFailure as exc:
        await _preparation_failed(
            exc.operation.task_id, exc.operation.answer_id, exc.generation
        )
        return {"handled": True, "error": "Answer preparation failed"}
    if prepared is None:
        return {"handled": False}
    if operation.action == "cancel":
        from app.api.ws.chat_namespace import _mark_task_and_board_cancelling
        from app.services.adapters.task_kinds import task_kinds_service
        from app.services.chat.operations.cancel import (
            is_stream_alive,
            publish_task_cancelled_events,
        )
        from app.services.chat.trigger.lifecycle import collect_completed_result
        from app.services.knowledge.answer_evidence import public_result
        from app.utils.thinking_sanitizer import sanitize_result_for_storage

        generation = prepared["generation_id"]
        if not await run_sync_in_executor(
            _mark_task_and_board_cancelling, operation.answer_id, generation
        ):
            return {"handled": True, "error": "Answer attempt changed"}
        delivered = await task_kinds_service._call_chat_shell_cancel(
            operation.answer_id,
            generation,
            allowed_statuses=(SubtaskStatus.PENDING, SubtaskStatus.RUNNING),
        )
        if not await is_stream_alive(operation.task_id, operation.answer_id):
            partial = await collect_completed_result(
                operation.answer_id, status="CANCELLED"
            )
            partial = sanitize_result_for_storage(public_result(partial or {}))
            if not await run_sync_in_executor(_cancel, operation, generation, partial):
                return {"handled": True, "error": "Answer attempt changed"}
            await publish_task_cancelled_events(
                operation.task_id, [operation.answer_id], operation.actor_id
            )
            return {"handled": True, "success": True}
        if not delivered:
            return {"handled": True, "error": "Cancellation delivery not confirmed"}
        return {"handled": True, "success": True}
    if operation.action == "retry":
        from app.api.ws.chat_namespace import _prepare_chat_retry_with_session
        from app.api.ws.events import ChatRetryPayload

        prepared = await run_sync_in_executor(
            _prepare_chat_retry_with_session,
            ChatRetryPayload.model_validate(
                {
                    **operation.retry,
                    "task_id": operation.task_id,
                    "subtask_id": operation.answer_id,
                }
            ),
            operation.actor_id,
        )
        if "error" in prepared:
            return {"handled": True, **prepared}
    background_tasks.add_task(_execute, prepared)
    return {"handled": True, "success": True}
