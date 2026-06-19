# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Direct Socket.IO chat server for Wework local executor sessions."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

import socketio
from aiohttp import web

from executor.config import config
from shared.logger import setup_logger
from shared.models import ExecutionRequest
from shared.models.blocks import BlockStatus, create_tool_block
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.models.responses_api_emitter import EventTransport

if TYPE_CHECKING:
    from executor.modes.local.runner import LocalRunner

logger = setup_logger("direct_chat")

DIRECT_CHAT_NAMESPACE = "/wework-chat"
DIRECT_CHAT_SOCKET_PATH = "/socket.io"
DIRECT_CHAT_PROTOCOL_VERSION = 1
DIRECT_CHAT_PREPARE_PATH = "/api/local-executor/direct-chat/turns/prepare"
DIRECT_CHAT_CALLBACK_PATH = "/api/internal/callback"


@dataclass
class DirectConnection:
    """Authorized Wework direct connection state."""

    connection_id: str
    user_id: int
    user_name: str
    device_id: str
    expires_at: datetime


@dataclass
class DirectStreamState:
    """In-memory state for active direct-chat refresh recovery."""

    task_id: int
    subtask_id: int
    message_id: Optional[int]
    device_id: str
    started_at: str
    start_emitted: bool = False
    content: str = ""
    blocks: list[dict[str, Any]] = field(default_factory=list)


@dataclass
class DirectTaskContext:
    """Execution identifiers used by a direct-chat transport."""

    task_id: int
    subtask_id: int
    message_id: Optional[int]
    device_id: str
    shell_type: str = "Chat"
    bot_name: Optional[str] = None
    executor_name: Optional[str] = None
    executor_namespace: Optional[str] = None


class DirectChatBackendClient:
    """Authenticated HTTP client for direct-chat backend calls."""

    def __init__(self, auth_token: str):
        self.auth_token = auth_token

    @property
    def base_url(self) -> str:
        return (config.WEGENT_BACKEND_URL or "").rstrip("/")

    def post(
        self,
        path: str,
        payload: dict[str, Any],
        *,
        timeout: int = 30,
    ) -> dict[str, Any]:
        import requests

        if not self.base_url:
            raise RuntimeError("WEGENT_BACKEND_URL is not configured")
        if not self.auth_token:
            raise RuntimeError("WEGENT_AUTH_TOKEN is not configured")

        response = requests.post(
            f"{self.base_url}{path}",
            json=payload,
            headers={"Authorization": f"Bearer {self.auth_token}"},
            timeout=timeout,
        )
        if response.status_code >= 400:
            try:
                detail = response.json().get("detail")
            except Exception:
                detail = response.text
            raise RuntimeError(f"Backend direct chat request failed: {detail}")
        return response.json()


