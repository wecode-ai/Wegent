# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Read native conversations and individual turns without duplicating storage."""

from dataclasses import dataclass
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy.orm import Session

from app.schemas.runtime_work import (
    NormalizedRuntimeMessage,
    RuntimeTaskAddress,
    RuntimeTranscriptRequest,
    RuntimeTranscriptResponse,
)
from app.schemas.wework_api import WeworkResponseObject
from app.services import runtime_work_service as runtime
from app.services.wework_api.identity import (
    ResponseIdentity,
    conversation_address,
    conversation_id,
)
from shared.telemetry.decorators import trace_async

STATUS_MAP = {
    "pending": "queued",
    "queued": "queued",
    "running": "in_progress",
    "streaming": "in_progress",
    "inprogress": "in_progress",
    "busy": "in_progress",
    "completed": "completed",
    "done": "completed",
    "succeeded": "completed",
    "failed": "failed",
    "error": "failed",
    "cancelled": "cancelled",
    "canceled": "cancelled",
    "interrupted": "cancelled",
    "incomplete": "incomplete",
}


def timestamp(value: str | int | None) -> int:
    if value is None:
        return 0
    if isinstance(value, int):
        return value // 1000 if value > 100_000_000_000 else value
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp())


def message_identity(message: NormalizedRuntimeMessage) -> str:
    return message.client_user_message_id or message.id


def public_conversation(item: dict) -> dict:
    return {key: value for key, value in item.items() if not key.startswith("_")}


@trace_async("wework_api.conversations", "wework.api")
async def conversations(db: Session, user_id: int) -> list[dict]:
    work = await runtime.list_runtime_work(db=db, user_id=user_id)
    items = []
    for workspace in work.chats:
        for task in workspace.tasks:
            items.append(
                {
                    "id": conversation_id(workspace.device_id, task.local_task_id),
                    "object": "conversation",
                    "title": task.title,
                    "created_at": timestamp(task.created_at),
                    "updated_at": timestamp(task.updated_at),
                    "running": task.running,
                    "status": task.status,
                    "device_id": workspace.device_id,
                    "runtime": task.runtime,
                    "model": (
                        task.model_selection.model_name if task.model_selection else ""
                    ),
                    "_turn_status": task.turn_status,
                    "_address": RuntimeTaskAddress(
                        deviceId=workspace.device_id,
                        taskId=task.local_task_id,
                        workspacePath=task.workspace_path,
                        runtimeHandle=task.runtime_handle,
                    ),
                }
            )
    return sorted(
        items, key=lambda item: (item["updated_at"], item["id"]), reverse=True
    )


async def find_conversation(db: Session, user_id: int, identifier: str) -> dict:
    conversation_address(identifier)
    for item in await conversations(db, user_id):
        if item["id"] == identifier:
            return item
    raise HTTPException(
        404, "Conversation unavailable; its owning device must be online"
    )


async def transcript(
    db: Session, user_id: int, item: dict, limit: int = 200, before: str | None = None
) -> RuntimeTranscriptResponse:
    return await runtime.get_runtime_transcript(
        db=db,
        user_id=user_id,
        address=RuntimeTranscriptRequest(
            **item["_address"].model_dump(),
            limit=limit,
            before_cursor=before,
            include_full_content=True,
        ),
    )


