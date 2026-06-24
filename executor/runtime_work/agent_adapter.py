# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime task adapter that executes local code agents without DB task rows."""

import asyncio
import copy
import json
import time
import uuid
from dataclasses import replace
from typing import Any, Awaitable, Callable, Optional

from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    LocalTaskStore,
    normalize_workspace_path,
    utc_now_iso,
)
from shared.logger import setup_logger
from shared.models import EventTransport, ResponsesAPIEmitter
from shared.models.execution import ExecutionRequest
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.status import TaskStatus

logger = setup_logger("runtime_agent_adapter")

ExecuteAgent = Callable[[ExecutionRequest, ResponsesAPIEmitter], Awaitable[Any]]


class RuntimeTranscriptTransport(EventTransport):
    """Capture agent Responses API events into a LocalTask transcript."""

    def __init__(
        self,
        store: LocalTaskStore,
        local_task_id: str,
        *,
        runtime: str,
        emit_event: Optional[Callable[[str, dict[str, Any]], Any]] = None,
    ):
        self.store = store
        self.local_task_id = local_task_id
        self.runtime = runtime
        self.emit_event = emit_event
        self._assistant_draft = ""
        self._processing_blocks: list[dict[str, Any]] = []
        self._tool_blocks_by_call_id: dict[str, dict[str, Any]] = {}
        self._active_thinking_block: Optional[dict[str, Any]] = None

    async def send(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int] = None,
        executor_name: Optional[str] = None,
        executor_namespace: Optional[str] = None,
    ) -> None:
        self._record_processing_event(event_type, data, subtask_id)

        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            self._assistant_draft += str(data.get("delta") or "")
            await self._forward_event(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )
            return
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value:
            self._assistant_draft = str(data.get("text") or self._assistant_draft)
            await self._forward_event(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )
            return
        if event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            self._append_assistant_message(
                content=_completed_content(data) or self._assistant_draft,
                status="done",
                subtask_id=subtask_id,
                executor_session=data.get("executor_session"),
                blocks=self._consume_processing_blocks(terminal_status="done"),
                file_changes=_completed_file_changes(data),
            )
            self._assistant_draft = ""
            await self._forward_event(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )
            return
        if event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            self._append_assistant_message(
                content=_incomplete_content(data) or self._assistant_draft,
                status="cancelled",
                subtask_id=subtask_id,
                blocks=self._consume_processing_blocks(terminal_status="done"),
            )
            self._assistant_draft = ""
            await self._forward_event(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )
            return
        if event_type == ResponsesAPIStreamEvents.ERROR.value:
            self._append_assistant_message(
                content=str(data.get("message") or "Runtime execution failed"),
                status="failed",
                subtask_id=subtask_id,
                blocks=self._consume_processing_blocks(terminal_status="error"),
            )
            self._assistant_draft = ""
            await self._forward_event(
                event_type,
                task_id,
                subtask_id,
                data,
                message_id,
                executor_name,
                executor_namespace,
            )
            return

        await self._forward_event(
            event_type,
            task_id,
            subtask_id,
            data,
            message_id,
            executor_name,
            executor_namespace,
        )

    async def _forward_event(
        self,
        event_type: str,
        task_id: int,
        subtask_id: int,
        data: dict,
        message_id: Optional[int],
        executor_name: Optional[str],
        executor_namespace: Optional[str],
    ) -> None:
        if self.emit_event is None:
            return

        payload: dict[str, Any] = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
            "local_task_id": self.local_task_id,
            "runtime": self.runtime,
        }
        if message_id is not None:
            payload["message_id"] = message_id
        if executor_name is not None:
            payload["executor_name"] = executor_name
        if executor_namespace is not None:
            payload["executor_namespace"] = executor_namespace

        result = self.emit_event(event_type, payload)
        if asyncio.iscoroutine(result):
            await result

    def _record_processing_event(
        self, event_type: str, data: dict[str, Any], subtask_id: int
    ) -> None:
        if event_type in {
            ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value,
            ResponsesAPIStreamEvents.RESPONSE_PART_ADDED.value,
        }:
            content = _reasoning_content(event_type, data)
            if content:
                self._append_thinking(content, subtask_id)
            return

        if event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_ADDED.value:
            self._record_tool_start(data)
            return

        if event_type in {
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value,
            ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DONE.value,
        }:
            self._record_tool_arguments(data)
            return

        if event_type == ResponsesAPIStreamEvents.OUTPUT_ITEM_DONE.value:
            self._record_tool_done(data)

    def _append_thinking(self, content: str, subtask_id: int) -> None:
        if self._active_thinking_block is None:
            self._active_thinking_block = {
                "id": (
                    f"{self.local_task_id}:thinking:{subtask_id}:"
                    f"{len(self._processing_blocks)}"
                ),
                "type": "thinking",
                "content": "",
                "status": "streaming",
                "timestamp": _current_timestamp_ms(),
            }
            self._processing_blocks.append(self._active_thinking_block)

        self._active_thinking_block["content"] = (
            str(self._active_thinking_block.get("content") or "") + content
        )
        self._active_thinking_block["timestamp"] = _current_timestamp_ms()

    def _finish_active_thinking(self) -> None:
        if self._active_thinking_block is None:
            return
        self._active_thinking_block["status"] = "done"
        self._active_thinking_block["timestamp"] = _current_timestamp_ms()
        self._active_thinking_block = None

    def _record_tool_start(self, data: dict[str, Any]) -> None:
        item = data.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        if item_type not in {"function_call", "mcp_call", "shell_call"}:
            return

        call_id = item.get("call_id") or item.get("id")
        if not isinstance(call_id, str) or not call_id:
            return

        self._finish_active_thinking()
        arguments = _tool_arguments(data, item)
        block = self._tool_blocks_by_call_id.get(call_id)
        if block is None:
            block = {
                "id": call_id,
                "type": "tool",
                "tool_use_id": call_id,
                "tool_name": str(item.get("name") or "unknown"),
                "tool_input": arguments,
                "status": "pending",
                "timestamp": _current_timestamp_ms(),
            }
            self._processing_blocks.append(block)
            self._tool_blocks_by_call_id[call_id] = block
        else:
            block["tool_name"] = str(
                item.get("name") or block.get("tool_name") or "unknown"
            )
            block["tool_input"] = arguments
            block["timestamp"] = _current_timestamp_ms()

        if data.get("display_name"):
            block["display_name"] = data.get("display_name")
        if data.get("argument_status") == "streaming":
            block["status"] = "generating_arguments"
            block["argument_status"] = "streaming"

    def _record_tool_arguments(self, data: dict[str, Any]) -> None:
        call_id = data.get("call_id") or data.get("item_id")
        if not isinstance(call_id, str) or not call_id:
            return
        block = self._tool_blocks_by_call_id.get(call_id)
        if block is None:
            block = {
                "id": call_id,
                "type": "tool",
                "tool_use_id": call_id,
                "tool_name": "unknown",
                "tool_input": {},
                "timestamp": _current_timestamp_ms(),
            }
            self._processing_blocks.append(block)
            self._tool_blocks_by_call_id[call_id] = block

        arguments = _tool_arguments(data, {})
        if arguments:
            block["tool_input"] = arguments
        block["status"] = (
            "generating_arguments"
            if data.get("type")
            == ResponsesAPIStreamEvents.FUNCTION_CALL_ARGUMENTS_DELTA.value
            else "pending"
        )
        block["timestamp"] = _current_timestamp_ms()

    def _record_tool_done(self, data: dict[str, Any]) -> None:
        item = data.get("item")
        if not isinstance(item, dict):
            return
        item_type = item.get("type")
        if item_type not in {"function_call", "mcp_call", "shell_call"}:
            return

        call_id = item.get("call_id") or item.get("id")
        if not isinstance(call_id, str) or not call_id:
            return

        block = self._tool_blocks_by_call_id.get(call_id)
        if block is None:
            block = {
                "id": call_id,
                "type": "tool",
                "tool_use_id": call_id,
                "tool_name": str(item.get("name") or "unknown"),
                "tool_input": _tool_arguments(data, item),
                "timestamp": _current_timestamp_ms(),
            }
            self._processing_blocks.append(block)
            self._tool_blocks_by_call_id[call_id] = block

        arguments = _tool_arguments(data, item)
        if arguments:
            block["tool_input"] = arguments
        block["tool_output"] = item.get("output")
        block.pop("argument_status", None)
        block["status"] = (
            "error" if item.get("status") in {"error", "failed"} else "done"
        )
        block["timestamp"] = _current_timestamp_ms()

    def _consume_processing_blocks(
        self, *, terminal_status: str
    ) -> list[dict[str, Any]]:
        self._finish_active_thinking()
        blocks = copy.deepcopy(self._processing_blocks)
        for block in blocks:
            if block.get("status") not in {"done", "error"}:
                block["status"] = terminal_status
            block.setdefault("timestamp", _current_timestamp_ms())
        self._processing_blocks = []
        self._tool_blocks_by_call_id = {}
        self._active_thinking_block = None
        return blocks

    def _append_assistant_message(
        self,
        *,
        content: str,
        status: str,
        subtask_id: int,
        executor_session: Optional[Any] = None,
        blocks: Optional[list[dict[str, Any]]] = None,
        file_changes: Optional[dict[str, Any]] = None,
    ) -> None:
        message = {
            "id": f"{self.local_task_id}:assistant:{subtask_id}",
            "role": "assistant",
            "content": content,
            "createdAt": utc_now_iso(),
            "status": status,
            "subtaskId": subtask_id,
        }
        if blocks:
            message["blocks"] = blocks
        if file_changes:
            message["fileChanges"] = copy.deepcopy(file_changes)

        def update(task: LocalTaskRecord) -> LocalTaskRecord:
            handle = dict(task.runtime_handle)
            messages = _message_list(handle)
            messages.append(message)
            handle["messages"] = messages
            if isinstance(executor_session, dict):
                handle["executorSession"] = executor_session
            return replace(
                task,
                runtime_handle=handle,
                updated_at=utc_now_iso(),
            )

        self.store.update_task(self.local_task_id, update)