class DirectChatTransport(EventTransport):
    """Transport that streams executor events directly to connected Wework clients."""

    def __init__(
        self,
        *,
        server: "DirectChatServer",
        context: DirectTaskContext,
        backend_client: DirectChatBackendClient,
    ):
        self.server = server
        self.context = context
        self.backend_client = backend_client
        self._started = False
        self._tool_contexts: dict[str, dict[str, Any]] = {}

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> dict[str, Any]:
        msg_id = message_id or self.context.message_id
        await self._ensure_started(msg_id)

        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            await self._emit_text_delta(data)
        elif event_type == ResponsesAPIStreamEvents.STATUS_UPDATED.value:
            await self._emit_status_updated(data)
        elif event_type == ResponsesAPIStreamEvents.BLOCK_CREATED.value:
            await self._emit_direct_block_created(data)
        elif event_type == ResponsesAPIStreamEvents.BLOCK_UPDATED.value:
            await self._emit_direct_block_updated(data)
        elif event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            await self._emit_tool_start(data)
        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value:
            await self._emit_tool_arguments(data, status="generating_arguments")
        elif event_type == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value:
            await self._emit_tool_arguments(data, status=BlockStatus.PENDING.value)
        elif event_type in (
            ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value,
            ResponsesAPIStreamEvents.MCP_CALL_COMPLETED.value,
            ResponsesAPIStreamEvents.MCP_CALL_FAILED.value,
        ):
            await self._emit_tool_result(event_type, data)
        elif event_type in (
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
            ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
        ):
            await self._emit_reasoning(event_type, data)
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            result = self._prepare_done_result(data)
            callback_response = await self._submit_terminal_callback(
                event_type,
                data,
                msg_id,
                executor_name,
                executor_namespace,
            )
            completed_at = self._require_backend_timestamp(
                callback_response,
                "completed_at",
            )
            await self._emit_done(result, msg_id, completed_at)
        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            await self._emit_error(data, msg_id)
            await self._submit_terminal_callback(
                event_type,
                data,
                msg_id,
                executor_name,
                executor_namespace,
            )
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            await self._emit_cancelled()
            await self._submit_terminal_callback(
                event_type,
                data,
                msg_id,
                executor_name,
                executor_namespace,
            )

        return {"status": "success"}

    async def _ensure_started(self, message_id: Optional[int]) -> None:
        if self._started:
            return
        await self.server.ensure_stream_started(self.context, message_id)
        self._started = True

    async def _emit_text_delta(self, data: dict[str, Any]) -> None:
        content = data.get("delta", "")
        if not isinstance(content, str):
            content = str(content)
        if content:
            self.server.finalize_current_thinking_block(self.context.subtask_id)
        self.server.append_stream_content(self.context.subtask_id, content)
        payload: dict[str, Any] = {
            "task_id": self.context.task_id,
            "subtask_id": self.context.subtask_id,
            "content": content,
            "offset": data.get("offset", 0),
        }
        result: dict[str, Any] = {}
        if data.get("block_id"):
            result["block_id"] = data.get("block_id")
        if data.get("block_offset") is not None:
            result["block_offset"] = data.get("block_offset")
        if result:
            payload["result"] = result
        await self.server.emit_to_task(self.context.task_id, "chat:chunk", payload)

    async def _emit_status_updated(self, data: dict[str, Any]) -> None:
        phase = data.get("phase")
        if not phase:
            return
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:status_updated",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "phase": phase,
                "context_metrics": data.get("context_metrics") or {},
            },
        )

    async def _emit_direct_block_created(self, data: dict[str, Any]) -> None:
        block = data.get("block")
        if not isinstance(block, dict):
            return
        if block.get("type") != "thinking":
            self.server.finalize_current_thinking_block(self.context.subtask_id)
        self.server.add_or_update_block(self.context.subtask_id, block)
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:block_created",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "block": block,
            },
        )

    async def _emit_direct_block_updated(self, data: dict[str, Any]) -> None:
        block_id = data.get("block_id")
        updates = data.get("updates")
        if not block_id or not isinstance(updates, dict):
            return
        self.server.update_block(self.context.subtask_id, str(block_id), updates)
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:block_updated",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "block_id": str(block_id),
                **updates,
            },
        )

    async def _emit_tool_start(self, data: dict[str, Any]) -> None:
        item = data.get("item") or {}
        item_type = item.get("type")
        if item_type not in {"function_call", "mcp_call", "shell_call"}:
            return

        tool_use_id = str(item.get("call_id") or item.get("id") or "")
        if not tool_use_id:
            return
        tool_input = self._extract_tool_input(item)
        tool_name = item.get("name") or item.get("server_label") or ""
        self._tool_contexts[tool_use_id] = {
            "name": tool_name,
            "input": tool_input,
            "protocol": item_type,
        }
        block = create_tool_block(
            tool_use_id=tool_use_id,
            tool_name=tool_name,
            tool_input=tool_input,
            display_name=data.get("display_name"),
        )
        if data.get("argument_status") == "streaming":
            block["status"] = "generating_arguments"
            block["argument_status"] = "streaming"
        self.server.finalize_current_thinking_block(self.context.subtask_id)
        self.server.add_or_update_block(self.context.subtask_id, block)
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:block_created",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "block": block,
            },
        )

    async def _emit_tool_arguments(self, data: dict[str, Any], *, status: str) -> None:
        tool_use_id = str(data.get("call_id") or data.get("item_id") or "")
        if not tool_use_id:
            return
        tool_input = data.get("arguments_summary")
        if not isinstance(tool_input, dict):
            arguments = data.get("arguments")
            tool_input = self._parse_json_object(arguments)
        if isinstance(tool_input, dict):
            self._tool_contexts.setdefault(tool_use_id, {})["input"] = tool_input
        await self._emit_block_update(
            tool_use_id,
            {"tool_input": tool_input, "status": status},
        )

    async def _emit_tool_result(self, event_type: str, data: dict[str, Any]) -> None:
        item = data.get("item") or {}
        tool_use_id = str(
            data.get("item_id") or item.get("call_id") or item.get("id") or ""
        )
        if not tool_use_id:
            return
        context = self._tool_contexts.pop(tool_use_id, {})
        status_value = BlockStatus.DONE.value
        tool_output: Any = item.get("output") or data.get("output")
        if event_type == ResponsesAPIStreamEvents.MCP_CALL_FAILED.value:
            status_value = BlockStatus.ERROR.value
            tool_output = data.get("failure_reason")
        elif item.get("status") in {"error", "failed"}:
            status_value = BlockStatus.ERROR.value
            tool_output = item.get("error") or tool_output

        await self._emit_block_update(
            tool_use_id,
            {
                "tool_input": context.get("input"),
                "tool_output": tool_output,
                "status": status_value,
            },
        )

    async def _emit_reasoning(self, event_type: str, data: dict[str, Any]) -> None:
        reasoning = None
        if event_type == ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value:
            reasoning = data.get("delta", "")
        else:
            part = data.get("part") or {}
            if part.get("type") == "reasoning":
                reasoning = part.get("text", "")
        if reasoning is None:
            return
        self.server.add_reasoning_content(self.context.subtask_id, reasoning)
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:chunk",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "content": "",
                "offset": 0,
                "result": {"reasoning_chunk": reasoning},
            },
        )

    def _prepare_done_result(self, data: dict[str, Any]) -> dict[str, Any]:
        self.server.finalize_current_thinking_block(self.context.subtask_id)
        self.server.merge_stream_blocks_into_response(self.context.subtask_id, data)
        return self._extract_completed_result(data.get("response") or {})

    async def _emit_done(
        self,
        result: dict[str, Any],
        message_id: Optional[int],
        completed_at: str,
    ) -> None:
        for block in result.get("blocks") or []:
            if isinstance(block, dict) and block.get("type") == "guidance":
                await self.server.emit_to_task(
                    self.context.task_id,
                    "chat:block_created",
                    {
                        "task_id": self.context.task_id,
                        "subtask_id": self.context.subtask_id,
                        "block": block,
                    },
                )
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:done",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "offset": 0,
                "result": result,
                "message_id": message_id,
                "completed_at": completed_at,
            },
        )
        self.server.finish_stream(self.context.subtask_id)

    async def _emit_error(
        self, data: dict[str, Any], message_id: Optional[int]
    ) -> None:
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:error",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "error": data.get("message", "Unknown error"),
                "type": data.get("code"),
                "message_id": message_id,
            },
        )
        self.server.finish_stream(self.context.subtask_id)

    async def _emit_cancelled(self) -> None:
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:cancelled",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
            },
        )
        self.server.finish_stream(self.context.subtask_id)

    async def _emit_block_update(
        self,
        block_id: str,
        updates: dict[str, Any],
    ) -> None:
        clean_updates = {
            key: value for key, value in updates.items() if value is not None
        }
        self.server.update_block(self.context.subtask_id, block_id, clean_updates)
        await self.server.emit_to_task(
            self.context.task_id,
            "chat:block_updated",
            {
                "task_id": self.context.task_id,
                "subtask_id": self.context.subtask_id,
                "block_id": block_id,
                **clean_updates,
            },
        )

    async def _submit_terminal_callback(
        self,
        event_type: str,
        data: dict[str, Any],
        message_id: Optional[int],
        executor_name: Optional[str],
        executor_namespace: Optional[str],
    ) -> dict[str, Any]:
        payload = {
            "event_type": event_type,
            "task_id": self.context.task_id,
            "subtask_id": self.context.subtask_id,
            "message_id": message_id,
            "executor_name": executor_name or self.context.executor_name,
            "executor_namespace": executor_namespace or self.context.executor_namespace,
            "data": data,
        }
        return await asyncio.to_thread(
            self.backend_client.post,
            DIRECT_CHAT_CALLBACK_PATH,
            payload,
            timeout=30,
        )

    def _require_backend_timestamp(
        self,
        callback_response: dict[str, Any],
        field_name: str,
    ) -> str:
        value = callback_response.get(field_name)
        if not isinstance(value, str) or not value:
            raise RuntimeError(f"Backend callback response missing {field_name}")
        return value

    def _extract_tool_input(self, item: dict[str, Any]) -> dict[str, Any]:
        if isinstance(item.get("input"), dict):
            return dict(item["input"])
        parsed = self._parse_json_object(item.get("arguments"))
        if parsed is not None:
            return parsed
        action = item.get("action")
        if isinstance(action, dict):
            return dict(action)
        return {}

    def _parse_json_object(self, value: Any) -> Optional[dict[str, Any]]:
        if isinstance(value, dict):
            return value
        if not isinstance(value, str) or not value.strip():
            return None
        try:
            parsed = json.loads(value)
        except (TypeError, ValueError):
            return None
        return parsed if isinstance(parsed, dict) else None

    def _extract_completed_result(
        self, response_data: dict[str, Any]
    ) -> dict[str, Any]:
        value = ""
        reasoning_parts: list[str] = []
        for item in response_data.get("output", []):
            if not isinstance(item, dict):
                continue
            for content_block in item.get("content", []):
                if not isinstance(content_block, dict):
                    continue
                text = content_block.get("text")
                if not text:
                    continue
                if content_block.get("type") == "reasoning":
                    reasoning_parts.append(text)
                elif content_block.get("type") in (None, "output_text", "text"):
                    value += text
        reasoning_content = response_data.get("reasoning_content")
        if reasoning_content is None and reasoning_parts:
            reasoning_content = "".join(reasoning_parts)
        return {
            "value": value,
            "usage": response_data.get("usage"),
            "sources": response_data.get("sources"),
            "blocks": response_data.get("blocks"),
            "silent_exit": response_data.get("silent_exit"),
            "silent_exit_reason": response_data.get("silent_exit_reason"),
            "deferred_user_input": response_data.get("deferred_user_input"),
            "deferred_user_input_tool_use_id": response_data.get(
                "deferred_user_input_tool_use_id"
            ),
            "loaded_skills": response_data.get("loaded_skills"),
            "stop_reason": response_data.get("stop_reason"),
            "messages_chain": response_data.get("messages_chain"),
            "context_metrics": response_data.get("context_metrics"),
            "standalone_chat_workspace_path": response_data.get(
                "standalone_chat_workspace_path"
            ),
            "file_changes": response_data.get("file_changes"),
            "reasoning_content": reasoning_content,
        }


