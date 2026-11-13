# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared pipeline stage advancement through the normal chat send path."""

import asyncio
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, AsyncIterator, Optional

from sqlalchemy.orm import Session, make_transient

from app.api.ws.events import ServerEvents
from app.core.async_utils import run_in_threadpool_with_cleanup
from app.core.cache import cache_manager
from app.core.constants import CLIENT_ORIGIN_FRONTEND
from app.core.distributed_lock import distributed_lock
from app.core.socketio import get_sio
from app.db.session import SessionLocal
from app.models.kind import Kind
from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.models.user import User
from app.schemas.kind import Task
from app.services.adapters.pipeline_stage import pipeline_stage_service
from app.services.chat.rag import process_context_and_rag
from app.services.chat.storage import TaskCreationParams, create_chat_task
from app.services.chat.storage.db import (
    PipelineAutoAdvanceIntent,
    TerminalPersistenceError,
)
from app.services.chat.storage.task_manager import (
    initialize_redis_chat_history,
    schedule_chat_memory_save,
)
from app.services.chat.trigger import trigger_ai_response_unified
from app.services.chat.trigger.group_chat import (
    is_task_group_chat,
    notify_group_members_task_updated,
)
from app.services.chat.trigger.lifecycle import prepare_execution_session
from app.services.chat.trigger.unified import build_execution_request
from app.services.context import context_service
from app.services.task_fork_history import task_fork_history_resolver
from app.stores.tasks import subtask_store, task_store

if TYPE_CHECKING:
    from shared.models.execution import ExecutionRequest

logger = logging.getLogger(__name__)

_RECOVERY_QUEUE = "wegent:terminal-delivery:pending:python"
_RECOVERY_DELAY_SECONDS = 5
_MAX_RECOVERIES = 4


@dataclass
class PipelineHandoff:
    user_subtask: Subtask
    assistant_subtask: Subtask


async def advance_pipeline_stage_from_auto_completion(
    intent: PipelineAutoAdvanceIntent,
) -> bool:
    """Resume the committed handoff and acknowledge only after dispatch is queued."""
    try:
        async with distributed_lock.acquire_watchdog_context_async(
            _advance_lock(intent.completed_subtask_id)
        ) as acquired:
            if not acquired:
                raise RuntimeError("Pipeline handoff is already in progress")
            member = f"{intent.task_id}:{intent.completed_subtask_id}"
            async with cache_manager._client_context() as redis:
                await redis.zadd(
                    _RECOVERY_QUEUE, {member: time.time() + _RECOVERY_DELAY_SECONDS}
                )
            return await _resume_auto_advance(intent)
    except Exception as exc:
        raise TerminalPersistenceError(
            f"Could not advance pipeline after subtask {intent.completed_subtask_id}"
        ) from exc


def _advance_lock(subtask_id: int) -> str:
    return f"pipeline-auto-advance:{subtask_id}"


def _execution_lease(task_id: int, subtask_id: int) -> str:
    return f"wegent:lock:pipeline-execution:{task_id}:{subtask_id}"


@asynccontextmanager
async def pipeline_recovery_lifespan() -> AsyncIterator[None]:
    worker = asyncio.create_task(_recover_pipeline_handoffs())
    try:
        yield
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)


async def _recover_pipeline_handoffs() -> None:
    jobs: set[asyncio.Task] = set()
    try:
        while True:
            await asyncio.sleep(1)
            available = _MAX_RECOVERIES - len(jobs)
            if available <= 0:
                continue
            try:
                now = time.time()
                async with cache_manager._client_context() as redis:
                    due = await redis.eval(
                        "local due = redis.call('ZRANGEBYSCORE', KEYS[1], "
                        "'-inf', ARGV[1], 'LIMIT', 0, ARGV[3]); "
                        "for _, member in ipairs(due) do "
                        "redis.call('ZADD', KEYS[1], ARGV[2], member) end; "
                        "return due",
                        1,
                        _RECOVERY_QUEUE,
                        now,
                        now + _RECOVERY_DELAY_SECONDS,
                        available,
                    )
                for member in due:
                    job = asyncio.create_task(_recover_pipeline_handoff(member))
                    jobs.add(job)
                    job.add_done_callback(jobs.discard)
            except Exception:
                logger.exception("Pipeline recovery index unavailable")
    finally:
        for job in jobs:
            job.cancel()
        await asyncio.gather(*jobs, return_exceptions=True)


