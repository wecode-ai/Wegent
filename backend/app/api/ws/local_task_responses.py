# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Local runtime-task Responses API event forwarding."""

import asyncio
import logging
import uuid
from typing import Any, Callable, Optional

from app.api.ws.events import ServerEvents
from app.core.socketio import get_sio
from app.services.channels.callback import (
    forward_event_to_channel_callbacks,
    get_callback_registry,
    runtime_local_task_callback_key,
)
from app.services.execution.dispatcher import ResponsesAPIEventParser
from shared.models import EventType, ExecutionEvent
from shared.models.blocks import BlockStatus, create_tool_block
from shared.models.responses_api import ResponsesAPIStreamEvents

logger = logging.getLogger(__name__)

MAX_RUNTIME_SUBTASK_ID = 2_147_483_647


class LocalTaskResponsesHandler:
    """Translate local-task Responses API events into chat/channel events."""

    def __init__(self, event_parser: ResponsesAPIEventParser):
        self._event_parser = event_parser

    async def handle(
        self,
        *,
        user_id: int,
        device_id: str,
        event_type: str,
        data: dict,
        event_data: dict,
        message_id: Optional[int],
        get_lock: Callable[[int], asyncio.Lock],
        cleanup_lock: Callable[[int], None],
    ) -> dict:
        local_task_id = str(data["local_task_id"]).strip()
        subtask_id = runtime_subtask_id(data, device_id, local_task_id)
        lock = get_lock(subtask_id)
        is_terminal = False

        try:
            async with lock:
                source = (
                    data.get("source") if isinstance(data.get("source"), dict) else None
                )
                event = self.execution_event(
                    event_type=event_type,
                    event_data=event_data,
                    subtask_id=subtask_id,
                    message_id=message_id,
                )
                if event is None:
                    return {"success": True}

                await self.emit_execution_event(
                    user_id=user_id,
                    device_id=device_id,
                    local_task_id=local_task_id,
                    runtime=data.get("runtime"),
                    event=event,
                )
                await self.forward_channel_callbacks(
                    device_id=device_id,
                    local_task_id=local_task_id,
                    source=source,
                    event=event,
                )
                is_terminal = is_terminal_event(event)
                if is_terminal:
                    logger.info(
                        "Local task terminal event handled: user_id=%s "
                        "device_id=%s local_task_id=%s runtime=%s subtask_id=%s "
                        "event_type=%s terminal_status=%s error_code=%s",
                        user_id,
                        device_id,
                        local_task_id,
                        data.get("runtime"),
                        subtask_id,
                        event_type,
                        local_task_terminal_status(event),
                        event.error_code,
                    )

            if is_terminal:
                cleanup_lock(subtask_id)
            return {"success": True}

        except Exception as exc:
            logger.exception(
                "[Device WS] Error handling local-task Responses API event: "
                "type=%s, subtask_id=%s, error=%s",
                event_type,
                subtask_id,
                exc,
            )
            cleanup_lock(subtask_id)
            return {"error": str(exc)}

    def execution_event(
        self,
        *,
        event_type: str,
        event_data: dict,
        subtask_id: int,
        message_id: Optional[int],
    ) -> Optional[ExecutionEvent]:
        if event_type == ResponsesAPIStreamEvents.RESPONSE_CREATED.value:
            return ExecutionEvent(
                type=EventType.START.value,
                task_id=0,
                subtask_id=subtask_id,
                data={"shell_type": event_data.get("shell_type") or "Codex"},
                message_id=message_id,
            )
        return self._event_parser.parse(
            task_id=0,
            subtask_id=subtask_id,
            message_id=message_id,
            event_type=event_type,
            data=event_data,
        )

    async def emit_execution_event(
        self,
        *,
        user_id: int,
        device_id: str,
        local_task_id: str,
        runtime: Any,
        event: ExecutionEvent,
    ) -> None:
        base_payload = local_task_chat_payload(
            device_id=device_id,
            local_task_id=local_task_id,
            runtime=runtime,
            event=event,
        )
        event_type = (
            event.type.value if isinstance(event.type, EventType) else event.type
        )

        if event_type == EventType.START.value:
            await emit_local_task_chat_event(
                user_id,
                ServerEvents.CHAT_START,
                {
                    **base_payload,
                    "shell_type": (event.data or {}).get("shell_type") or "Codex",
                },
            )
            return

        if event_type == EventType.CHUNK.value:
            payload = {
                **base_payload,
                "content": event.content or "",
                "offset": event.offset,
            }
            if event.result is not None:
                payload["result"] = event.result
            if event.data:
                if event.data.get("block_id") is not None:
                    payload["block_id"] = event.data.get("block_id")
                if event.data.get("block_offset") is not None:
                    payload["block_offset"] = event.data.get("block_offset")
            await emit_local_task_chat_event(user_id, ServerEvents.CHAT_CHUNK, payload)
            return

        if event_type == EventType.THINKING.value:
            await emit_local_task_chat_event(
                user_id,
                ServerEvents.CHAT_CHUNK,
                {
                    **base_payload,
                    "content": "",
                    "offset": event.offset,
                    "result": {"reasoning_chunk": event.content or ""},
                },
            )
            return

        if event_type == EventType.DONE.value:
            await emit_local_task_chat_event(
                user_id,
                ServerEvents.CHAT_DONE,
                {
                    **base_payload,
                    "offset": event.offset,
                    "result": event.result or {},
                },
            )
            return

        if event_type == EventType.ERROR.value:
            payload = {
                **base_payload,
                "error": event.error or "Unknown error",
            }
            if event.error_code is not None:
                payload["type"] = event.error_code
            await emit_local_task_chat_event(user_id, ServerEvents.CHAT_ERROR, payload)
            return

        if event_type == EventType.CANCELLED.value:
            await emit_local_task_chat_event(
                user_id,
                ServerEvents.CHAT_CANCELLED,
                base_payload,
            )
            return

        if event_type == EventType.TOOL_START.value:
            await emit_local_task_chat_event(
                user_id,
                ServerEvents.CHAT_BLOCK_CREATED,
                {
                    **base_payload,
                    "block": local_task_tool_block(event),
                },
            )
            return

        if event_type in (
            EventType.TOOL_ARGUMENT_DELTA.value,
            EventType.TOOL_ARGUMENT_DONE.value,
            EventType.TOOL_RESULT.value,
        ):
            payload = local_task_tool_update_payload(base_payload, event)
            if payload is not None:
                await emit_local_task_chat_event(
                    user_id,
                    ServerEvents.CHAT_BLOCK_UPDATED,
                    payload,
                )
            return

        if event_type == EventType.BLOCK_CREATED.value:
            block = event.data.get("block") if event.data else None
            if isinstance(block, dict):
                await emit_local_task_chat_event(
                    user_id,
                    ServerEvents.CHAT_BLOCK_CREATED,
                    {**base_payload, "block": block},
                )
            return

        if event_type == EventType.BLOCK_UPDATED.value:
            block_id = event.data.get("block_id") if event.data else None
            updates = event.data.get("updates") if event.data else None
            if block_id and isinstance(updates, dict):
                await emit_local_task_chat_event(
                    user_id,
                    ServerEvents.CHAT_BLOCK_UPDATED,
                    {
                        **base_payload,
                        "block_id": str(block_id),
                        **updates,
                    },
                )

    async def forward_channel_callbacks(
        self,
        *,
        device_id: str,
        local_task_id: str,
        source: Optional[dict[str, Any]],
        event: ExecutionEvent,
    ) -> None:
        if not source or source.get("source") != "im":
            return

        callback_key = runtime_local_task_callback_key(device_id, local_task_id)
        if is_terminal_event(event):
            await get_callback_registry().handle_task_completed(
                task_id=callback_key,
                subtask_id=event.subtask_id,
                status=local_task_terminal_status(event),
                result=event.result,
                error=event.error,
            )
            return

        await forward_event_to_channel_callbacks(
            task_id=callback_key,
            subtask_id=event.subtask_id,
            event=event,
            source="Device WS local task",
        )


