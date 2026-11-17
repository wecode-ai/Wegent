# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Deliver Codex business questions and route private IM answers to their owner."""

import asyncio
import hashlib
import json
import logging
import time
from contextlib import asynccontextmanager
from typing import Any, AsyncIterator

from anyio import fail_after
from sqlalchemy.orm import Session

from app.core.cache import cache_manager
from app.models.im_session import IMPrivateSession
from app.schemas.runtime_work import (
    RuntimeMessageSource,
    RuntimeSendRequest,
    RuntimeTaskAddress,
)
from app.services import runtime_work_service
from app.services.im.notification_dispatcher import (
    _result_reply_reference,
    im_notification_dispatcher,
)
from app.services.im.session_service import im_session_service
from shared.telemetry.decorators import trace_async

logger = logging.getLogger(__name__)
RETENTION_SECONDS = 7 * 24 * 60 * 60
LOCK_OPERATION_SECONDS = 120
STATE_COMMIT = """
if redis.call('get', KEYS[1]) ~= ARGV[1] then return 0 end
if tonumber(ARGV[3]) > 0 then
    redis.call('set', KEYS[2], ARGV[2], 'EX', ARGV[3])
else
    redis.call('set', KEYS[2], ARGV[2])
end
return 1
"""
STALE_REPLY = "这个问题已回答、已取消或已过期，请查看任务中的最新问题。"


def question_identity(payload: dict[str, Any]) -> tuple[str, str] | None:
    scope = payload.get("interactionScope") or payload.get("turnId")
    identity = payload.get("requestId", payload.get("request_id"))
    if identity is None:
        identity = payload.get("itemId") or payload.get("item_id")
    if not scope or identity is None:
        return None
    return str(scope), str(identity)


def business_question(payload: Any) -> bool:
    """Native approvals, MCP forms and authentication retain their own flows."""
    return (
        isinstance(payload, dict)
        and payload.get("kind") == "request_user_input"
        and not any(
            payload.get(key)
            for key in (
                "approvalKind",
                "approval_kind",
                "elicitationId",
                "mode",
                "interactionKind",
                "interaction_kind",
            )
        )
        and question_identity(payload) is not None
        and isinstance(payload.get("questions"), list)
        and bool(payload["questions"])
        and all(
            isinstance(question, dict)
            and question.get("id")
            and question.get("question")
            for question in payload["questions"]
        )
    )


def _state_key(user_id: int) -> str:
    return f"channel:runtime_questions:{user_id}"


async def _read_state(client: Any, key: str) -> dict[str, Any]:
    # Match Rust's writer read: a replica can lag behind the previous lock owner.
    raw = await client.eval("return redis.call('get', KEYS[1])", 1, key)
    return json.loads(raw) if raw is not None else {}


@asynccontextmanager
async def _locked(user_id: int) -> AsyncIterator[dict[str, Any]]:
    key = _state_key(user_id)
    async with cache_manager._client_context() as client:
        lock_key = f"{key}:lock"
        async with client.lock(lock_key, timeout=300, blocking_timeout=30) as lock:
            token = lock.local.token
            state: dict[str, Any] | None = None
            try:
                with fail_after(LOCK_OPERATION_SECONDS):
                    state = await _read_state(client, key)
                    cutoff = time.time() - RETENTION_SECONDS
                    state = {
                        k: v
                        for k, v in state.items()
                        if v["status"] == "pending"
                        or v.get("settled_at", v["created_at"]) > cutoff
                    }
                    yield state
            finally:
                if state is not None:
                    pending = any(
                        entry["status"] == "pending" for entry in state.values()
                    )
                    saved = await asyncio.wait_for(
                        client.eval(
                            STATE_COMMIT,
                            2,
                            lock_key,
                            key,
                            token,
                            json.dumps(state),
                            0 if pending else RETENTION_SECONDS,
                        ),
                        timeout=5,
                    )
                    if not saved:
                        raise RuntimeError("IM question lock ownership was lost")


def _pending_question(entry: dict[str, Any]) -> dict[str, Any] | None:
    return next(
        (q for q in entry["payload"]["questions"] if q["id"] not in entry["answers"]),
        None,
    )