async def _recover_pipeline_handoff(member: str | bytes) -> None:
    try:
        task_id, subtask_id = map(
            int, member.split(b":" if isinstance(member, bytes) else ":")
        )
        async with distributed_lock.acquire_watchdog_context_async(
            _advance_lock(subtask_id)
        ) as acquired:
            if not acquired:
                return
            pending = await run_in_threadpool_with_cleanup(
                _read_pending_handoff, task_id, subtask_id
            )
            async with cache_manager._client_context() as redis:
                if pending is None:
                    await redis.zrem(_RECOVERY_QUEUE, member)
                    return
                if pending.next_pair and await redis.exists(
                    _execution_lease(task_id, pending.next_pair[1])
                ):
                    return
            await _resume_auto_advance(pending)
    except Exception:
        logger.exception("Pipeline recovery will retry %s", member)


def _read_pending_handoff(
    task_id: int, subtask_id: int
) -> PipelineAutoAdvanceIntent | None:
    with SessionLocal() as db:
        task = task_store.get_by_id_for_update(db, task_id=task_id)
        if task and task.is_active == TaskResource.STATE_ACTIVE:
            return PipelineAutoAdvanceIntent.read(task, subtask_id)
        return None


async def _resume_auto_advance(intent: PipelineAutoAdvanceIntent) -> bool:
    with SessionLocal() as db:
        prepared = await run_in_threadpool_with_cleanup(
            _prepare_auto_advance, db, intent
        )
        if prepared is None:
            return False

        task, user, team, pending, result = prepared
        history = task_fork_history_resolver.resolve_for_task(
            db,
            task_id=task.id,
            user_id=user.id,
            current_task=task,
            before_message_id=result.user_subtask.message_id,
        )
        existing_subtasks = [item.subtask for item in history]
        await initialize_redis_chat_history(task.id, existing_subtasks)
        if is_task_group_chat(task, False):
            await notify_group_members_task_updated(db, task, user.id)

        message = result.user_subtask.prompt
        request = await build_execution_request(
            task=task,
            assistant_subtask=result.assistant_subtask,
            team=team,
            user=user,
            message=message,
            payload=_default_pipeline_payload(task),
            user_subtask_id=result.user_subtask.id,
            previous_bot_id=_previous_bot_id(db, pending.completed_subtask_id),
        )
        await _emit_user_message(
            db=db,
            user_subtask=result.user_subtask,
            task_id=task.id,
            message=message,
            user=user,
            task_room=f"task:{task.id}",
            skip_sid=None,
        )
        if not _claim_auto_advance(pending):
            return False
        await _emit_task_status(task.id, "RUNNING", 0, user_id=user.id)
        executor_owns_execution = await _dispatch_until_accepted(request)
        _acknowledge_auto_advance(pending, executor_owns_execution)
        if pending.dispatch_acknowledged:
            return False
        try:
            schedule_chat_memory_save(
                db, task, result.user_subtask, user, team, existing_subtasks
            )
        except Exception:
            logger.exception("Could not schedule memory save for task %s", task.id)
        return True


def _prepare_auto_advance(
    db: Session, intent: PipelineAutoAdvanceIntent
) -> tuple[TaskResource, User, Kind, PipelineAutoAdvanceIntent, PipelineHandoff] | None:
    task = task_store.get_by_id_for_update(db, task_id=intent.task_id)
    if not task or task.is_active != TaskResource.STATE_ACTIVE:
        return None
    pending = PipelineAutoAdvanceIntent.read(task, intent.completed_subtask_id)
    if pending is None:
        return None

    user = db.get(User, pending.user_id)
    team = pipeline_stage_service.get_team_for_task(
        db, task, Task.model_validate(task.json)
    )
    if not user or not team:
        raise LookupError("Pipeline owner or team not found")

    handoff = _prepare_handoff_pair(db, user, team, task, pending)
    db.commit()
    if handoff is None:
        return None
    return task, user, team, pending, handoff