class RuntimeAgentAdapter:
    """Create and continue runtime-native Codex or Claude Code tasks."""

    def __init__(
        self,
        *,
        runtime: str,
        store: LocalTaskStore,
        execute_agent: Optional[ExecuteAgent] = None,
        run_background: bool = True,
        responses_event_emitter: Optional[Callable[[str, dict[str, Any]], Any]] = None,
    ):
        self.runtime = runtime
        self.store = store
        self.execute_agent = execute_agent or self._execute_real_agent
        self.run_background = run_background
        self.responses_event_emitter = responses_event_emitter
        self._running_tasks: set[asyncio.Task] = set()
        self._running_tasks_by_local_task_id: dict[str, asyncio.Task] = {}

    async def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        workspace_path = _required_workspace_path(payload)
        message = _required_text(payload, "message")
        title = str(payload.get("title") or message).strip()[:100] or "New task"
        local_task_id = str(payload.get("localTaskId") or f"runtime-{uuid.uuid4()}")
        request = self._execution_request(payload, message=message, new_session=True)
        runtime_handle = {
            "executionRequest": request.to_dict(),
            "nextSubtaskId": request.subtask_id + 1,
            "messages": [
                _user_message(
                    local_task_id,
                    message,
                    request.subtask_id,
                    attachments=_runtime_attachments(request.attachments),
                )
            ],
        }
        self.store.upsert_task(
            LocalTaskRecord(
                local_task_id=local_task_id,
                workspace_path=workspace_path,
                title=title,
                runtime=self.runtime,
                runtime_handle=runtime_handle,
                created_at=utc_now_iso(),
                updated_at=utc_now_iso(),
                running=True,
                status="active",
            )
        )
        await self._start_run(local_task_id, request)
        return {
            "success": True,
            "accepted": True,
            "localTaskId": local_task_id,
            "workspacePath": workspace_path,
            "runtime": self.runtime,
        }

    async def send(
        self, task: LocalTaskRecord, payload: dict[str, Any]
    ) -> dict[str, Any]:
        message = _required_text(payload, "message")
        attachments = _payload_attachments(payload)
        request = self._followup_request(task, message, attachments=attachments)
        user_message = _user_message(
            task.local_task_id,
            message,
            request.subtask_id,
            attachments=_runtime_attachments(request.attachments),
        )

        def update(current: LocalTaskRecord) -> LocalTaskRecord:
            handle = dict(current.runtime_handle)
            messages = _message_list(handle)
            messages.append(user_message)
            handle["messages"] = messages
            handle["executionRequest"] = request.to_dict()
            handle["nextSubtaskId"] = request.subtask_id + 1
            return replace(
                current,
                runtime_handle=handle,
                running=True,
                updated_at=utc_now_iso(),
            )

        self.store.update_task(
            task.local_task_id, update, workspace_path=task.workspace_path
        )
        await self._start_run(task.local_task_id, request)
        return {
            "success": True,
            "accepted": True,
            "localTaskId": task.local_task_id,
        }

    async def get_transcript(self, task: LocalTaskRecord) -> list[dict[str, Any]]:
        return _message_list(task.runtime_handle)

    async def _start_run(self, local_task_id: str, request: ExecutionRequest) -> None:
        if not self.run_background:
            await self._run_agent(local_task_id, request)
            return

        task = asyncio.create_task(self._run_agent(local_task_id, request))
        self._running_tasks.add(task)
        self._running_tasks_by_local_task_id[local_task_id] = task

        def cleanup(completed_task: asyncio.Task) -> None:
            self._running_tasks.discard(completed_task)
            if (
                self._running_tasks_by_local_task_id.get(local_task_id)
                is completed_task
            ):
                self._running_tasks_by_local_task_id.pop(local_task_id, None)

        task.add_done_callback(cleanup)

    async def cancel(self, payload: dict[str, Any]) -> dict[str, Any]:
        local_task_id = _required_text(payload, "localTaskId")
        workspace_path = payload.get("workspacePath")
        task = self.store.get_task(
            local_task_id,
            workspace_path=workspace_path if isinstance(workspace_path, str) else None,
        )
        running_task = self._running_tasks_by_local_task_id.get(local_task_id)
        if running_task and not running_task.done():
            running_task.cancel()
        self._mark_not_running(local_task_id)
        return {
            "success": True,
            "accepted": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": task.runtime,
        }

    async def _run_agent(self, local_task_id: str, request: ExecutionRequest) -> None:
        transport = RuntimeTranscriptTransport(
            self.store,
            local_task_id,
            runtime=self.runtime,
            emit_event=self.responses_event_emitter,
        )
        emitter = ResponsesAPIEmitter(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            transport=transport,
            model=str(request.model_config.get("model_id") or ""),
        )
        try:
            await self.execute_agent(request, emitter)
            self._mark_not_running(local_task_id)
        except asyncio.CancelledError:
            await emitter.incomplete(reason="cancelled")
            self._mark_not_running(local_task_id)
        except Exception as exc:
            logger.exception("Runtime agent execution failed: %s", exc)
            await emitter.error(str(exc), "execution_error")
            self._mark_not_running(local_task_id)

    async def _execute_real_agent(
        self,
        request: ExecutionRequest,
        emitter: ResponsesAPIEmitter,
    ) -> None:
        from executor.agents.factory import AgentFactory

        agent_type = "codex" if self.runtime == "codex" else "claudecode"
        agent = AgentFactory.get_agent(agent_type, request, emitter=emitter)
        if agent is None:
            await emitter.error(f"Unsupported runtime: {self.runtime}", "runtime_error")
            return

        init_status = agent.initialize()
        if init_status != TaskStatus.SUCCESS:
            await emitter.error("Agent initialization failed", "init_error")
            return

        pre_status, pre_error = await agent.pre_execute()
        if pre_status != TaskStatus.SUCCESS:
            await emitter.error(
                pre_error or "Agent pre-execution failed", "pre_execute_error"
            )
            return

        result = await agent.execute_async()
        if result == TaskStatus.CANCELLED:
            await emitter.incomplete(reason="cancelled")
        elif result not in {TaskStatus.COMPLETED, TaskStatus.RUNNING}:
            await emitter.error(
                f"Agent execution failed: {result.value}", "execution_error"
            )

    def _execution_request(
        self,
        payload: dict[str, Any],
        *,
        message: str,
        new_session: bool,
    ) -> ExecutionRequest:
        raw_request = payload.get("executionRequest")
        if not isinstance(raw_request, dict):
            raise ValueError("executionRequest is required")

        request_data = copy.deepcopy(raw_request)
        workspace_path = _required_workspace_path(payload)
        request_data["prompt"] = message
        request_data["workspace_source"] = "local_path"
        request_data["project_workspace_path"] = workspace_path
        request_data["new_session"] = new_session
        return ExecutionRequest.from_dict(request_data)

    def _followup_request(
        self,
        task: LocalTaskRecord,
        message: str,
        *,
        attachments: Optional[list[dict[str, Any]]] = None,
    ) -> ExecutionRequest:
        raw_request = task.runtime_handle.get("executionRequest")
        if not isinstance(raw_request, dict):
            raise ValueError("Runtime task is missing executionRequest")

        request_data = copy.deepcopy(raw_request)
        next_subtask_id = task.runtime_handle.get("nextSubtaskId")
        if not isinstance(next_subtask_id, int):
            next_subtask_id = int(request_data.get("subtask_id") or 0) + 1

        request_data["prompt"] = message
        request_data["subtask_id"] = next_subtask_id
        request_data["new_session"] = False
        request_data["workspace_source"] = "local_path"
        request_data["project_workspace_path"] = task.workspace_path
        request_data["attachments"] = attachments or []
        return ExecutionRequest.from_dict(request_data)

    def _mark_not_running(self, local_task_id: str) -> None:
        def update(task: LocalTaskRecord) -> LocalTaskRecord:
            return replace(task, running=False, updated_at=utc_now_iso())

        try:
            self.store.update_task(local_task_id, update)
        except KeyError:
            logger.warning(
                "Runtime task disappeared before completion: %s", local_task_id
            )


