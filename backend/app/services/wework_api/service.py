# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Responses protocol adapter over Runtime RPC and ephemeral live events."""

import json
import time
import uuid
from contextlib import aclosing
from copy import deepcopy
from dataclasses import dataclass
from typing import AsyncIterator

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.db.session import get_db_session
from app.models.user import User
from app.schemas.runtime_work import (
    RuntimeModelSelection,
    RuntimeSendRequest,
    RuntimeTaskAddress,
    RuntimeTaskCreateRequest,
)
from app.schemas.wework_api import WeworkResponseCreate, WeworkResponseObject
from app.services import runtime_work_service as runtime
from app.services.wework_api import events, models, native
from app.services.wework_api.identity import ResponseIdentity
from app.services.wework_api.projection import TERMINAL, project, terminal
from shared.telemetry.decorators import trace_async, trace_async_generator


@dataclass
class LiveResponse:
    user_id: int
    identity: ResponseIdentity
    snapshot: dict
    subscription: events.Subscription | None
    runtime_turn_id: str | None = None

    async def close(self) -> None:
        if self.subscription:
            subscription, self.subscription = self.subscription, None
            await subscription.close()


async def _target(
    db: Session, user_id: int, body: WeworkResponseCreate
) -> tuple[RuntimeTaskAddress, bool]:
    identifier = body.conversation
    if body.previous_response_id:
        previous = await native.read_turn(
            db, user_id, ResponseIdentity.parse(body.previous_response_id)
        )
        if previous.status not in TERMINAL or not previous.is_latest:
            raise HTTPException(
                409,
                "previous_response_id must identify the latest completed turn; branching is not supported",
            )
        identifier = previous.identity.conversation_id
    if identifier:
        item = await native.find_conversation(db, user_id, identifier)
        if item["running"]:
            raise HTTPException(409, "Conversation is already running")
        if item["runtime"] != "codex":
            raise HTTPException(
                422, "Creating responses currently requires a Codex conversation"
            )
        return item["_address"], False
    await native.ensure_device_online(user_id, body.execution.device_id)
    return (
        RuntimeTaskAddress(deviceId=body.execution.device_id, taskId=str(uuid.uuid4())),
        True,
    )


async def _dispatch(
    db: Session,
    user_id: int,
    body: WeworkResponseCreate,
    address: RuntimeTaskAddress,
    selection: RuntimeModelSelection,
    identity: ResponseIdentity,
    is_new: bool,
) -> None:
    if is_new:
        ack = await runtime.create_runtime_task(
            db=db,
            user_id=user_id,
            request=RuntimeTaskCreateRequest(
                device_id=address.device_id,
                local_task_id=address.local_task_id,
                runtime="codex",
                standalone_chat_workspace=True,
                message=body.input_text(),
                title=body.execution.title,
                client_user_message_id=identity.message_id,
                model_selection=selection,
                model_id=selection.model_name,
                model_type=selection.model_type,
                model_options=selection.options,
            ),
        )
        if ack.accepted and (
            ack.local_task_id != identity.task_id or ack.device_id != identity.device_id
        ):
            raise HTTPException(502, "Runtime returned a different task identity")
    else:
        ack = await runtime.send_runtime_message(
            db=db,
            user_id=user_id,
            request=RuntimeSendRequest(
                address=address,
                message=body.input_text(),
                client_user_message_id=identity.message_id,
                model_selection=selection,
            ),
        )
    if not ack.accepted:
        raise HTTPException(409, ack.error or "Runtime rejected the task")


@trace_async("wework_api.create_response", "wework.api")
async def create_response(
    db: Session, user: User, body: WeworkResponseCreate
) -> LiveResponse:
    selection = models.selection(db, user, body)
    user_id = user.id
    address, is_new = await _target(db, user_id, body)
    identity = ResponseIdentity(
        address.device_id, address.local_task_id, str(uuid.uuid4())
    )
    subscription = None
    if body.stream or not body.background:
        subscription = await events.subscribe(
            user_id, identity.device_id, identity.task_id
        )
    snapshot = WeworkResponseObject(
        id=identity.id,
        created_at=int(time.time()),
        status="queued",
        model=body.model,
        conversation={"id": identity.conversation_id},
        previous_response_id=body.previous_response_id,
        is_latest=True,
    ).model_dump()
    response = LiveResponse(user_id, identity, snapshot, subscription)
    try:
        await _dispatch(db, user_id, body, address, selection, identity, is_new)
    except BaseException as exc:
        await response.close()
        if isinstance(exc, HTTPException):
            # An RPC timeout may occur after acceptance. Return the native handle
            # so callers can inspect the outcome instead of blindly resubmitting.
            raise HTTPException(
                exc.status_code,
                {
                    "message": str(exc.detail),
                    "response_id": identity.id,
                    "conversation_id": identity.conversation_id,
                },
            ) from exc
        raise
    return response


