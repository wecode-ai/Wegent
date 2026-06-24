# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Runtime work RPC dispatcher for local executor mode."""

import asyncio
import inspect
import json
import time
import uuid
from collections import defaultdict
from dataclasses import replace
from datetime import datetime, timezone
from typing import Any, Callable, Optional

from executor.config import config
from executor.runtime_work.agent_adapter import RuntimeAgentAdapter
from executor.runtime_work.codex_discovery import CodexSessionDiscovery
from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    LocalTaskStore,
    normalize_workspace_path,
    utc_now_iso,
)
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest
from shared.models.responses_api import ResponsesAPIStreamEvents
from shared.models.responses_api_emitter import EventTransport, ResponsesAPIEmitter

logger = setup_logger("runtime_work_rpc_handler")
CODEX_NATIVE_UPDATE_TERMINAL_STATUSES = {
    "done",
    "complete",
    "completed",
    "success",
    "succeeded",
    "failed",
    "error",
    "cancelled",
    "canceled",
}
RUNTIME_SEARCH_DEFAULT_LIMIT = 20
RUNTIME_SEARCH_MAX_LIMIT = 50
RUNTIME_SEARCH_SNIPPET_CONTEXT_CHARS = 60


class LocalTaskResponsesTransport(EventTransport):
    """Send local-task Responses API events over the existing local executor socket."""

    def __init__(
        self,
        emit_event: Callable[[str, dict[str, Any]], Any],
        task: LocalTaskRecord,
        source: Optional[dict[str, Any]] = None,
        record_event: Optional[Callable[[str, int, dict[str, Any]], None]] = None,
    ):
        self.emit_event = emit_event
        self.task = task
        self.source = source
        self.record_event = record_event

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
        payload: dict[str, Any] = {
            "event_type": event_type,
            "task_id": task_id,
            "subtask_id": subtask_id,
            "data": data,
            "local_task_id": self.task.local_task_id,
            "runtime": self.task.runtime,
        }
        if self.source is not None:
            payload["source"] = dict(self.source)
        if message_id is not None:
            payload["message_id"] = message_id
        if executor_name is not None:
            payload["executor_name"] = executor_name
        if executor_namespace is not None:
            payload["executor_namespace"] = executor_namespace

        if self.record_event is not None:
            self.record_event(event_type, subtask_id, data)

        result = self.emit_event(event_type, payload)
        if asyncio.iscoroutine(result):
            await result


class NoopResponsesTransport(EventTransport):
    """Drop local-task Responses API events when no socket emitter is available."""

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
        return None