def _required_text(payload: dict[str, Any], key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{key} is required")
    return value.strip()


def _required_workspace_path(payload: dict[str, Any]) -> str:
    value = payload.get("workspacePath")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("workspacePath is required")
    return normalize_workspace_path(value)


def _user_message(
    local_task_id: str,
    content: str,
    subtask_id: int,
    attachments: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    message = {
        "id": f"{local_task_id}:user:{subtask_id}",
        "role": "user",
        "content": content,
        "createdAt": utc_now_iso(),
        "status": "done",
        "subtaskId": subtask_id,
    }
    if attachments:
        message["attachments"] = attachments
    return message


def _message_list(handle: dict[str, Any]) -> list[dict[str, Any]]:
    messages = handle.get("messages")
    if not isinstance(messages, list):
        return []
    return [message for message in messages if isinstance(message, dict)]


def _runtime_attachments(attachments: Any) -> list[dict[str, Any]]:
    if not isinstance(attachments, list):
        return []

    normalized = []
    for attachment in attachments:
        if not isinstance(attachment, dict):
            continue
        attachment_id = attachment.get("id")
        normalized.append(
            {
                "id": attachment_id,
                "filename": attachment.get("original_filename")
                or attachment.get("filename")
                or f"attachment-{attachment_id}",
                "file_size": attachment.get("file_size") or 0,
                "mime_type": attachment.get("mime_type") or "application/octet-stream",
                "status": "ready",
                "subtask_id": attachment.get("subtask_id") or 0,
                "file_extension": attachment.get("file_extension") or "",
                "created_at": utc_now_iso(),
            }
        )
    return normalized


def _payload_attachments(payload: dict[str, Any]) -> list[dict[str, Any]]:
    attachments = payload.get("attachments")
    if not isinstance(attachments, list):
        return []
    return [attachment for attachment in attachments if isinstance(attachment, dict)]


def _completed_content(data: dict[str, Any]) -> str:
    response = data.get("response")
    if not isinstance(response, dict):
        return ""
    output = response.get("output")
    if not isinstance(output, list):
        return ""
    parts: list[str] = []
    for item in output:
        if not isinstance(item, dict):
            continue
        content = item.get("content")
        if not isinstance(content, list):
            continue
        for content_item in content:
            if not isinstance(content_item, dict):
                continue
            text = content_item.get("text")
            if isinstance(text, str):
                parts.append(text)
    return "\n".join(parts).strip()


def _completed_file_changes(data: dict[str, Any]) -> Optional[dict[str, Any]]:
    response = data.get("response")
    if not isinstance(response, dict):
        return None
    file_changes = response.get("file_changes") or response.get("fileChanges")
    if isinstance(file_changes, dict):
        return file_changes
    return None


def _incomplete_content(data: dict[str, Any]) -> str:
    return _completed_content(data)


def _current_timestamp_ms() -> int:
    return int(time.time() * 1000)


def _reasoning_content(event_type: str, data: dict[str, Any]) -> str:
    if event_type == ResponsesAPIStreamEvents.REASONING_SUMMARY_TEXT_DELTA.value:
        value = data.get("delta")
        return value if isinstance(value, str) else ""
    part = data.get("part")
    if isinstance(part, dict) and part.get("type") == "reasoning":
        text = part.get("text")
        return text if isinstance(text, str) else ""
    return ""


def _tool_arguments(data: dict[str, Any], item: dict[str, Any]) -> dict[str, Any]:
    arguments_summary = data.get("arguments_summary")
    if isinstance(arguments_summary, dict):
        return arguments_summary

    arguments = item.get("arguments") or data.get("arguments")
    if isinstance(arguments, dict):
        return arguments
    if isinstance(arguments, str) and arguments:
        try:
            parsed = json.loads(arguments)
        except json.JSONDecodeError:
            return {}
        return parsed if isinstance(parsed, dict) else {}
    return {}