def local_task_chat_payload(
    *,
    device_id: str,
    local_task_id: str,
    runtime: Any,
    event: ExecutionEvent,
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "subtask_id": event.subtask_id,
        "device_id": device_id,
        "local_task_id": local_task_id,
        "runtime": runtime,
    }
    if event.message_id is not None:
        payload["message_id"] = event.message_id
    return payload


def local_task_tool_block(event: ExecutionEvent) -> dict[str, Any]:
    block = create_tool_block(
        tool_use_id=event.tool_use_id or "",
        tool_name=event.tool_name or "",
        tool_input=event.tool_input or {},
        display_name=(event.data or {}).get("display_name"),
    )
    if event.data:
        if event.data.get("tool_protocol"):
            block["tool_protocol"] = event.data.get("tool_protocol")
        if event.data.get("server_label"):
            block["server_label"] = event.data.get("server_label")
        if event.data.get("argument_status") == "streaming":
            block["status"] = "generating_arguments"
            block["argument_status"] = "streaming"
    return block


def local_task_tool_update_payload(
    base_payload: dict[str, Any],
    event: ExecutionEvent,
) -> Optional[dict[str, Any]]:
    if not event.tool_use_id:
        return None
    payload: dict[str, Any] = {
        **base_payload,
        "block_id": event.tool_use_id,
    }
    event_type = event.type.value if isinstance(event.type, EventType) else event.type
    if event.tool_input is not None:
        payload["tool_input"] = event.tool_input
    if event_type == EventType.TOOL_ARGUMENT_DELTA.value:
        payload["status"] = "generating_arguments"
        return payload
    if event_type == EventType.TOOL_ARGUMENT_DONE.value:
        payload["status"] = BlockStatus.PENDING.value
        return payload
    if event_type == EventType.TOOL_RESULT.value:
        payload["status"] = (
            BlockStatus.ERROR.value
            if (event.data or {}).get("status") in ("error", "failed")
            else BlockStatus.DONE.value
        )
        if event.tool_output is not None:
            payload["tool_output"] = event.tool_output
        return payload
    return None


def local_task_terminal_status(event: ExecutionEvent) -> str:
    event_type = event.type.value if isinstance(event.type, EventType) else event.type
    if event_type == EventType.ERROR.value:
        return "FAILED"
    if event_type == EventType.CANCELLED.value:
        return "CANCELLED"
    return "COMPLETED"


def is_terminal_event(event: ExecutionEvent) -> bool:
    event_type = event.type.value if isinstance(event.type, EventType) else event.type
    return event_type in (
        EventType.DONE.value,
        EventType.ERROR.value,
        EventType.CANCELLED.value,
    )


async def emit_local_task_chat_event(
    user_id: int,
    event_name: str,
    payload: dict[str, Any],
) -> None:
    await get_sio().emit(
        event_name,
        payload,
        room=f"user:{user_id}",
        namespace="/chat",
    )


def runtime_subtask_id(data: dict, device_id: str, local_task_id: str) -> int:
    value = data.get("subtask_id")
    if isinstance(value, int) and value > 0:
        return value
    runtime_key = f"{device_id}:{local_task_id}"
    return (
        uuid.uuid5(uuid.NAMESPACE_URL, runtime_key).int % (MAX_RUNTIME_SUBTASK_ID - 1)
    ) + 1