class DirectChatServer:
    """Socket.IO server mounted on the local executor gateway."""

    def __init__(self, runner: "LocalRunner", *, allowed_origins: list[str]):
        self.runner = runner
        self.sio = socketio.AsyncServer(
            async_mode="aiohttp",
            cors_allowed_origins=allowed_origins,
            ping_interval=25,
            ping_timeout=20,
        )
        self.namespace = DIRECT_CHAT_NAMESPACE
        self._sid_connections: dict[str, DirectConnection] = {}
        self._task_sids: dict[int, set[str]] = {}
        self._subtask_task: dict[int, int] = {}
        self._streams: dict[int, DirectStreamState] = {}
        self._backend_client = DirectChatBackendClient(
            self.runner.websocket_client.auth_token
        )
        self._register_socket_handlers()

    def attach(self, app: web.Application) -> None:
        """Attach the Socket.IO server to the shared aiohttp gateway."""
        self.sio.attach(app, socketio_path=DIRECT_CHAT_SOCKET_PATH)

    @staticmethod
    def build_registration_payload(public_base_url: str) -> dict[str, Any]:
        """Return the static direct-chat endpoint reported during registration."""
        return {
            "enabled": True,
            "transport": "socket.io",
            "base_url": public_base_url.rstrip("/"),
            "socket_path": DIRECT_CHAT_SOCKET_PATH,
            "namespace": DIRECT_CHAT_NAMESPACE,
            "version": DIRECT_CHAT_PROTOCOL_VERSION,
        }

    async def emit_to_task(
        self,
        task_id: int,
        event: str,
        payload: dict[str, Any],
    ) -> None:
        await self.sio.emit(
            event,
            payload,
            room=self._task_room(task_id),
            namespace=self.namespace,
        )

    async def emit_device_event(self, event: str, payload: dict[str, Any]) -> None:
        """Broadcast a device-scoped event to connected Wework clients."""
        await self.sio.emit(event, payload, namespace=self.namespace)

    async def ensure_stream_started(
        self,
        context: DirectTaskContext,
        message_id: Optional[int],
    ) -> None:
        stream = self._streams.get(context.subtask_id)
        if not stream:
            raise RuntimeError("Direct chat stream is missing backend started_at")
        if stream.start_emitted:
            return
        if not stream.started_at:
            raise RuntimeError("Direct chat stream is missing backend started_at")

        stream.start_emitted = True
        try:
            await self.emit_to_task(
                context.task_id,
                "chat:start",
                {
                    "task_id": context.task_id,
                    "subtask_id": context.subtask_id,
                    "message_id": message_id,
                    "bot_name": context.bot_name,
                    "shell_type": context.shell_type,
                    "started_at": stream.started_at,
                },
            )
        except Exception:
            stream.start_emitted = False
            raise

    def append_stream_content(self, subtask_id: int, content: str) -> None:
        stream = self._streams.get(subtask_id)
        if stream:
            stream.content += content

    def add_reasoning_content(self, subtask_id: int, content: str) -> None:
        if not content:
            return
        stream = self._streams.get(subtask_id)
        if not stream:
            return

        current = self._find_current_thinking_block(stream)
        if current:
            current["content"] = f"{current.get('content') or ''}{content}"
            return

        thinking_count = sum(
            1 for block in stream.blocks if block.get("type") == "thinking"
        )
        stream.blocks.append(
            {
                "id": f"thinking-{subtask_id}-{thinking_count + 1}",
                "type": "thinking",
                "content": content,
                "status": BlockStatus.STREAMING.value,
                "timestamp": self._now_ms(),
            }
        )

    def finalize_current_thinking_block(self, subtask_id: int) -> None:
        stream = self._streams.get(subtask_id)
        if not stream:
            return
        for block in stream.blocks:
            if (
                block.get("type") == "thinking"
                and block.get("status") == BlockStatus.STREAMING.value
            ):
                block["status"] = BlockStatus.DONE.value

    def merge_stream_blocks_into_response(
        self, subtask_id: int, data: dict[str, Any]
    ) -> None:
        stream = self._streams.get(subtask_id)
        if not stream or not stream.blocks:
            return

        response = data.get("response")
        if not isinstance(response, dict):
            response = {}
            data["response"] = response

        response["blocks"] = self._merge_blocks(
            stream.blocks,
            response.get("blocks"),
        )

    def add_or_update_block(self, subtask_id: int, block: dict[str, Any]) -> None:
        stream = self._streams.get(subtask_id)
        if not stream:
            return
        block_id = str(block.get("id") or "")
        if not block_id:
            return
        for index, existing in enumerate(stream.blocks):
            if str(existing.get("id")) == block_id:
                stream.blocks[index] = {**existing, **block}
                return
        stream.blocks.append(block)

    def update_block(
        self,
        subtask_id: int,
        block_id: str,
        updates: dict[str, Any],
    ) -> None:
        stream = self._streams.get(subtask_id)
        if not stream:
            return
        for block in stream.blocks:
            if str(block.get("id")) == block_id:
                block.update(updates)
                return

    @staticmethod
    def _find_current_thinking_block(
        stream: DirectStreamState,
    ) -> Optional[dict[str, Any]]:
        for block in reversed(stream.blocks):
            if (
                block.get("type") == "thinking"
                and block.get("status") == BlockStatus.STREAMING.value
            ):
                return block
        return None

    @staticmethod
    def _merge_blocks(
        first: Any,
        second: Any,
    ) -> list[dict[str, Any]]:
        merged: list[dict[str, Any]] = []
        index_by_id: dict[str, int] = {}

        for candidate in (first, second):
            if not isinstance(candidate, list):
                continue
            for block in candidate:
                if not isinstance(block, dict):
                    continue
                block_copy = dict(block)
                block_id = str(block_copy.get("id") or "")
                if block_id and block_id in index_by_id:
                    index = index_by_id[block_id]
                    merged[index] = {**merged[index], **block_copy}
                    continue
                if block_id:
                    index_by_id[block_id] = len(merged)
                merged.append(block_copy)

        return merged

    @staticmethod
    def _now_ms() -> int:
        return int(datetime.now(timezone.utc).timestamp() * 1000)

    def finish_stream(self, subtask_id: int) -> None:
        task_id = self._subtask_task.pop(subtask_id, None)
        self._streams.pop(subtask_id, None)
        if task_id is not None:
            self._task_sids.pop(task_id, None)

    def _register_socket_handlers(self) -> None:
        @self.sio.event(namespace=self.namespace)
        async def connect(sid: str, environ: dict, auth: Optional[dict]) -> bool:
            connection = self._validate_socket_auth(auth or {})
            if not connection:
                return False
            self._sid_connections[sid] = connection
            await self.sio.emit(
                "device:online",
                {"device_id": connection.device_id, "status": "online"},
                to=sid,
                namespace=self.namespace,
            )
            logger.info(
                "[DirectChat] Wework connected: sid=%s user=%s device=%s",
                sid,
                connection.user_id,
                connection.device_id,
            )
            return True

        @self.sio.event(namespace=self.namespace)
        async def disconnect(sid: str) -> None:
            connection = self._sid_connections.pop(sid, None)
            self._remove_sid_from_tasks(sid)
            if connection:
                logger.info(
                    "[DirectChat] Wework disconnected: sid=%s user=%s device=%s",
                    sid,
                    connection.user_id,
                    connection.device_id,
                )

        @self.sio.on("task:join", namespace=self.namespace)
        async def task_join(sid: str, data: dict) -> dict[str, Any]:
            task_id = int(data.get("task_id") or 0)
            if task_id <= 0:
                return {"error": "task_id is required"}
            await self._join_task(sid, task_id)
            streaming = self._active_stream_for_task(task_id)
            return {"streaming": streaming}

        @self.sio.on("task:leave", namespace=self.namespace)
        async def task_leave(sid: str, data: dict) -> dict[str, Any]:
            task_id = int(data.get("task_id") or 0)
            if task_id > 0:
                await self.sio.leave_room(
                    sid,
                    self._task_room(task_id),
                    namespace=self.namespace,
                )
                sids = self._task_sids.get(task_id)
                if sids:
                    sids.discard(sid)
            return {"success": True}

        @self.sio.on("chat:send", namespace=self.namespace)
        async def chat_send(sid: str, data: dict) -> dict[str, Any]:
            return await self._handle_chat_send(sid, data)

        @self.sio.on("chat:cancel", namespace=self.namespace)
        async def chat_cancel(sid: str, data: dict) -> dict[str, Any]:
            subtask_id = int(data.get("subtask_id") or 0)
            if subtask_id <= 0:
                return {"success": False, "error": "subtask_id is required"}
            task_id = self._subtask_task.get(subtask_id)
            if not task_id:
                return {"success": False, "error": "No running task found"}
            await self.runner.cancel_task(task_id, subtask_id)
            return {"success": True}

        @self.sio.on("chat:guide", namespace=self.namespace)
        async def chat_guide(sid: str, data: dict) -> dict[str, Any]:
            return {
                "success": False,
                "error": "Direct chat guidance is not supported yet",
            }

        @self.sio.on("connection:probe", namespace=self.namespace)
        async def connection_probe(sid: str) -> dict[str, Any]:
            connection = self._sid_connections.get(sid)
            if not connection:
                return {"success": False, "error": "Not authenticated"}
            return {
                "success": True,
                "device_id": connection.device_id,
                "server_time_ms": self._now_ms(),
            }

    async def _handle_chat_send(self, sid: str, data: dict) -> dict[str, Any]:
        connection = self._sid_connections.get(sid)
        if not connection:
            return {"success": False, "error": "Not authenticated"}

        device_id = data.get("device_id")
        if device_id and device_id != self.runner.websocket_client.device_id:
            return {"success": False, "error": "Device ID mismatch"}
        data["device_id"] = self.runner.websocket_client.device_id

        try:
            prepared = await asyncio.to_thread(
                self._backend_client.post,
                DIRECT_CHAT_PREPARE_PATH,
                {"connection_id": connection.connection_id, "payload": data},
                timeout=60,
            )
        except Exception as exc:
            logger.exception("[DirectChat] Failed to prepare turn")
            return {"success": False, "error": str(exc)}

        task_id = prepared.get("task_id")
        await self._join_task(sid, int(task_id))

        execution_payload = prepared.get("execution_request")
        if prepared.get("ai_triggered") and execution_payload:
            request = ExecutionRequest.from_dict(execution_payload)
            context = self._build_task_context(request, prepared)
            assistant_started_at = prepared.get("assistant_started_at")
            if not isinstance(assistant_started_at, str) or not assistant_started_at:
                return {
                    "success": False,
                    "error": "Backend prepare response missing assistant_started_at",
                }
            self._streams[context.subtask_id] = DirectStreamState(
                task_id=context.task_id,
                subtask_id=context.subtask_id,
                message_id=context.message_id,
                device_id=connection.device_id,
                started_at=assistant_started_at,
            )
            self._subtask_task[context.subtask_id] = context.task_id
            await self.ensure_stream_started(context, context.message_id)
            transport = DirectChatTransport(
                server=self,
                context=context,
                backend_client=self._backend_client,
            )
            await self.runner.enqueue_direct_task(request, transport)

        return {
            "success": True,
            "task_id": task_id,
            "subtask_id": prepared.get("user_subtask_id"),
            "message_id": prepared.get("user_message_id"),
        }

    def _build_task_context(
        self,
        request: ExecutionRequest,
        prepared: dict[str, Any],
    ) -> DirectTaskContext:
        shell_type = "Chat"
        if request.bot:
            shell_type = request.bot[0].get("shell_type") or shell_type
        return DirectTaskContext(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            message_id=prepared.get("assistant_message_id") or request.message_id,
            device_id=request.device_id or self.runner.websocket_client.device_id,
            shell_type=shell_type,
            bot_name=request.bot_name or None,
            executor_name=request.executor_name,
            executor_namespace=request.executor_namespace,
        )

    async def _join_task(self, sid: str, task_id: int) -> None:
        await self.sio.enter_room(
            sid,
            self._task_room(task_id),
            namespace=self.namespace,
        )
        self._task_sids.setdefault(task_id, set()).add(sid)

    def _remove_sid_from_tasks(self, sid: str) -> None:
        empty_task_ids = []
        for task_id, sids in self._task_sids.items():
            sids.discard(sid)
            if not sids:
                empty_task_ids.append(task_id)
        for task_id in empty_task_ids:
            self._task_sids.pop(task_id, None)

    def _active_stream_for_task(self, task_id: int) -> Optional[dict[str, Any]]:
        for stream in self._streams.values():
            if stream.task_id != task_id:
                continue
            return {
                "task_id": stream.task_id,
                "subtask_id": stream.subtask_id,
                "message_id": stream.message_id,
                "cached_content": stream.content,
                "blocks": stream.blocks,
                "started_at": stream.started_at,
            }
        return None

    def _validate_socket_auth(self, auth: dict[str, Any]) -> Optional[DirectConnection]:
        connection_id = auth.get("connection_id")
        token = auth.get("token")
        if not isinstance(connection_id, str) or not isinstance(token, str):
            return None
        direct_secret = self.runner.websocket_client.direct_chat_secret
        if not direct_secret:
            logger.warning("[DirectChat] Missing direct chat secret")
            return None
        payload = self._verify_direct_chat_token(token, direct_secret)
        if not payload:
            return None
        if payload.get("connection_id") != connection_id:
            return None
        if payload.get("device_id") != self.runner.websocket_client.device_id:
            return None
        expires_at = self._parse_epoch_seconds(payload.get("exp"))
        if not expires_at or datetime.now(timezone.utc) >= expires_at:
            return None
        user_id = payload.get("user_id")
        user_name = payload.get("user_name")
        if not isinstance(user_id, int) or not isinstance(user_name, str):
            return None
        return DirectConnection(
            connection_id=connection_id,
            user_id=user_id,
            user_name=user_name,
            device_id=self.runner.websocket_client.device_id,
            expires_at=expires_at,
        )

    def _verify_direct_chat_token(
        self,
        token: str,
        secret: str,
    ) -> Optional[dict[str, Any]]:
        try:
            payload_segment, signature_segment = token.split(".", 1)
            expected_signature = hmac.new(
                secret.encode("utf-8"),
                payload_segment.encode("ascii"),
                hashlib.sha256,
            ).digest()
            actual_signature = self._base64url_decode(signature_segment)
            if not hmac.compare_digest(expected_signature, actual_signature):
                return None
            payload = json.loads(
                self._base64url_decode(payload_segment).decode("utf-8")
            )
        except Exception:
            return None
        return payload if isinstance(payload, dict) else None

    @staticmethod
    def _base64url_decode(value: str) -> bytes:
        padding = "=" * (-len(value) % 4)
        return base64.urlsafe_b64decode(f"{value}{padding}".encode("ascii"))

    @staticmethod
    def _parse_epoch_seconds(value: Any) -> Optional[datetime]:
        if not isinstance(value, int):
            return None
        return datetime.fromtimestamp(value, tz=timezone.utc)

    def _task_room(self, task_id: int) -> str:
        return f"task:{task_id}"
