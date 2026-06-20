# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime work RPC dispatcher for local executor mode."""

import inspect
import json
from collections import defaultdict
from typing import Any, Optional

from executor.runtime_work.agent_adapter import RuntimeAgentAdapter
from executor.runtime_work.codex_discovery import CodexSessionDiscovery
from executor.runtime_work.local_task_store import LocalTaskRecord, LocalTaskStore
from shared.logger import setup_logger

logger = setup_logger("runtime_work_rpc_handler")


class RuntimeWorkRpcHandler:
    """Handle backend runtime-work RPC calls on the local executor."""

    def __init__(
        self,
        store: Optional[LocalTaskStore] = None,
        adapters: Optional[dict[str, Any]] = None,
        codex_discovery: Optional[CodexSessionDiscovery] = None,
    ):
        self.store = store or LocalTaskStore()
        self.adapters = adapters or self._default_adapters()
        self.codex_discovery = codex_discovery or CodexSessionDiscovery()

    async def handle_runtime_rpc(self, data: dict[str, Any]) -> dict[str, Any]:
        method = data.get("method")
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}

        try:
            if method == "runtime.tasks.list":
                return self._list_tasks(payload)
            if method == "runtime.tasks.transcript":
                return await self._transcript(payload)
            if method == "runtime.tasks.send":
                return await self._send(payload)
            if method == "runtime.tasks.status":
                return self._status(payload)
            if method in {
                "runtime.tasks.create",
                "runtime.tasks.cancel",
                "runtime.tasks.fork_package",
            }:
                return await self._adapter_method(method, payload)
            return self._error(f"Unsupported runtime RPC method: {method}")
        except KeyError as exc:
            return self._error(str(exc), code="not_found")
        except ValueError as exc:
            return self._error(str(exc), code="bad_request")
        except Exception as exc:
            logger.exception("Runtime RPC failed: method=%s", method)
            return self._error(str(exc), code="internal_error")

    def _list_tasks(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._refresh_discovered_tasks()
        workspace_path = payload.get("workspacePath")
        include_archived = bool(payload.get("includeArchived", False))
        tasks = self.store.list_tasks(
            workspace_path=workspace_path,
            include_archived=include_archived,
        )

        grouped: dict[str, list[dict[str, Any]]] = defaultdict(list)
        for task in tasks:
            grouped[task.workspace_path].append(self._task_summary(task))

        return {
            "success": True,
            "workspaces": [
                {
                    "workspacePath": workspace_path,
                    "localTasks": workspace_tasks,
                }
                for workspace_path, workspace_tasks in sorted(grouped.items())
            ],
        }

    def _refresh_discovered_tasks(self) -> None:
        if self.codex_discovery is None:
            return
        try:
            records = self.codex_discovery.discover()
        except Exception:
            logger.exception("Failed to discover Codex runtime tasks")
            return

        for record in records:
            self.store.upsert_task(record)

    def _default_adapters(self) -> dict[str, RuntimeAgentAdapter]:
        return {
            "codex": RuntimeAgentAdapter(runtime="codex", store=self.store),
            "claude_code": RuntimeAgentAdapter(
                runtime="claude_code",
                store=self.store,
            ),
        }

    async def _transcript(self, payload: dict[str, Any]) -> dict[str, Any]:
        self._refresh_discovered_tasks()
        task = self._load_payload_task(payload)
        adapter = self.adapters.get(task.runtime)
        adapter_messages = None

        if adapter and hasattr(adapter, "get_transcript"):
            adapter_messages = await self._maybe_await(adapter.get_transcript(task))

        messages = adapter_messages
        if not messages:
            messages = self._codex_session_messages(task)
        if messages is None:
            messages = task.runtime_handle.get("messages", [])

        return {
            "success": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": task.runtime,
            "title": task.title,
            "messages": self._normalize_messages(task, messages),
        }

    def _codex_session_messages(
        self, task: LocalTaskRecord
    ) -> Optional[list[dict[str, Any]]]:
        if task.runtime != "codex" or self.codex_discovery is None:
            return None
        if not hasattr(self.codex_discovery, "read_transcript"):
            return None

        thread_id = task.runtime_handle.get("threadId") or task.local_task_id
        if not isinstance(thread_id, str) or not thread_id.strip():
            return None

        session_path = task.runtime_handle.get("sessionPath")
        if not isinstance(session_path, str):
            session_path = None
        return self.codex_discovery.read_transcript(thread_id, session_path)

    async def _send(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = self._load_payload_task(payload)
        content = payload.get("content") or payload.get("message")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("message is required")

        adapter = self.adapters.get(task.runtime)
        if not adapter or not hasattr(adapter, "send"):
            return self._error(
                "Runtime send adapter is not available",
                code="unsupported_runtime",
            )

        normalized_payload = dict(payload)
        normalized_payload["message"] = content
        result = await self._maybe_await(adapter.send(task, normalized_payload))
        if isinstance(result, dict):
            return {"success": True, **result}
        return {"success": True, "result": result}

    def _status(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = self._load_payload_task(payload)
        return {"success": True, "task": self._task_summary(task)}

    async def _adapter_method(
        self,
        method: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        runtime = payload.get("runtime")
        adapter = self.adapters.get(runtime) if isinstance(runtime, str) else None
        adapter_method_name = method.rsplit(".", maxsplit=1)[-1]

        if not adapter or not hasattr(adapter, adapter_method_name):
            return self._error(
                f"Runtime adapter does not support {method}",
                code="unsupported_runtime",
            )

        result = await self._maybe_await(getattr(adapter, adapter_method_name)(payload))
        if isinstance(result, dict):
            return {"success": True, **result}
        return {"success": True, "result": result}

    def _load_payload_task(self, payload: dict[str, Any]) -> LocalTaskRecord:
        local_task_id = payload.get("localTaskId")
        if not isinstance(local_task_id, str) or not local_task_id.strip():
            raise ValueError("localTaskId is required")

        workspace_path = payload.get("workspacePath")
        if workspace_path is not None and not isinstance(workspace_path, str):
            raise ValueError("workspacePath must be a string")

        return self.store.get_task(local_task_id, workspace_path=workspace_path)

    def _task_summary(self, task: LocalTaskRecord) -> dict[str, Any]:
        return {
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "title": task.title,
            "runtime": task.runtime,
            "createdAt": task.created_at,
            "updatedAt": task.updated_at,
            "running": task.running,
            "status": task.status,
            "parent": task.parent,
            "children": task.children,
        }

    def _normalize_messages(
        self,
        task: LocalTaskRecord,
        messages: Any,
    ) -> list[dict[str, Any]]:
        if not isinstance(messages, list):
            return []

        source_by_message_id = task.runtime_handle.get("sourceMetadataByMessageId", {})
        if not isinstance(source_by_message_id, dict):
            source_by_message_id = {}

        normalized = []
        for index, message in enumerate(messages):
            if not isinstance(message, dict):
                continue

            message_id = str(message.get("id") or f"{task.local_task_id}:{index}")
            normalized_message = {
                "id": message_id,
                "role": str(message.get("role") or "assistant"),
                "content": self._string_content(message.get("content")),
                "status": message.get("status"),
                "createdAt": message.get("createdAt") or message.get("created_at"),
            }
            attachments = message.get("attachments")
            if isinstance(attachments, list):
                normalized_message["attachments"] = [
                    attachment
                    for attachment in attachments
                    if isinstance(attachment, dict)
                ]

            source = message.get("source") or source_by_message_id.get(message_id)
            if isinstance(source, dict):
                normalized_message["source"] = source

            normalized.append(normalized_message)

        return normalized

    def _string_content(self, content: Any) -> str:
        if content is None:
            return ""
        if isinstance(content, str):
            return content
        return json.dumps(content, ensure_ascii=False)

    async def _maybe_await(self, value: Any) -> Any:
        if inspect.isawaitable(value):
            return await value
        return value

    def _error(self, message: str, code: str = "runtime_error") -> dict[str, Any]:
        return {"success": False, "error": message, "code": code}