async def _deliver(
    db: Session, session: IMPrivateSession, entry: dict[str, Any]
) -> None:
    question = _pending_question(entry)
    if question is None:
        return
    deliveries = entry["deliveries"].setdefault(session.session_key, {})
    if question["id"] in deliveries:
        return
    result = await im_notification_dispatcher.send_text(
        db, session, entry["texts"][question["id"]]
    )
    if not result.get("success"):
        logger.warning(
            "IM question delivery failed: user_id=%s task_id=%s channel_id=%s",
            session.user_id,
            entry["address"]["taskId"],
            session.channel_id,
        )
        return
    reference = _result_reply_reference(result)
    deliveries[question["id"]] = str(reference) if reference is not None else None


def _matches_quote(entry: dict[str, Any], session_key: str, quote: str) -> str | None:
    return next(
        (
            qid
            for qid, ref in entry["deliveries"].get(session_key, {}).items()
            if ref is not None and ref == quote
        ),
        None,
    )


def _selected_answer(question: dict[str, Any], text: str) -> str:
    options = question.get("options") or []
    if text.isdecimal() and 1 <= int(text) <= len(options):
        return str(options[int(text) - 1]["label"])
    return text


def _live_question(turns: list[dict[str, Any]], payload: dict[str, Any]) -> bool:
    """Use canonical ordered turns, including answers entered on the desktop."""
    found = False
    for turn in turns:
        for item in turn.get("items", []):
            if (
                found
                and payload.get("delivery") == "async"
                and item.get("type") == "user_message"
            ):
                return False
            block = item.get("block") or {}
            rendered = block.get("render_payload") or block.get("renderPayload") or {}
            if question_identity(rendered) != question_identity(payload):
                continue
            found = (
                turn.get("status") not in {"error", "cancelled"}
                and business_question(rendered)
                and not (
                    rendered.get("response")
                    or rendered.get("requestUserInputResponse")
                    or rendered.get("interactionStatus")
                    in {"answered", "cancelled", "expired"}
                )
            )
    deadline = payload.get("expiresAtUnixMs")
    return found and (deadline is None or deadline > time.time() * 1000)


async def _submit(
    db: Session, user_id: int, entry: dict[str, Any], client_id: str
) -> bool:
    payload = entry["payload"]
    response = {
        key: payload[key]
        for key in ("requestId", "request_id", "itemId", "item_id", "interactionScope")
        if key in payload
    }
    response["answers"] = entry["answers"]
    async_input = payload.get("delivery") == "async"
    if async_input:
        response["delivery"] = "async"
    message = "\n".join(
        f"{q['question']}\n{entry['answers'][q['id']]['answers'][0]}"
        for q in payload["questions"]
    )
    result = await runtime_work_service.send_runtime_message(
        db=db,
        user_id=user_id,
        allow_app_device_task_messaging=True,
        request=RuntimeSendRequest(
            address=RuntimeTaskAddress.model_validate(entry["address"]),
            message=message,
            queueIfBusy=async_input,
            clientUserMessageId=client_id,
            requestUserInputResponse=response,
            source=(
                RuntimeMessageSource.model_validate(entry["source"])
                if (entry.get("source") or {}).get("external_id")
                and (entry.get("source") or {}).get("source") == "im"
                else None
            ),
        ),
    )
    return result.accepted


def _quoted_question(
    state: dict[str, Any], session_key: str, quote: Any
) -> tuple[dict[str, Any], str] | None:
    if quote is None:
        return None
    for entry in state.values():
        qid = _matches_quote(entry, session_key, str(quote))
        if qid:
            return entry, qid
    return None


async def _is_live(db: Session, user_id: int, entry: dict[str, Any]) -> bool:
    transcript = await runtime_work_service.get_runtime_transcript(
        db=db,
        user_id=user_id,
        address=RuntimeTaskAddress.model_validate(entry["address"]),
        allow_app_device_task_reading=True,
    )
    live = _live_question(transcript.turns, entry["payload"])
    if not live:
        entry["status"] = "expired"
        entry["settled_at"] = time.time()
    return live


async def _deliver_next(
    db: Session, session: IMPrivateSession, entry: dict[str, Any]
) -> None:
    for session_key in entry["deliveries"]:
        target = (
            session
            if session_key == session.session_key
            else (await im_session_service.get_session(session_key))
        )
        if target and target.user_id == session.user_id:
            await _deliver(db, target, entry)