def _prepare_handoff_pair(
    db: Session,
    user: User,
    team: Kind,
    task: TaskResource,
    intent: PipelineAutoAdvanceIntent,
) -> PipelineHandoff | None:
    latest = subtask_store.get_latest_assistant_by_statuses(
        db,
        task_id=task.id,
        owner_user_id=task.user_id,
        statuses=[status for status in SubtaskStatus if status != SubtaskStatus.DELETE],
    )
    expected_id = (
        intent.next_pair[1] if intent.next_pair else intent.completed_subtask_id
    )
    expected_status = (
        (SubtaskStatus.PENDING, SubtaskStatus.RUNNING)
        if intent.next_pair
        else (SubtaskStatus.COMPLETED,)
    )
    current_stage = task.json["spec"].get("currentStage") or 0
    next_stage = intent.advance_info["next_stage_index"]
    if (
        not latest
        or latest.id != expected_id
        or latest.status not in expected_status
        or current_stage != (next_stage if intent.next_pair else next_stage - 1)
    ):
        _clear_auto_advance(db, task, intent)
        return None

    if intent.next_pair:
        user_subtask = subtask_store.get_basic_by_id(db, subtask_id=intent.next_pair[0])
        if not user_subtask:
            raise LookupError("Pipeline handoff message not found")
        return PipelineHandoff(user_subtask, latest)

    advance = pipeline_stage_service.pipeline_auto_advance(
        db=db,
        task_id=task.id,
        user_id=user.id,
        completed_subtask_id=intent.completed_subtask_id,
        advance_info=intent.advance_info,
    )
    if not advance.get("success"):
        raise RuntimeError(advance.get("error", "Pipeline advance failed"))

    handoff = advance.get("handoff_message", "")
    params = _handoff_params(handoff, _default_pipeline_payload(task), advance)
    session = prepare_execution_session(
        db=db,
        user=user,
        team=team,
        input_text=handoff,
        task_params=params,
        task_id=task.id,
        bot_ids_override=params.pipeline_bot_ids,
        commit=False,
    )
    if not session.assistant_subtask:
        raise LookupError("Pipeline handoff assistant not created")
    intent.next_pair = (session.user_subtask.id, session.assistant_subtask.id)
    document = session.task.json
    intent.write(document)
    task_store.update_json(db, task=session.task, payload=document)
    return PipelineHandoff(session.user_subtask, session.assistant_subtask)


def _previous_bot_id(db: Session, subtask_id: int) -> int | None:
    subtask = subtask_store.get_basic_by_id(db, subtask_id=subtask_id)
    return subtask.bot_ids[0] if subtask and subtask.bot_ids else None


def _clear_auto_advance(
    db: Session, task: TaskResource, intent: PipelineAutoAdvanceIntent
) -> None:
    document = task.json
    document["metadata"]["labels"].pop(intent.label)
    task_store.update_json(db, task=task, payload=document)


def _claim_auto_advance(intent: PipelineAutoAdvanceIntent) -> bool:
    if intent.next_pair is None:
        raise ValueError("Pipeline handoff pair is required")
    _, assistant_id = intent.next_pair
    with SessionLocal() as db:
        task = task_store.get_by_id_for_update(db, task_id=intent.task_id)
        if not task or task.is_active != TaskResource.STATE_ACTIVE:
            return False
        pending = PipelineAutoAdvanceIntent.read(task, intent.completed_subtask_id)
        if pending is None or pending.next_pair != intent.next_pair:
            return False
        claimed = subtask_store.transition_status(
            db,
            subtask_id=assistant_id,
            task_id=task.id,
            owner_user_id=intent.user_id,
            role=SubtaskRole.ASSISTANT,
            from_status=SubtaskStatus.PENDING,
            to_status=SubtaskStatus.RUNNING,
        )
        if claimed:
            document = task.json
            document["status"]["status"] = "RUNNING"
            task_store.update_json(db, task=task, payload=document)
        else:
            subtask = subtask_store.get_basic_by_id_for_update(
                db, subtask_id=assistant_id
            )
            claimed = bool(
                subtask
                and subtask.task_id == task.id
                and subtask.status == SubtaskStatus.RUNNING
            )
        db.commit()

    return claimed


def _acknowledge_auto_advance(
    intent: PipelineAutoAdvanceIntent, executor_owns_execution: bool
) -> None:
    with SessionLocal() as db:
        task = task_store.get_by_id_for_update(db, task_id=intent.task_id)
        if task:
            pending = PipelineAutoAdvanceIntent.read(task, intent.completed_subtask_id)
            if pending and pending.next_pair == intent.next_pair:
                if executor_owns_execution:
                    _clear_auto_advance(db, task, intent)
                else:
                    pending.dispatch_acknowledged = True
                    document = task.json
                    pending.write(document)
                    task_store.update_json(db, task=task, payload=document)
                db.commit()


