# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime task adapter that executes local code agents without DB task rows."""

import asyncio
import copy
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

    def __init__(self, store: LocalTaskStore, local_task_id: str):
        self.store = store
        self.local_task_id = local_task_id
        self._assistant_draft = ""

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
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            self._assistant_draft += str(data.get("delta") or "")
            return
        if event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DONE.value:
            self._assistant_draft = str(data.get("text") or self._assistant_draft)
            return
        if event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            self._append_assistant_message(
                content=_completed_content(data) or self._assistant_draft,
                status="done",
                subtask_id=subtask_id,
                executor_session=data.get("executor_session"),
            )
            self._assistant_draft = ""
            return
        if event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            self._append_assistant_message(
                content=_incomplete_content(data) or self._assistant_draft,
                status="cancelled",
                subtask_id=subtask_id,
            )
            self._assistant_draft = ""
            return
        if event_type == ResponsesAPIStreamEvents.ERROR.value:
            self._append_assistant_message(
                content=str(data.get("message") or "Runtime execution failed"),
                status="failed",
                subtask_id=subtask_id,
            )
            self._assistant_draft = ""

    def _append_assistant_message(
        self,
        *,
        content: str,
        status: str,
        subtask_id: int,
        executor_session: Optional[Any] = None,
    ) -> None:
        message = {
            "id": f"{self.local_task_id}:assistant:{subtask_id}",
            "role": "assistant",
            "content": content,
            "createdAt": utc_now_iso(),
            "status": status,
            "subtaskId": subtask_id,
        }

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
    ):
        self.runtime = runtime
        self.store = store
        self.execute_agent = execute_agent or self._execute_real_agent
        self.run_background = run_background
        self._running_tasks: set[asyncio.Task] = set()

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
        request = self._followup_request(task, message)
        user_message = _user_message(task.local_task_id, message, request.subtask_id)

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
        task.add_done_callback(self._running_tasks.discard)

    async def _run_agent(self, local_task_id: str, request: ExecutionRequest) -> None:
        transport = RuntimeTranscriptTransport(self.store, local_task_id)
        emitter = ResponsesAPIEmitter(
            task_id=request.task_id,
            subtask_id=request.subtask_id,
            transport=transport,
            model=str(request.model_config.get("model_id") or ""),
        )
        try:
            await self.execute_agent(request, emitter)
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


def _incomplete_content(data: dict[str, Any]) -> str:
    return _completed_content(data)