class RuntimeWorkRpcHandler:
    """Handle backend runtime-work RPC calls on the local executor."""

    def __init__(
        self,
        store: Optional[LocalTaskStore] = None,
        adapters: Optional[dict[str, Any]] = None,
        codex_discovery: Optional[CodexSessionDiscovery] = None,
        responses_event_emitter: Optional[Callable[[str, dict[str, Any]], Any]] = None,
    ) -> None:
        self.store = store or LocalTaskStore()
        self.codex_discovery = codex_discovery or CodexSessionDiscovery()
        self.responses_event_emitter = responses_event_emitter
        self.adapters = adapters or self._default_adapters()
        self._running_sdk_tasks: set[asyncio.Task] = set()
        self._running_sdk_task_ids: set[str] = set()
        self._sdk_codex_task_records: dict[str, LocalTaskRecord] = {}
        self._codex_seen_updated_at: dict[str, str] = {}
        self._codex_updates_from_wegent: set[str] = set()
        self._codex_watcher_task: Optional[asyncio.Task] = None

    async def handle_runtime_rpc(self, data: dict[str, Any]) -> dict[str, Any]:
        method = data.get("method")
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}

        try:
            if method == "runtime.tasks.list":
                return self._list_tasks(payload)
            if method == "runtime.tasks.search":
                return await self._search(payload)
            if method == "runtime.tasks.transcript":
                return await self._transcript(payload)
            if method == "runtime.tasks.send":
                return await self._send(payload)
            if method == "runtime.tasks.archive":
                return await self._archive(payload)
            if method == "runtime.tasks.status":
                return self._status(payload)
            if method == "runtime.tasks.prepare_fork_transfer":
                return await self._prepare_fork_transfer(payload)
            if method == "runtime.tasks.prepare_fork_receiver":
                return await self._prepare_fork_receiver(payload)
            if method == "runtime.tasks.push_fork_transfer":
                return await self._push_fork_transfer(payload)
            if method == "runtime.tasks.upload_fork_transfer":
                return await self._upload_fork_transfer(payload)
            if method == "runtime.tasks.import_fork":
                return await self._import_fork(payload)
            if method in {
                "runtime.tasks.create",
                "runtime.tasks.cancel",
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
        discovered_tasks = self._refresh_discovered_tasks()
        workspace_path = payload.get("workspacePath")
        include_archived = bool(payload.get("includeArchived", False))
        store_tasks = self.store.list_tasks(
            workspace_path=workspace_path,
            include_archived=include_archived,
        )
        tasks = self._list_visible_tasks(
            store_tasks=store_tasks,
            discovered_tasks=discovered_tasks,
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

    async def _search(self, payload: dict[str, Any]) -> dict[str, Any]:
        query = str(payload.get("query") or "").strip()
        if not query:
            return {"success": True, "query": "", "items": []}

        limit = self._bounded_search_limit(payload.get("limit"))
        workspace_path = payload.get("workspacePath")
        include_archived = bool(payload.get("includeArchived", False))
        discovered_tasks = self._refresh_discovered_tasks()
        store_tasks = self.store.list_tasks(
            workspace_path=workspace_path,
            include_archived=include_archived,
        )
        tasks = self._list_visible_tasks(
            store_tasks=store_tasks,
            discovered_tasks=discovered_tasks,
            workspace_path=workspace_path,
            include_archived=include_archived,
        )

        items: list[dict[str, Any]] = []
        metadata_matched_task_ids: set[str] = set()
        for task in tasks:
            task_matches = self._search_task_metadata(task, query)
            if not task_matches:
                continue
            metadata_matched_task_ids.add(task.local_task_id)
            items.extend(task_matches)
            if len(items) >= limit:
                return {
                    "success": True,
                    "query": query,
                    "items": items[:limit],
                }

        for task in tasks:
            if task.local_task_id in metadata_matched_task_ids:
                continue
            messages = await self._task_transcript_messages(task)
            normalized_messages = self._normalize_messages(task, messages)
            task_matches = self._search_task_messages(task, normalized_messages, query)
            items.extend(task_matches)
            if len(items) >= limit:
                break

        return {
            "success": True,
            "query": query,
            "items": items[:limit],
        }

    def _bounded_search_limit(self, value: Any) -> int:
        if isinstance(value, bool):
            return RUNTIME_SEARCH_DEFAULT_LIMIT
        if isinstance(value, int):
            return max(1, min(value, RUNTIME_SEARCH_MAX_LIMIT))
        if isinstance(value, str) and value.isdigit():
            return max(1, min(int(value), RUNTIME_SEARCH_MAX_LIMIT))
        return RUNTIME_SEARCH_DEFAULT_LIMIT

    def _search_task_metadata(
        self,
        task: LocalTaskRecord,
        query: str,
    ) -> list[dict[str, Any]]:
        fields = [
            ("title", task.title, task.updated_at),
            ("workspace", task.workspace_path, task.updated_at),
        ]
        query_lower = query.lower()
        for role, content, created_at in fields:
            match_start = content.lower().find(query_lower)
            if match_start < 0:
                continue
            match_end = match_start + len(query)
            return [
                self._search_item(
                    task=task,
                    content=content,
                    match_start=match_start,
                    match_end=match_end,
                    message_id="",
                    message_role=role,
                    message_created_at=created_at,
                )
            ]
        return []

    def _search_task_messages(
        self,
        task: LocalTaskRecord,
        messages: list[dict[str, Any]],
        query: str,
    ) -> list[dict[str, Any]]:
        query_lower = query.lower()
        matches: list[dict[str, Any]] = []
        for message in messages:
            content = self._string_content(message.get("content"))
            match_start = content.lower().find(query_lower)
            if match_start < 0:
                continue
            match_end = match_start + len(query)
            matches.append(
                self._search_item(
                    task=task,
                    content=content,
                    match_start=match_start,
                    match_end=match_end,
                    message_id=str(message.get("id") or ""),
                    message_role=str(message.get("role") or ""),
                    message_created_at=message.get("createdAt"),
                )
            )
            break
        return matches

    def _search_item(
        self,
        *,
        task: LocalTaskRecord,
        content: str,
        match_start: int,
        match_end: int,
        message_id: str,
        message_role: str,
        message_created_at: Any,
    ) -> dict[str, Any]:
        return {
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": task.runtime,
            "title": task.title,
            "updatedAt": task.updated_at,
            "messageId": message_id,
            "messageRole": message_role,
            "messageCreatedAt": message_created_at,
            "snippet": self._search_snippet(content, match_start, match_end),
            "matchStart": match_start,
            "matchEnd": match_end,
        }

    def _search_snippet(self, content: str, match_start: int, match_end: int) -> str:
        if len(content) <= RUNTIME_SEARCH_SNIPPET_CONTEXT_CHARS * 2:
            return content
        start = max(0, match_start - RUNTIME_SEARCH_SNIPPET_CONTEXT_CHARS)
        end = min(len(content), match_end + RUNTIME_SEARCH_SNIPPET_CONTEXT_CHARS)
        prefix = "..." if start > 0 else ""
        suffix = "..." if end < len(content) else ""
        return f"{prefix}{content[start:end]}{suffix}"

    def _refresh_discovered_tasks(self) -> list[LocalTaskRecord]:
        if self.codex_discovery is None:
            return []
        try:
            return self.codex_discovery.discover()
        except Exception:
            logger.exception("Failed to discover Codex runtime tasks")
            return []

    async def poll_codex_updates_once(self) -> None:
        """Detect native Codex thread updates and report them to Backend."""

        if self.responses_event_emitter is None:
            return

        for record in self._refresh_discovered_tasks():
            if not self._is_codex_runtime(record.runtime):
                continue

            previous = self._codex_seen_updated_at.get(record.local_task_id)
            if previous is None:
                self._codex_seen_updated_at[record.local_task_id] = record.updated_at
                continue
            if self._parse_task_time(record.updated_at) <= self._parse_task_time(
                previous
            ):
                continue
            if record.local_task_id in self._codex_updates_from_wegent:
                self._codex_updates_from_wegent.discard(record.local_task_id)
                self._codex_seen_updated_at[record.local_task_id] = record.updated_at
                continue

            if await self._emit_codex_native_update(record):
                self._codex_seen_updated_at[record.local_task_id] = record.updated_at

    def mark_codex_task_updated_by_wegent(
        self,
        local_task_id: str,
        source: Optional[dict[str, Any]] = None,
    ) -> None:
        """Suppress the next watcher notification only for IM-originated turns."""

        if local_task_id and self._is_im_source(source):
            self._codex_updates_from_wegent.add(local_task_id)

    async def _emit_codex_native_update(self, record: LocalTaskRecord) -> bool:
        if self.responses_event_emitter is None:
            return False
        message = self._last_codex_assistant_message(record)
        if message is None:
            return False

        status = str(message.get("status") or "").strip()
        content = self._string_content(message.get("content")).strip()
        if not self._is_codex_native_terminal_status(status) or not content:
            return False

        payload = {
            "localTaskId": record.local_task_id,
            "runtime": record.runtime,
            "title": record.title,
            "updatedAt": record.updated_at,
            "status": status,
            "content": content,
        }
        result = self.responses_event_emitter("runtime.tasks.updated", payload)
        if asyncio.iscoroutine(result):
            await result
        return True

    def _last_codex_assistant_message(
        self,
        record: LocalTaskRecord,
    ) -> Optional[dict[str, Any]]:
        messages = self._codex_session_messages(record)
        if messages is None:
            messages = record.runtime_handle.get("messages", [])
        if not isinstance(messages, list):
            return None
        for message in reversed(messages):
            if not isinstance(message, dict):
                continue
            role = str(message.get("role") or "").lower()
            if not role:
                continue
            if role == "assistant":
                return message
            return None
        return None

    def _is_codex_native_terminal_status(self, status: str) -> bool:
        normalized = status.strip().replace("_", "").replace("-", "").lower()
        return normalized in CODEX_NATIVE_UPDATE_TERMINAL_STATUSES

    def _is_im_source(self, source: Optional[dict[str, Any]]) -> bool:
        return isinstance(source, dict) and source.get("source") == "im"

    async def start_codex_watcher(self, interval_seconds: Optional[int] = None) -> None:
        """Start the native Codex update watcher."""

        interval = (
            config.RUNTIME_CODEX_WATCH_INTERVAL
            if interval_seconds is None
            else interval_seconds
        )
        if interval <= 0 or self.codex_discovery is None:
            return
        if self._codex_watcher_task and not self._codex_watcher_task.done():
            return

        await self.poll_codex_updates_once()
        self._codex_watcher_task = asyncio.create_task(
            self._codex_watcher_loop(interval)
        )

    async def stop_codex_watcher(self) -> None:
        """Stop the native Codex update watcher."""

        task = self._codex_watcher_task
        self._codex_watcher_task = None
        if task is None or task.done():
            return
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass

    async def _codex_watcher_loop(self, interval_seconds: int) -> None:
        while True:
            await asyncio.sleep(interval_seconds)
            try:
                await self.poll_codex_updates_once()
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Codex native update watcher failed")

    def _list_visible_tasks(
        self,
        *,
        store_tasks: list[LocalTaskRecord],
        discovered_tasks: list[LocalTaskRecord],
        workspace_path: Any,
        include_archived: bool,
    ) -> list[LocalTaskRecord]:
        visible_tasks: list[LocalTaskRecord] = []
        for task in store_tasks:
            if not self._is_codex_runtime(task.runtime):
                visible_tasks.append(task)
        discovered_ids = {task.local_task_id for task in discovered_tasks}
        active_memory_thread_ids = {
            thread_id
            for task in self._sdk_codex_task_records.values()
            for thread_id in [self._sdk_codex_thread_id(task)]
            if thread_id
        }
        visible_tasks.extend(
            task
            for task in self._sdk_codex_task_records.values()
            if task.local_task_id not in discovered_ids
            and self._include_discovered_task(
                task,
                workspace_path=workspace_path,
                include_archived=include_archived,
            )
        )
        visible_tasks.extend(
            task
            for task in discovered_tasks
            if task.local_task_id not in active_memory_thread_ids
            if self._include_discovered_task(
                task,
                workspace_path=workspace_path,
                include_archived=include_archived,
            )
        )
        return sorted(
            visible_tasks,
            key=lambda task: (
                self._parse_task_time(task.updated_at),
                self._parse_task_time(task.created_at),
            ),
            reverse=True,
        )

    def _include_discovered_task(
        self,
        task: LocalTaskRecord,
        *,
        workspace_path: Any,
        include_archived: bool,
    ) -> bool:
        if not include_archived and task.status == "archived":
            return False
        if workspace_path is None:
            return True
        return task.workspace_path == normalize_workspace_path(workspace_path)

    def _parse_task_time(self, value: str) -> datetime:
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return datetime.min.replace(tzinfo=timezone.utc)
        if parsed.tzinfo is None:
            return parsed.replace(tzinfo=timezone.utc)
        return parsed

    def _default_adapters(self) -> dict[str, RuntimeAgentAdapter]:
        return {
            "claude_code": RuntimeAgentAdapter(
                runtime="claude_code",
                store=self.store,
                responses_event_emitter=self.responses_event_emitter,
            ),
        }

    async def _transcript(self, payload: dict[str, Any]) -> dict[str, Any]:
        discovered_tasks = self._refresh_discovered_tasks()
        task = self._load_payload_task(payload, discovered_tasks=discovered_tasks)
        messages = await self._task_transcript_messages(task)

        return {
            "success": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": task.runtime,
            "title": task.title,
            "messages": self._normalize_messages(task, messages),
        }

    async def _task_transcript_messages(
        self,
        task: LocalTaskRecord,
    ) -> list[dict[str, Any]]:
        if self._is_sdk_codex_task(task):
            codex_messages = self._codex_session_messages(task)
            if codex_messages:
                return codex_messages
            if self._has_explicit_codex_thread(task):
                messages = task.runtime_handle.get("messages", [])
                return messages if isinstance(messages, list) else []

        adapter = self.adapters.get(task.runtime)
        if adapter and hasattr(adapter, "get_transcript"):
            adapter_messages = await self._maybe_await(adapter.get_transcript(task))
            if adapter_messages:
                return adapter_messages

        codex_messages = self._codex_session_messages(task)
        if codex_messages:
            return codex_messages

        messages = task.runtime_handle.get("messages", [])
        return messages if isinstance(messages, list) else []

    def _codex_session_messages(
        self, task: LocalTaskRecord
    ) -> Optional[list[dict[str, Any]]]:
        if not self._is_codex_runtime(task.runtime) or self.codex_discovery is None:
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
        if task.running and not self._is_sdk_codex_task(task):
            raise ValueError("runtime task is already running")
        content = payload.get("content") or payload.get("message")
        if not isinstance(content, str) or not content.strip():
            raise ValueError("message is required")

        source = (
            payload.get("source") if isinstance(payload.get("source"), dict) else None
        )
        if self._is_sdk_codex_task(task):
            return await self._send_sdk_codex_task(task, content.strip(), source)

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

    async def _send_sdk_codex_task(
        self,
        task: LocalTaskRecord,
        message: str,
        source: Optional[dict[str, Any]],
    ) -> dict[str, Any]:
        stream_message = getattr(self.codex_discovery, "stream_message", None)
        if not callable(stream_message):
            return self._error(
                "Codex SDK stream adapter is not available",
                code="unsupported_runtime",
            )
        if self.responses_event_emitter is None:
            return self._error(
                "Responses API event emitter is not available",
                code="unsupported_runtime",
            )

        thread_id = task.runtime_handle.get("threadId") or task.local_task_id
        if not isinstance(thread_id, str) or not thread_id.strip():
            raise ValueError("Codex threadId is required")
        if task.local_task_id in self._running_sdk_task_ids:
            raise ValueError("runtime task is already running")

        subtask_id = self._next_sdk_codex_subtask_id(task)
        task = self._mark_task_running(task, subtask_id)
        self._remember_sdk_codex_task(task)
        self._running_sdk_task_ids.add(task.local_task_id)
        sdk_task = asyncio.create_task(
            self._run_sdk_codex_task(
                task=task,
                thread_id=thread_id,
                message=message,
                stream_message=stream_message,
                source=source,
                subtask_id=subtask_id,
            )
        )
        self._running_sdk_tasks.add(sdk_task)
        sdk_task.add_done_callback(self._running_sdk_tasks.discard)
        return {
            "success": True,
            "accepted": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": "codex",
        }

    def _mark_task_running(
        self,
        task: LocalTaskRecord,
        subtask_id: int,
    ) -> LocalTaskRecord:
        if task.running:
            raise ValueError("runtime task is already running")
        return replace(
            task,
            running=True,
            runtime_handle={
                **task.runtime_handle,
                "activeSubtaskId": subtask_id,
            },
            updated_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        )

    async def _run_sdk_codex_task(
        self,
        *,
        task: LocalTaskRecord,
        thread_id: str,
        message: str,
        stream_message: Any,
        source: Optional[dict[str, Any]],
        subtask_id: int,
    ) -> None:
        emitter = self._create_local_task_emitter(task, source, subtask_id)
        try:
            await stream_message(
                thread_id,
                message,
                cwd=task.workspace_path,
                emitter=emitter,
            )
        except Exception as exc:
            logger.exception("Failed to continue Codex SDK thread: %s", thread_id)
            try:
                await emitter.error(str(exc), "execution_error")
            except Exception:
                logger.exception("Failed to emit Codex SDK stream error")
        finally:
            self.mark_codex_task_updated_by_wegent(task.local_task_id, source)
            self._running_sdk_task_ids.discard(task.local_task_id)
            self._mark_sdk_codex_task_not_running(task.local_task_id)

    def _create_local_task_emitter(
        self,
        task: LocalTaskRecord,
        source: Optional[dict[str, Any]],
        subtask_id: int,
    ) -> ResponsesAPIEmitter:
        if self.responses_event_emitter is None:
            transport: EventTransport = NoopResponsesTransport()
        else:
            transport = LocalTaskResponsesTransport(
                emit_event=self.responses_event_emitter,
                task=task,
                source=source,
                record_event=lambda event_type, subtask_id, data: (
                    self._record_sdk_codex_response_event(
                        task.local_task_id,
                        event_type,
                        subtask_id,
                        data,
                    )
                ),
            )
        return ResponsesAPIEmitter(
            task_id=0,
            subtask_id=subtask_id,
            transport=transport,
            model="codex",
        )

    def _next_sdk_codex_subtask_id(self, task: LocalTaskRecord) -> int:
        current = task.runtime_handle.get("activeSubtaskId")
        if isinstance(current, int) and current > 0:
            return current + 1
        return int(time.time() * 1000)

    def _is_sdk_codex_task(self, task: LocalTaskRecord) -> bool:
        if not self._is_codex_runtime(task.runtime):
            return False
        if task.runtime_handle.get("pendingNativeCodexThread") is True:
            return True
        if isinstance(task.runtime_handle.get("executionRequest"), dict):
            return False
        thread_id = task.runtime_handle.get("threadId")
        return isinstance(thread_id, str) and bool(thread_id.strip())

    def _is_codex_runtime(self, runtime: str) -> bool:
        return runtime.lower() == "codex"

    def _has_explicit_codex_thread(self, task: LocalTaskRecord) -> bool:
        thread_id = task.runtime_handle.get("threadId")
        return isinstance(thread_id, str) and bool(thread_id.strip())

    async def _archive(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = self._load_payload_task(payload)

        if self._is_codex_runtime(task.runtime) and self.codex_discovery is not None:
            thread_id = task.runtime_handle.get("threadId") or task.local_task_id
            archive_thread = getattr(self.codex_discovery, "archive_thread", None)
            if isinstance(thread_id, str) and thread_id.strip() and archive_thread:
                await self._maybe_await(archive_thread(thread_id))

        if self._is_sdk_codex_task(task):
            self._sdk_codex_task_records.pop(task.local_task_id, None)
            return {
                "success": True,
                "accepted": True,
                "localTaskId": task.local_task_id,
                "workspacePath": task.workspace_path,
            }

        archived = self.store.update_task(
            task.local_task_id,
            lambda current: replace(current, running=False, status="archived"),
            workspace_path=task.workspace_path,
        )
        return {
            "success": True,
            "accepted": True,
            "localTaskId": archived.local_task_id,
            "workspacePath": archived.workspace_path,
        }

    def _status(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = self._load_payload_task(payload)
        return {"success": True, "task": self._task_summary(task)}

    async def _prepare_fork_transfer(self, payload: dict[str, Any]) -> dict[str, Any]:
        task = self._load_payload_task(payload)
        transfer_id = payload.get("transferId")
        if not isinstance(transfer_id, str) or not transfer_id.strip():
            raise ValueError("transferId is required")
        upload_url = payload.get("uploadUrl")
        if upload_url is not None and not isinstance(upload_url, str):
            raise ValueError("uploadUrl must be a string")
        workspace_transfer = payload.get("workspaceTransfer")
        if workspace_transfer is not None and not isinstance(workspace_transfer, str):
            raise ValueError("workspaceTransfer must be a string")
        direct_hosts = self._payload_string_list(payload.get("directHosts"))

        messages = await self._fork_package_messages(task)
        if workspace_transfer == "git_workspace":
            from executor.runtime_work.fork_transfer import prepare_archive_transfer

            session_paths = self._session_paths_for_archive(task)
            codex_thread_id = self._codex_thread_id(task)
            prepared = await prepare_archive_transfer(
                workspace_path=task.workspace_path,
                transfer_id=transfer_id,
                upload_url=upload_url,
                session_paths=session_paths,
                direct_hosts=direct_hosts,
                include_workspace=True,
                codex_thread_id=codex_thread_id,
            )
            archive = {
                "mode": workspace_transfer,
                "transferId": transfer_id,
                "directUrls": prepared.direct_urls,
                "directToken": prepared.direct_token,
                "sizeBytes": prepared.size_bytes,
                "requiresWorkspaceRestore": True,
            }
            if session_paths or codex_thread_id:
                archive["requiresSessionRestore"] = True
            return {
                "success": True,
                "package": {
                    "sourceRuntime": task.runtime,
                    "title": task.title,
                    "recentMessages": messages,
                    "runtimeHandle": task.runtime_handle,
                    "executorSession": self._executor_session_metadata(task),
                    "archive": archive,
                },
            }

        from executor.runtime_work.fork_transfer import prepare_archive_transfer

        prepared = await prepare_archive_transfer(
            workspace_path=task.workspace_path,
            transfer_id=transfer_id,
            upload_url=upload_url,
            session_paths=self._session_paths_for_archive(task),
            direct_hosts=direct_hosts,
            codex_thread_id=self._codex_thread_id(task),
        )
        return {
            "success": True,
            "package": {
                "sourceRuntime": task.runtime,
                "title": task.title,
                "recentMessages": messages,
                "runtimeHandle": task.runtime_handle,
                "executorSession": self._executor_session_metadata(task),
                "archive": {
                    "transferId": transfer_id,
                    "directUrls": prepared.direct_urls,
                    "directToken": prepared.direct_token,
                    "sizeBytes": prepared.size_bytes,
                },
            },
        }

    async def _fork_package_messages(
        self,
        task: LocalTaskRecord,
    ) -> list[dict[str, Any]]:
        messages = await self._task_transcript_messages(task)
        return self._normalize_messages(task, messages)

    async def _prepare_fork_receiver(self, payload: dict[str, Any]) -> dict[str, Any]:
        transfer_id = payload.get("transferId")
        if not isinstance(transfer_id, str) or not transfer_id.strip():
            raise ValueError("transferId is required")
        token = payload.get("token")
        if not isinstance(token, str) or not token.strip():
            raise ValueError("token is required")
        direct_hosts = self._payload_string_list(payload.get("directHosts"))

        from executor.runtime_work.fork_transfer import register_direct_upload_receiver

        upload_urls = register_direct_upload_receiver(
            transfer_id,
            token,
            direct_hosts=direct_hosts,
        )
        return {
            "success": True,
            "accepted": True,
            "transferId": transfer_id,
            "uploadUrls": upload_urls,
        }

    async def _push_fork_transfer(self, payload: dict[str, Any]) -> dict[str, Any]:
        transfer_id = payload.get("transferId")
        if not isinstance(transfer_id, str) or not transfer_id.strip():
            raise ValueError("transferId is required")
        upload_urls = payload.get("uploadUrls")
        if not isinstance(upload_urls, list):
            raise ValueError("uploadUrls is required")
        upload_token = payload.get("uploadToken")
        if upload_token is not None and not isinstance(upload_token, str):
            raise ValueError("uploadToken must be a string")

        from executor.runtime_work.fork_transfer import (
            upload_registered_archive_to_first_available_url,
        )

        uploaded_url, size_bytes = (
            await upload_registered_archive_to_first_available_url(
                transfer_id=transfer_id,
                upload_urls=[
                    url for url in upload_urls if isinstance(url, str) and url.strip()
                ],
                upload_token=upload_token,
            )
        )
        return {
            "success": True,
            "accepted": True,
            "transferId": transfer_id,
            "uploadedUrl": uploaded_url,
            "sizeBytes": size_bytes,
        }

    async def _upload_fork_transfer(self, payload: dict[str, Any]) -> dict[str, Any]:
        transfer_id = payload.get("transferId")
        if not isinstance(transfer_id, str) or not transfer_id.strip():
            raise ValueError("transferId is required")
        upload_url = payload.get("uploadUrl")
        if not isinstance(upload_url, str) or not upload_url.strip():
            raise ValueError("uploadUrl is required")

        from executor.runtime_work.fork_transfer import upload_registered_archive

        size_bytes = await upload_registered_archive(
            transfer_id=transfer_id,
            upload_url=upload_url,
        )
        return {
            "success": True,
            "accepted": True,
            "transferId": transfer_id,
            "sizeBytes": size_bytes,
        }

    async def _import_fork(self, payload: dict[str, Any]) -> dict[str, Any]:
        fork_package = payload.get("forkPackage")
        if not isinstance(fork_package, dict):
            raise ValueError("forkPackage is required")
        source = payload.get("source")
        if not isinstance(source, dict):
            raise ValueError("source is required")
        workspace_path = payload.get("workspacePath")
        if not isinstance(workspace_path, str) or not workspace_path.strip():
            raise ValueError("workspacePath is required")

        archive = fork_package.get("archive")
        if not isinstance(archive, dict):
            raise ValueError("forkPackage.archive is required")

        normalized_workspace_path = normalize_workspace_path(workspace_path)
        if _requires_fork_archive_restore(archive):
            from executor.runtime_work.fork_transfer import restore_fork_package_archive

            await restore_fork_package_archive(
                archive=archive,
                workspace_path=normalized_workspace_path,
            )
        local_task_id = str(payload.get("localTaskId") or f"runtime-{uuid.uuid4()}")
        runtime = str(fork_package.get("sourceRuntime") or "codex")
        if self._is_codex_runtime(runtime):
            raise ValueError(
                "Codex fork imports must restore into native Codex, not runtime index"
            )
        runtime_handle = self._imported_runtime_handle(fork_package)
        messages = fork_package.get("recentMessages")
        if isinstance(messages, list):
            runtime_handle["messages"] = [
                message for message in messages if isinstance(message, dict)
            ]
        task = LocalTaskRecord(
            local_task_id=local_task_id,
            workspace_path=normalized_workspace_path,
            title=str(fork_package.get("title") or "Forked task"),
            runtime=runtime,
            runtime_handle=runtime_handle,
            parent=source,
            created_at=utc_now_iso(),
            updated_at=utc_now_iso(),
            running=False,
            status="active",
        )
        self.store.upsert_task(task)
        return {
            "success": True,
            "accepted": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": task.runtime,
        }

    def _imported_runtime_handle(self, fork_package: dict[str, Any]) -> dict[str, Any]:
        raw_handle = fork_package.get("runtimeHandle")
        runtime_handle = dict(raw_handle) if isinstance(raw_handle, dict) else {}
        executor_session = fork_package.get("executorSession")
        if isinstance(executor_session, dict):
            runtime_handle["executorSession"] = executor_session
            execution_request = runtime_handle.get("executionRequest")
            if isinstance(execution_request, dict):
                sessions = execution_request.get("inherited_sessions")
                if not isinstance(sessions, list):
                    sessions = []
                execution_request["inherited_sessions"] = [
                    *sessions,
                    executor_session,
                ]
                execution_request["new_session"] = False
        return runtime_handle

    def _executor_session_metadata(
        self,
        task: LocalTaskRecord,
    ) -> Optional[dict[str, Any]]:
        handle_session = task.runtime_handle.get("executorSession")
        if isinstance(handle_session, dict):
            return handle_session
        if self._is_codex_runtime(task.runtime):
            thread_id = task.runtime_handle.get("threadId") or task.local_task_id
            if isinstance(thread_id, str) and thread_id.strip():
                return {"agent": "CodeX", "threadId": thread_id}
        return None

    def _session_paths_for_archive(self, task: LocalTaskRecord) -> list[str]:
        session_path = task.runtime_handle.get("sessionPath")
        if isinstance(session_path, str) and session_path.strip():
            return [session_path]
        return []

    def _codex_thread_id(self, task: LocalTaskRecord) -> Optional[str]:
        if not self._is_codex_runtime(task.runtime):
            return None
        thread_id = task.runtime_handle.get("threadId") or task.local_task_id
        if isinstance(thread_id, str) and thread_id.strip():
            return thread_id.strip()
        return None

    def _payload_string_list(self, value: Any) -> Optional[list[str]]:
        if value is None:
            return None
        if not isinstance(value, list):
            raise ValueError("directHosts must be a list")
        return [
            item.strip() for item in value if isinstance(item, str) and item.strip()
        ]

    async def _adapter_method(
        self,
        method: str,
        payload: dict[str, Any],
    ) -> dict[str, Any]:
        runtime = payload.get("runtime")
        if isinstance(runtime, str) and self._is_codex_runtime(runtime):
            if method == "runtime.tasks.create":
                return await self._create_sdk_codex_task(payload)
            return self._error(
                "Codex runtime tasks are discovered from native Codex only",
                code="unsupported_runtime",
            )
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

    async def _create_sdk_codex_task(self, payload: dict[str, Any]) -> dict[str, Any]:
        stream_new_thread = getattr(self.codex_discovery, "stream_new_thread", None)
        if not callable(stream_new_thread):
            return self._error(
                "Codex SDK create adapter is not available",
                code="unsupported_runtime",
            )

        request = self._sdk_codex_create_request(payload)
        workspace_path = normalize_workspace_path(str(payload.get("workspacePath")))
        message = str(payload.get("message") or "").strip()
        title = str(payload.get("title") or message).strip()[:100] or "New task"
        task = self._sdk_codex_create_record(
            local_task_id=str(payload.get("localTaskId") or f"codex-{uuid.uuid4()}"),
            workspace_path=workspace_path,
            title=title,
            message=message,
            subtask_id=request.subtask_id,
        )
        self._remember_sdk_codex_task(task)
        self._running_sdk_task_ids.add(task.local_task_id)
        sdk_task = asyncio.create_task(
            self._run_sdk_codex_create_task(
                stream_new_thread=stream_new_thread,
                request=request,
                message=message,
                task=task,
            )
        )
        self._running_sdk_tasks.add(sdk_task)
        sdk_task.add_done_callback(self._running_sdk_tasks.discard)

        return {
            "success": True,
            "accepted": True,
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "runtime": "codex",
        }

    async def _run_sdk_codex_create_task(
        self,
        *,
        stream_new_thread: Callable[..., Any],
        request: ExecutionRequest,
        message: str,
        task: LocalTaskRecord,
    ) -> None:
        def emitter_factory(thread_id: str) -> ResponsesAPIEmitter:
            attached_task = self._attach_sdk_codex_thread(
                local_task_id=task.local_task_id,
                thread_id=thread_id,
            )
            return self._create_local_task_emitter(
                attached_task,
                source=None,
                subtask_id=request.subtask_id,
            )

        try:
            await self._maybe_await(
                stream_new_thread(
                    request,
                    message,
                    cwd=task.workspace_path,
                    emitter_factory=emitter_factory,
                )
            )
        except Exception as exc:
            logger.exception("Failed to create Codex SDK thread")
            emitter = self._create_local_task_emitter(
                task,
                source=None,
                subtask_id=request.subtask_id,
            )
            try:
                await emitter.error(str(exc), "execution_error")
            except Exception:
                logger.exception("Failed to emit Codex SDK create error")
        finally:
            self.mark_codex_task_updated_by_wegent(
                task.local_task_id,
                source=None,
            )
            self._running_sdk_task_ids.discard(task.local_task_id)
            self._mark_sdk_codex_task_not_running(task.local_task_id)

    def _sdk_codex_create_request(self, payload: dict[str, Any]) -> ExecutionRequest:
        workspace_path = payload.get("workspacePath")
        if not isinstance(workspace_path, str) or not workspace_path.strip():
            raise ValueError("workspacePath is required")
        message = payload.get("message")
        if not isinstance(message, str) or not message.strip():
            raise ValueError("message is required")
        raw_request = payload.get("executionRequest")
        if not isinstance(raw_request, dict):
            raise ValueError("executionRequest is required")

        request_data = dict(raw_request)
        request_data["prompt"] = message.strip()
        request_data["workspace_source"] = "local_path"
        request_data["project_workspace_path"] = normalize_workspace_path(
            workspace_path
        )
        request_data["new_session"] = True
        return ExecutionRequest.from_dict(request_data)

    def _sdk_codex_create_record(
        self,
        *,
        local_task_id: str,
        workspace_path: str,
        title: str,
        message: str,
        subtask_id: int,
    ) -> LocalTaskRecord:
        local_task_id = local_task_id.strip()
        if not local_task_id:
            raise ValueError("localTaskId is required")
        now = utc_now_iso()
        return LocalTaskRecord(
            local_task_id=local_task_id,
            workspace_path=workspace_path,
            title=title,
            runtime="codex",
            runtime_handle={
                "pendingNativeCodexThread": True,
                "activeSubtaskId": subtask_id,
                "messages": [
                    {
                        "id": f"{local_task_id}:user:{subtask_id}",
                        "role": "user",
                        "content": message,
                        "createdAt": now,
                        "status": "done",
                        "subtaskId": subtask_id,
                    }
                ],
            },
            created_at=now,
            updated_at=now,
            running=True,
            status="active",
        )

    def _attach_sdk_codex_thread(
        self,
        *,
        local_task_id: str,
        thread_id: str,
    ) -> LocalTaskRecord:
        thread_id = thread_id.strip()
        if not thread_id:
            raise ValueError("Codex threadId is required")
        task = self._sdk_codex_task_records[local_task_id]
        handle = dict(task.runtime_handle)
        handle.pop("pendingNativeCodexThread", None)
        handle["threadId"] = thread_id
        updated = replace(
            task,
            runtime_handle=handle,
            updated_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        )
        self._remember_sdk_codex_task(updated)
        return updated

    def _load_payload_task(
        self,
        payload: dict[str, Any],
        *,
        discovered_tasks: Optional[list[LocalTaskRecord]] = None,
    ) -> LocalTaskRecord:
        local_task_id = payload.get("localTaskId")
        if not isinstance(local_task_id, str) or not local_task_id.strip():
            raise ValueError("localTaskId is required")

        workspace_path = payload.get("workspacePath")
        if workspace_path is not None and not isinstance(workspace_path, str):
            raise ValueError("workspacePath must be a string")

        try:
            task = self.store.get_task(local_task_id, workspace_path=workspace_path)
            if not self._is_codex_runtime(task.runtime):
                return task
        except KeyError:
            pass

        sdk_task = self._find_sdk_codex_task(
            local_task_id,
            workspace_path=workspace_path,
        )
        if sdk_task is not None:
            return sdk_task

        discovered_task = self._find_discovered_task(
            local_task_id,
            workspace_path=workspace_path,
            discovered_tasks=discovered_tasks,
        )
        if discovered_task is not None:
            return discovered_task

        raise KeyError(f"Local task not found: {local_task_id}")

    def _remember_sdk_codex_task(self, task: LocalTaskRecord) -> None:
        if self._is_sdk_codex_task(task):
            self._sdk_codex_task_records[task.local_task_id] = task

    def _mark_sdk_codex_task_not_running(self, local_task_id: str) -> None:
        task = self._sdk_codex_task_records.get(local_task_id)
        if task is None:
            return
        self._sdk_codex_task_records[local_task_id] = replace(
            task,
            running=False,
            updated_at=datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
        )

    def _record_sdk_codex_response_event(
        self,
        local_task_id: str,
        event_type: str,
        subtask_id: int,
        data: dict[str, Any],
    ) -> None:
        task = self._sdk_codex_task_records.get(local_task_id)
        if task is None:
            return

        handle = dict(task.runtime_handle)
        messages = [
            dict(message)
            for message in handle.get("messages", [])
            if isinstance(message, dict)
        ]

        def assistant_message() -> dict[str, Any]:
            message_id = f"{local_task_id}:assistant:{subtask_id}"
            for message in messages:
                if str(message.get("id")) == message_id:
                    return message
            message = {
                "id": message_id,
                "role": "assistant",
                "content": "",
                "createdAt": utc_now_iso(),
                "status": "streaming",
                "subtaskId": subtask_id,
            }
            messages.append(message)
            return message

        if event_type == ResponsesAPIStreamEvents.RESPONSE_CREATED.value:
            assistant_message()["status"] = "streaming"
        elif event_type == ResponsesAPIStreamEvents.OUTPUT_TEXT_DELTA.value:
            message = assistant_message()
            message["content"] = self._string_content(message.get("content")) + str(
                data.get("delta") or ""
            )
            message["status"] = "streaming"
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_COMPLETED.value:
            message = assistant_message()
            completed_text = self._response_completed_text(data)
            if completed_text:
                message["content"] = completed_text
            message["status"] = "done"
        elif event_type == ResponsesAPIStreamEvents.ERROR.value:
            message = assistant_message()
            message["status"] = "failed"
            message["error"] = str(data.get("message") or "Unknown error")
        elif event_type == ResponsesAPIStreamEvents.RESPONSE_INCOMPLETE.value:
            assistant_message()["status"] = "cancelled"
        else:
            return

        handle["messages"] = messages
        handle["activeSubtaskId"] = subtask_id
        self._sdk_codex_task_records[local_task_id] = replace(
            task,
            runtime_handle=handle,
            updated_at=utc_now_iso(),
        )

    def _response_completed_text(self, data: dict[str, Any]) -> str:
        response = data.get("response")
        if not isinstance(response, dict):
            return ""
        chunks = []
        for item in response.get("output", []):
            if not isinstance(item, dict):
                continue
            for content in item.get("content", []):
                if not isinstance(content, dict):
                    continue
                if content.get("type") not in (None, "output_text", "text"):
                    continue
                text = content.get("text")
                if isinstance(text, str):
                    chunks.append(text)
        return "".join(chunks)

    def _find_sdk_codex_task(
        self,
        local_task_id: str,
        *,
        workspace_path: Optional[str],
    ) -> Optional[LocalTaskRecord]:
        task = self._sdk_codex_task_records.get(local_task_id)
        if task is None:
            return None
        if workspace_path and task.workspace_path != normalize_workspace_path(
            workspace_path
        ):
            return None
        return task

    def _sdk_codex_thread_id(self, task: LocalTaskRecord) -> Optional[str]:
        thread_id = task.runtime_handle.get("threadId")
        if isinstance(thread_id, str) and thread_id.strip():
            return thread_id.strip()
        return None

    def _find_discovered_task(
        self,
        local_task_id: str,
        *,
        workspace_path: Optional[str],
        discovered_tasks: Optional[list[LocalTaskRecord]] = None,
    ) -> Optional[LocalTaskRecord]:
        records = (
            discovered_tasks
            if discovered_tasks is not None
            else self._refresh_discovered_tasks()
        )
        normalized_workspace = (
            normalize_workspace_path(workspace_path) if workspace_path else None
        )
        for task in records:
            if task.local_task_id != local_task_id:
                continue
            if normalized_workspace and task.workspace_path != normalized_workspace:
                continue
            return task
        return None

    def _task_summary(self, task: LocalTaskRecord) -> dict[str, Any]:
        summary = {
            "localTaskId": task.local_task_id,
            "workspacePath": task.workspace_path,
            "title": task.title,
            "runtime": task.runtime,
            "workspaceKind": task.workspace_kind,
            "worktreeId": task.worktree_id,
            "createdAt": task.created_at,
            "updatedAt": task.updated_at,
            "running": task.running,
            "status": task.status,
            "parent": task.parent,
            "children": task.children,
        }
        git_info = task.runtime_handle.get("gitInfo")
        if isinstance(git_info, dict) and git_info:
            summary["gitInfo"] = git_info
        return summary

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

        active_subtask_id = self._positive_int(
            task.runtime_handle.get("activeSubtaskId")
        )
        active_streaming_index = self._active_streaming_assistant_index(messages)
        normalized = []
        for index, message in enumerate(messages):
            if not isinstance(message, dict):
                continue

            message_id = str(message.get("id") or f"{task.local_task_id}:{index}")
            if index == active_streaming_index and active_subtask_id is not None:
                subtask_id = active_subtask_id
            else:
                subtask_id = self._message_subtask_id(message)
            normalized_message = {
                "id": message_id,
                "role": str(message.get("role") or "assistant"),
                "content": self._string_content(message.get("content")),
                "status": message.get("status"),
                "createdAt": message.get("createdAt") or message.get("created_at"),
            }
            if subtask_id is not None:
                normalized_message["subtaskId"] = subtask_id
            attachments = message.get("attachments")
            if isinstance(attachments, list):
                normalized_message["attachments"] = [
                    attachment
                    for attachment in attachments
                    if isinstance(attachment, dict)
                ]
            blocks = message.get("blocks")
            if isinstance(blocks, list):
                normalized_blocks = [
                    block for block in blocks if isinstance(block, dict)
                ]
                if normalized_blocks:
                    normalized_message["blocks"] = normalized_blocks

            file_changes = message.get("fileChanges") or message.get("file_changes")
            if isinstance(file_changes, dict):
                normalized_message["fileChanges"] = file_changes

            source = message.get("source") or source_by_message_id.get(message_id)
            if isinstance(source, dict):
                normalized_message["source"] = source

            normalized.append(normalized_message)

        return normalized

    def _active_streaming_assistant_index(self, messages: list[Any]) -> Optional[int]:
        for index in range(len(messages) - 1, -1, -1):
            message = messages[index]
            if not isinstance(message, dict):
                continue
            if str(message.get("role") or "").lower() != "assistant":
                continue
            if str(message.get("status") or "").lower() == "streaming":
                return index
        return None

    def _message_subtask_id(self, message: dict[str, Any]) -> Optional[int]:
        for key in ("subtaskId", "subtask_id"):
            value = self._positive_int(message.get(key))
            if value is not None:
                return value

        message_id = message.get("id")
        if not isinstance(message_id, str):
            return None
        tail = message_id.rsplit(":", maxsplit=1)[-1]
        return self._positive_int(tail)

    def _positive_int(self, value: Any) -> Optional[int]:
        if isinstance(value, bool):
            return None
        if isinstance(value, int) and value > 0:
            return value
        if isinstance(value, str) and value.isdigit():
            parsed = int(value)
            return parsed if parsed > 0 else None
        return None

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


def _requires_fork_archive_restore(archive: dict[str, Any]) -> bool:
    if archive.get("mode") != "git_workspace":
        return True
    if archive.get("requiresSessionRestore"):
        return True
    return any(
        isinstance(archive.get(key), value_type) and bool(archive.get(key))
        for key, value_type in (
            ("localTransferId", str),
            ("receiverTransferId", str),
            ("downloadUrl", str),
            ("directUrls", list),
        )
    )