async def _dispatch_until_accepted(request: "ExecutionRequest") -> bool:
    from app.services.chat.storage.session import session_manager
    from app.services.execution import execution_dispatcher

    accepted: asyncio.Future[bool] = asyncio.get_running_loop().create_future()
    request.request_id = f"pipeline-{request.task_id}-{request.subtask_id}"

    async def dispatch() -> None:
        key = _execution_lease(request.task_id, request.subtask_id)
        async with cache_manager._client_context() as redis:
            lock = redis.lock(key, timeout=30, blocking_timeout=5, thread_local=False)
            async with lock:
                with SessionLocal() as db:
                    current = subtask_store.get_basic_by_id_for_update(
                        db, subtask_id=request.subtask_id
                    )
                    running = current and current.status == SubtaskStatus.RUNNING
                if not running:
                    accepted.set_result(False)
                    return
                # The previous stream may have left a partial result behind.
                await session_manager.cleanup_streaming_state(request.subtask_id)
                execution = asyncio.create_task(
                    execution_dispatcher.dispatch(
                        request, already_running=True, on_accepted=accepted.set_result
                    )
                )
                try:
                    while not execution.done():
                        done, _ = await asyncio.wait({execution}, timeout=10)
                        if not done:
                            await lock.reacquire()
                    await execution
                finally:
                    if not execution.done():
                        execution.cancel()
                        await asyncio.gather(execution, return_exceptions=True)

    job = asyncio.create_task(dispatch())

    def log_execution_failure(task: asyncio.Task) -> None:
        if not task.cancelled() and (error := task.exception()) is not None:
            logger.error(
                "Pipeline execution failed for subtask %s",
                request.subtask_id,
                exc_info=error,
            )

    job.add_done_callback(log_execution_failure)
    try:
        await asyncio.wait({job, accepted}, return_when=asyncio.FIRST_COMPLETED)
        if accepted.done():
            return accepted.result()
        await job
        raise RuntimeError("Pipeline execution did not acknowledge dispatch")
    except BaseException:
        if not accepted.done():
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)
        raise


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
) -> dict[str, Any]:
    """Confirm a pipeline stage and send the handoff as the next user message."""
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
    previous_bot_id = advance_result.get("current_stage_bot_id")
    _, rag_prompt = await process_context_and_rag(
        message=handoff_message,
        contexts=getattr(payload, "contexts", None),
        should_trigger_ai=True,
        user_id=user.id,
        db=db,
    )
    result = await create_chat_task(
        db=db,
        user=user,
        team=team,
        message=handoff_message,
        params=_handoff_params(handoff_message, payload, advance_result),
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


def _handoff_params(
    handoff_message: str, payload: Any, advance_result: dict[str, Any]
) -> TaskCreationParams:
    return TaskCreationParams(
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
        pipeline_bot_ids=[advance_result["next_stage_bot_id"]],
        previous_bot_id=advance_result.get("current_stage_bot_id"),
        pipeline_context_passing=advance_result.get("context_passing"),
        skip_status_check=True,
        device_id=getattr(payload, "device_id", None),
        project_id=getattr(payload, "project_id", None),
        client_origin=getattr(payload, "client_origin", CLIENT_ORIGIN_FRONTEND),
        generate_params=_generate_params_to_dict(
            getattr(payload, "generate_params", None)
        ),
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
    if not attachment_ids and not contexts:
        return []

    return link_contexts_to_subtask(
        db=db,
        subtask_id=user_subtask.id,
        user_id=user.id,
        attachment_ids=attachment_ids or None,
        contexts=contexts,
        task=task,
        user_name=user.user_name,
    )


async def _emit_task_status(
    task_id: int, status: str, progress: int, *, user_id: int | None = None
) -> None:
    sio = get_sio()
    payload = {"task_id": task_id, "status": status, "progress": progress}
    await sio.emit(
        ServerEvents.TASK_STATUS, payload, room=f"task:{task_id}", namespace="/chat"
    )
    if user_id is not None:
        await sio.emit(
            ServerEvents.TASK_STATUS, payload, room=f"user:{user_id}", namespace="/chat"
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