def _client_id(user_id: int, entry: dict[str, Any]) -> str:
    identity = [user_id, entry["address"], question_identity(entry["payload"])]
    return (
        "im-question:"
        + hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
    )


async def _record_answer(
    db: Session, session: IMPrivateSession, entry: dict[str, Any], qid: str, text: str
) -> str | None:
    previously_recorded = qid in entry["answers"]
    try:
        return await _apply_answer(db, session, entry, qid, text)
    except BaseException:
        if (
            not previously_recorded
            and entry["status"] != "answered"
            and _pending_question(entry) is None
        ):
            entry["answers"].pop(qid, None)
        raise


async def _apply_answer(
    db: Session,
    session: IMPrivateSession,
    entry: dict[str, Any],
    qid: str,
    text: str,
) -> str | None:
    if entry["status"] != "pending":
        return STALE_REPLY
    if not await _is_live(db, session.user_id, entry):
        return STALE_REPLY
    if qid in entry["answers"]:
        await _deliver_next(db, session, entry)
        return "这个问题的答案已记录，请继续回答下一题。"
    if qid not in entry["deliveries"].get(session.session_key, {}):
        await _deliver(db, session, entry)
        return None
    if not text:
        return "请用文字回答这个问题。"
    question = next(q for q in entry["payload"]["questions"] if q["id"] == qid)
    entry["answers"][qid] = {"answers": [_selected_answer(question, text)]}
    if _pending_question(entry) is not None:
        await _deliver_next(db, session, entry)
        return None
    if await _submit(db, session.user_id, entry, _client_id(session.user_id, entry)):
        entry["status"] = "answered"
        entry["settled_at"] = time.time()
        return "已将回答提交给原任务。"
    entry["answers"].pop(qid)
    return "回答未被任务接受，请检查任务状态后重试。"


async def _route_answer(
    db: Session,
    session: IMPrivateSession,
    context: Any,
    state: dict[str, Any],
) -> tuple[bool, str | None]:
    message_id = context.extra_data.get("message_id")
    receipt = f"{session.session_key}:{message_id}" if message_id is not None else None
    if receipt and any(
        receipt in entry.get("reply_receipts", []) for entry in state.values()
    ):
        return True, None
    quoted = _quoted_question(
        state, session.session_key, context.extra_data.get("reply_to_message_id")
    )
    if quoted is None:
        return False, None
    entry, qid = quoted
    try:
        reply = await _record_answer(db, session, entry, qid, context.content.strip())
        if receipt and (qid in entry["answers"] or entry["status"] != "pending"):
            entry.setdefault("reply_receipts", []).append(receipt)
        return True, reply
    except asyncio.CancelledError:
        raise
    except Exception:
        logger.exception(
            "IM answer failed: user_id=%s task_id=%s",
            session.user_id,
            entry["address"]["taskId"],
        )
        return True, "暂时无法提交回答，请稍后重试。"


async def has_pending_question(session: IMPrivateSession) -> bool:
    """Route ordinary messages to the stand-in while this IM has open questions."""
    async with cache_manager._client_context() as client:
        state = await _read_state(client, _state_key(session.user_id))
    return any(
        entry["status"] == "pending"
        and entry["deliveries"].get(session.session_key)
        and business_question(entry["payload"])
        for entry in state.values()
    )


@trace_async("im.runtime_question.answer", "im")
async def answer_runtime_question(
    *,
    db: Session,
    user_id: int,
    session: IMPrivateSession,
    context: Any,
    port: Any,
) -> bool:
    if (
        session.user_id != user_id
        or context.extra_data.get("reply_to_message_id") is None
        or getattr(context, "sender_id", None) != session.sender_id
    ):
        return False
    async with cache_manager._client_context() as client:
        if not await _read_state(client, _state_key(user_id)):
            return False
    try:
        async with _locked(user_id) as state:
            handled, reply = await _route_answer(db, session, context, state)
    except Exception:
        logger.exception("IM question lookup failed: user_id=%s", user_id)
        handled, reply = True, "暂时无法读取待答问题，请稍后重试。"
    # Persist acceptance before an IM acknowledgment, which can itself fail.
    if reply:
        await port.send_text_reply(context, reply)
    return handled
