# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Bind interpreted answers to questions delivered to this private IM sender."""

import hashlib
import json
import logging
import secrets
from typing import Any

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.models.im_session import IMPrivateSession
from app.schemas.runtime_work import RuntimeSendRequest, RuntimeSendResponse
from app.services.device.runtime_route import resolve_runtime_route_identity
from app.services.im import runtime_questions as questions
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)


def _reply_key(user_id: int, token: str) -> str:
    digest = hashlib.sha256(token.encode()).hexdigest()
    return f"channel:im_question_reply:{user_id}:{digest}"


async def _pending_questions(
    db: Session, session: IMPrivateSession
) -> tuple[list[dict[str, Any]], dict[str, dict[str, str]]]:
    items: list[dict[str, Any]] = []
    permitted: dict[str, dict[str, str]] = {}
    async with questions._locked(session.user_id) as state:
        for key, entry in state.items():
            if entry["status"] != "pending" or not entry["deliveries"].get(
                session.session_key
            ):
                continue
            if not questions.business_question(entry["payload"]):
                continue
            try:
                live = await questions._is_live(db, session.user_id, entry)
            except HTTPException as error:
                if error.status_code in {403, 404}:
                    continue
                logger.warning(
                    "IM question context unavailable: user_id=%s task_id=%s status=%s",
                    session.user_id,
                    entry["address"]["taskId"],
                    error.status_code,
                )
                continue
            except TimeoutError:
                logger.warning(
                    "IM question context timed out: user_id=%s task_id=%s",
                    session.user_id,
                    entry["address"]["taskId"],
                )
                continue
            if not live:
                continue
            question = questions._pending_question(entry)
            if question is None:
                continue
            identity = hashlib.sha256(f"{key}\0{question['id']}".encode()).hexdigest()
            permitted[identity] = {"entry": key, "question": question["id"]}
            items.append(
                {
                    "questionId": identity,
                    "taskTitle": entry["title"],
                    "question": question["question"],
                    "options": question.get("options", []),
                    "backgroundContinues": entry["payload"].get("delivery") == "async",
                }
            )
    return items, permitted


@trace_async("im.runtime_question.context", "im")
async def pending_question_context(
    db: Session,
    session: IMPrivateSession,
    context: Any,
    target: dict[str, Any],
) -> dict[str, Any]:
    if getattr(context, "sender_id", None) != session.sender_id:
        raise HTTPException(403, "IM sender does not match the conversation")
    try:
        return await _question_context(db, session, target)
    except Exception:
        logger.exception("IM question context unavailable: user_id=%s", session.user_id)
        return {}


async def _question_context(
    db: Session, session: IMPrivateSession, target: dict[str, Any]
) -> dict[str, Any]:
    async with questions.cache_manager._client_context() as client:
        if not await questions._read_state(
            client, questions._state_key(session.user_id)
        ):
            return {}
    items, permitted = await _pending_questions(db, session)
    if not items:
        return {}
    token = secrets.token_urlsafe(32)
    await questions.cache_manager.set_or_raise(
        _reply_key(session.user_id, token),
        {
            "sessionKey": session.session_key,
            "senderId": session.sender_id,
            "actorTaskId": target["taskId"],
            "actorDevices": [target["deviceId"], target["runtimeDeviceId"]],
            "questions": permitted,
        },
        expire=questions.RETENTION_SECONDS,
    )
    return {
        "wework.im.pending-questions": {
            "kind": "untrusted",
            "value": json.dumps(
                {"replyToken": token, "questions": items}, ensure_ascii=False
            ),
        }
    }


async def _reply_grant(
    db: Session, user_id: int, request: RuntimeSendRequest
) -> tuple[IMPrivateSession, dict[str, str]]:
    answer = request.im_question_answer
    if answer is None:
        raise HTTPException(422, "An IM question answer is required")
    grant = await questions.cache_manager.get_or_raise(
        _reply_key(user_id, answer.reply_token)
    )
    if not isinstance(grant, dict):
        logger.warning(
            "IM question answer rejected: user_id=%s reason=missing_grant", user_id
        )
        raise HTTPException(403, "This IM message cannot answer that question")
    identity = resolve_runtime_route_identity(
        db, user_id=user_id, submitted_device_id=request.address.device_id
    )
    actor_devices = (
        {identity.logical_device_id, identity.runtime_device_id} if identity else set()
    )
    reason = None
    if actor_devices.isdisjoint(grant["actorDevices"]):
        reason = "actor_device"
    elif request.address.local_task_id != grant["actorTaskId"]:
        reason = "actor_task"
    elif answer.question_id not in grant["questions"]:
        reason = "question_scope"
    if reason:
        logger.warning(
            "IM question answer rejected: user_id=%s reason=%s", user_id, reason
        )
        raise HTTPException(403, "This IM message cannot answer that question")
    session = await questions.im_session_service.get_session(grant["sessionKey"])
    if (
        not session
        or session.user_id != user_id
        or session.sender_id != grant["senderId"]
    ):
        raise HTTPException(403, "The private IM sender is no longer authorized")
    reference = grant["questions"][answer.question_id]
    return session, reference


@trace_async("im.runtime_question.interpreted_answer", "im")
async def submit_interpreted_answer(
    db: Session, user_id: int, request: RuntimeSendRequest
) -> RuntimeSendResponse:
    session, reference = await _reply_grant(db, user_id, request)
    async with questions._locked(user_id) as state:
        entry = state.get(reference["entry"])
        if (
            not entry
            or not entry["deliveries"].get(session.session_key)
            or not questions.business_question(entry["payload"])
        ):
            raise HTTPException(409, questions.STALE_REPLY)
        qid = reference["question"]
        if qid in entry["answers"]:
            question = next(q for q in entry["payload"]["questions"] if q["id"] == qid)
            expected = {
                "answers": [
                    questions._selected_answer(question, request.message.strip())
                ]
            }
            if entry["answers"][qid] != expected:
                raise HTTPException(409, "This question already has a different answer")
            if entry["status"] == "pending":
                await questions._deliver_next(db, session, entry)
            accepted = True
        else:
            reply = await questions._record_answer(
                db, session, entry, qid, request.message.strip()
            )
            accepted = qid in entry["answers"]
            if not accepted:
                raise HTTPException(409, reply or questions.STALE_REPLY)
        return RuntimeSendResponse(accepted=accepted, taskId=entry["address"]["taskId"])