@trace_async("wework_api.retrieve_response", "wework.api")
async def get_response(
    db: Session, user_id: int, identifier: str, stream: bool = False
) -> dict | LiveResponse:
    identity = ResponseIdentity.parse(identifier)
    item = await native.find_conversation(db, user_id, identity.conversation_id)
    subscription = (
        await events.subscribe(user_id, identity.device_id, identity.task_id)
        if stream
        else None
    )
    try:
        turn = await native.read_turn(db, user_id, identity, item)
    except BaseException:
        if subscription:
            await subscription.close()
        raise
    snapshot = turn.response()
    if not stream:
        return snapshot
    if turn.status not in TERMINAL:
        # Reconnection is a new live subscription, not a replay. Existing output
        # is read using GET response / conversation; only new deltas stream here.
        snapshot["output"] = []
    return LiveResponse(user_id, identity, snapshot, subscription, turn.runtime_turn_id)


@trace_async("wework_api.cancel_response", "wework.api")
async def cancel_response(db: Session, user_id: int, identifier: str) -> dict:
    turn = await native.read_turn(db, user_id, ResponseIdentity.parse(identifier))
    snapshot = turn.response()
    if turn.status in TERMINAL:
        return snapshot
    if turn.runtime_turn_id is None and (
        not turn.is_latest or turn.conversation["running"]
    ):
        raise HTTPException(
            409, "Runtime did not provide a turn identity for targeted cancellation"
        )
    ack = await runtime.cancel_runtime_task(
        db=db,
        user_id=user_id,
        address=turn.conversation["_address"],
        runtime_turn_id=turn.runtime_turn_id,
    )
    if not ack.accepted:
        raise HTTPException(409, ack.error or "Runtime rejected cancellation")
    snapshot["cancellation_requested"] = True
    return snapshot


def _matches(response: LiveResponse, envelope: dict) -> bool:
    payload = envelope.get("payload") or {}
    data = payload.get("data") or {}
    if (
        str(payload.get("taskId") or data.get("taskId") or "")
        != response.identity.task_id
    ):
        return False
    client_id = (
        payload.get("clientUserMessageId")
        or payload.get("client_user_message_id")
        or data.get("clientUserMessageId")
        or data.get("client_user_message_id")
    )
    turn_id = payload.get("subtaskId") or data.get("subtaskId")
    if (
        turn_id is not None
        and response.runtime_turn_id is not None
        and str(turn_id) != response.runtime_turn_id
    ):
        return False
    if client_id:
        if str(client_id) != response.identity.message_id:
            return False
        if turn_id is not None:
            response.runtime_turn_id = str(turn_id)
        return True
    return turn_id is not None and str(turn_id) == response.runtime_turn_id


async def _refresh(response: LiveResponse) -> dict:
    # The Runtime remains the source of truth even when no new event is emitted.
    # Sessions are scoped to one RPC refresh, never to the lifetime of an SSE stream.
    with get_db_session() as db:
        turn = await native.read_turn(db, response.user_id, response.identity)
    response.runtime_turn_id = turn.runtime_turn_id
    return turn.response()


@trace_async_generator("wework_api.live_events", "wework.api")
async def response_events(response: LiveResponse) -> AsyncIterator[dict | None]:
    try:
        yield {"type": "response.created", "response": deepcopy(response.snapshot)}
        if response.snapshot["status"] in TERMINAL:
            for event in terminal(
                response.snapshot,
                response.snapshot["status"],
                response.snapshot.get("error"),
            ):
                yield event
            return
        last_refresh = time.monotonic()
        while response.snapshot["status"] not in TERMINAL:
            envelope = await response.subscription.receive()
            if envelope and _matches(response, envelope):
                payload = envelope.get("payload") or {}
                data = dict(payload.get("data") or {})
                if "offset" in payload:
                    data["offset"] = payload["offset"]
                for event in project(
                    response.snapshot,
                    envelope.get("event") or payload.get("event_type"),
                    data,
                ):
                    yield event
            if time.monotonic() - last_refresh >= 15:
                current = await _refresh(response)
                response.snapshot["is_latest"] = current["is_latest"]
                if current["status"] in TERMINAL:
                    response.snapshot.update(current)
                    for event in terminal(
                        response.snapshot, current["status"], current.get("error")
                    ):
                        yield event
                else:
                    yield None
                last_refresh = time.monotonic()
    finally:
        await response.close()


@trace_async_generator("wework_api.sse", "wework.api")
async def stream_response(response: LiveResponse) -> AsyncIterator[str]:
    sequence = 0
    async with aclosing(response_events(response)) as stream:
        async for event in stream:
            if event is None:
                yield ": keep-alive\n\n"
            else:
                event["sequence_number"] = sequence
                sequence += 1
                yield f"event: {event['type']}\ndata: {json.dumps(event, ensure_ascii=False)}\n\n"


@trace_async("wework_api.wait_response", "wework.api")
async def wait_response(response: LiveResponse) -> dict:
    async for _ in response_events(response):
        pass
    return response.snapshot