@dataclass
class Turn:
    identity: ResponseIdentity
    conversation: dict
    user_message: NormalizedRuntimeMessage
    replies: list[NormalizedRuntimeMessage]
    is_latest: bool

    @property
    def runtime_turn_id(self) -> str | None:
        for message in reversed(self.replies):
            if message.subtask_id is not None:
                return str(message.subtask_id)
        return None

    @property
    def status(self) -> str:
        if self.is_latest and self.replies and self.conversation["running"]:
            return "in_progress"
        values = [message.status for message in reversed(self.replies)]
        if self.is_latest:
            values.insert(
                0, self.conversation.get("_turn_status") or self.conversation["status"]
            )
        for value in values:
            normalized = str(value or "").lower().replace("_", "").replace("-", "")
            if normalized in STATUS_MAP:
                if (
                    self.is_latest
                    and not self.replies
                    and STATUS_MAP[normalized] == "in_progress"
                ):
                    return "queued"
                return STATUS_MAP[normalized]
        # Native transcripts omit status on settled messages, as in the mobile client.
        if self.replies:
            return "completed"
        return "queued" if self.is_latest else "incomplete"

    def response(self) -> dict:
        state = WeworkResponseObject(
            id=self.identity.id,
            created_at=timestamp(self.user_message.created_at),
            status=self.status,
            model=self.conversation["model"],
            conversation={"id": self.identity.conversation_id},
            is_latest=self.is_latest,
        ).model_dump()
        for message in self.replies:
            if message.role == "assistant" and message.content:
                state["output"].append(
                    {
                        "type": "message",
                        "id": f"msg_{message.id}",
                        "role": "assistant",
                        "status": (
                            "in_progress"
                            if self.status in {"queued", "in_progress"}
                            else (
                                "completed"
                                if self.status == "completed"
                                else "incomplete"
                            )
                        ),
                        "content": [
                            {
                                "type": "output_text",
                                "text": message.content,
                                "annotations": [],
                            }
                        ],
                    }
                )
        return state


async def read_turn(
    db: Session, user_id: int, identity: ResponseIdentity, item: dict | None = None
) -> Turn:
    item = item or await find_conversation(db, user_id, identity.conversation_id)
    messages: list[NormalizedRuntimeMessage] = []
    before = None
    seen = set()
    while True:
        page = await transcript(db, user_id, item, before=before)
        messages = page.messages + messages
        for index, message in enumerate(messages):
            if (
                message.role == "user"
                and message_identity(message) == identity.message_id
            ):
                end = next(
                    (
                        i
                        for i in range(index + 1, len(messages))
                        if messages[i].role == "user"
                    ),
                    len(messages),
                )
                return Turn(
                    identity,
                    item,
                    message,
                    messages[index + 1 : end],
                    end == len(messages),
                )
        if not page.has_more_before:
            raise HTTPException(
                404, "Response turn not found in the Runtime transcript"
            )
        before = page.before_cursor
        if not before or before in seen:
            raise HTTPException(
                502, "Runtime returned a non-advancing transcript cursor"
            )
        seen.add(before)


@trace_async("wework_api.conversation", "wework.api")
async def conversation_detail(
    db: Session, user_id: int, identifier: str, limit: int, before: str | None
) -> dict:
    item = await find_conversation(db, user_id, identifier)
    page = await transcript(db, user_id, item, limit, before)
    latest_page = page if before is None else await transcript(db, user_id, item)
    # A page may contain assistant messages only; continue backwards until the
    # latest user turn is found, retaining the native pagination contract.
    cursor = latest_page.before_cursor
    seen = set()
    messages = latest_page.messages
    while (
        not any(message.role == "user" for message in messages)
        and latest_page.has_more_before
    ):
        if not cursor or cursor in seen:
            raise HTTPException(
                502, "Runtime returned a non-advancing transcript cursor"
            )
        seen.add(cursor)
        latest_page = await transcript(db, user_id, item, before=cursor)
        messages = latest_page.messages + messages
        cursor = latest_page.before_cursor
    latest_user_index = next(
        (i for i in range(len(messages) - 1, -1, -1) if messages[i].role == "user"),
        None,
    )
    latest = None
    if latest_user_index is not None:
        message = messages[latest_user_index]
        address = item["_address"]
        identity = ResponseIdentity(
            address.device_id, address.local_task_id, message_identity(message)
        )
        latest = Turn(
            identity, item, message, messages[latest_user_index + 1 :], True
        ).response()
    return {
        **public_conversation(item),
        "messages": [
            message.model_dump(exclude_none=True) for message in page.messages
        ],
        "has_more": page.has_more_before,
        "before": page.before_cursor,
        "latest_response": latest,
    }
