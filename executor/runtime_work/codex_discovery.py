# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discover Codex sessions as device-local runtime work items."""

import json
import os
from collections import deque
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Optional

from executor.agents.codex.config_builder import _resolve_codex_binary
from executor.config import config
from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    normalize_workspace_path,
    utc_now_iso,
)
from shared.logger import setup_logger

DEFAULT_CODEX_SESSION_LIMIT = 100
CODEX_SESSION_RUNNING_TAIL_LINES = 200
CODEX_TERMINAL_EVENT_TYPES = {"task_complete", "turn_aborted"}

logger = setup_logger("codex_session_discovery")


class CodexSessionDiscovery:
    """Read Codex SDK thread metadata and expose user sessions as LocalTasks."""

    def __init__(
        self,
        codex_home: Optional[Path] = None,
        limit: int = DEFAULT_CODEX_SESSION_LIMIT,
        codex_client_factory: Optional[Callable[[], Any]] = None,
    ):
        self.codex_home = Path(
            codex_home or os.environ.get("CODEX_HOME") or (Path.home() / ".codex")
        ).expanduser()
        self.limit = max(1, limit)
        self.codex_client_factory = codex_client_factory

    def discover(self) -> list[LocalTaskRecord]:
        try:
            records = self._discover_with_sdk()
        except Exception:
            logger.exception("Failed to list Codex threads through SDK")
            return []

        return _sort_local_tasks(records)

    def _discover_with_sdk(self) -> list[LocalTaskRecord]:
        client = self._create_codex_client()
        with client as codex:
            response = codex.thread_list(
                limit=self.limit,
                archived=False,
                sort_direction=_codex_enum_value("SortDirection", "desc"),
                sort_key=_codex_enum_value("ThreadSortKey", "updated_at"),
                use_state_db_only=True,
            )

        return [
            task
            for task in (
                _thread_to_local_task(thread)
                for thread in getattr(response, "data", [])
            )
            if task is not None
        ]

    def _create_codex_client(self) -> Any:
        if self.codex_client_factory is not None:
            return self.codex_client_factory()

        from openai_codex import Codex, CodexConfig

        return Codex(self._codex_config(CodexConfig))

    def _create_async_codex_client(self) -> Any:
        from openai_codex import AsyncCodex, CodexConfig

        return AsyncCodex(self._codex_config(CodexConfig))

    def _codex_config(self, config_type: Any) -> Any:
        return config_type(
            codex_bin=_resolve_codex_binary(config.CODEX_BINARY_PATH),
            client_name="wegent_executor",
            client_title="Wegent Executor",
            env={**os.environ, "CODEX_HOME": str(self.codex_home)},
        )

    def read_transcript(
        self,
        thread_id: str,
        session_path: Optional[str] = None,
    ) -> list[dict[str, Any]]:
        path = self._resolve_session_path(thread_id, session_path)
        if path is None:
            return []
        return _read_session_transcript(path, thread_id)

    def _resolve_session_path(
        self,
        thread_id: str,
        session_path: Optional[str],
    ) -> Optional[Path]:
        if session_path:
            path = Path(session_path).expanduser()
            if path.is_file():
                return path

        for path in _iter_session_files(self.codex_home, thread_id):
            return path
        return None

    def archive_thread(self, thread_id: str) -> None:
        client = self._create_codex_client()
        with client as codex:
            codex.thread_archive(thread_id)

    async def stream_message(
        self,
        thread_id: str,
        message: str,
        *,
        cwd: Optional[str] = None,
        emitter: Any,
    ) -> None:
        """Continue a Codex thread and emit the SDK turn stream."""

        from executor.agents.codex.codex_agent import _full_access_sandbox
        from executor.agents.codex.event_mapper import CodeXEventMapper

        client = self._create_async_codex_client()
        async with client as codex:
            thread = await codex.thread_resume(thread_id, cwd=cwd)
            mapper = CodeXEventMapper(emitter)
            await emitter.start(shell_type="Codex")
            turn = await thread.turn(
                message,
                cwd=cwd,
                sandbox=_full_access_sandbox(),
            )
            async for event in turn.stream():
                status = await mapper.handle(event)
                if status is not None:
                    return

        await emitter.error("Codex turn ended without completion", "execution_error")


def _thread_to_local_task(thread: Any) -> Optional[LocalTaskRecord]:
    thread_id = _object_text(thread, "id", "session_id")
    cwd = _object_text(thread, "cwd")
    if not thread_id or not cwd:
        return None

    created_at = (
        _codex_time_to_iso(_first_object_value(thread, "created_at", "createdAt"))
        or utc_now_iso()
    )
    updated_at = (
        _codex_time_to_iso(_first_object_value(thread, "updated_at", "updatedAt"))
        or created_at
    )
    session_path = _object_text(thread, "path")
    runtime_handle = {
        "threadId": thread_id,
        "sessionPath": session_path,
    }
    git_info = _thread_git_info(thread)
    if git_info:
        runtime_handle["gitInfo"] = git_info
    return LocalTaskRecord(
        local_task_id=thread_id,
        workspace_path=normalize_workspace_path(cwd),
        title=_thread_title(thread, thread_id),
        runtime="codex",
        runtime_handle=runtime_handle,
        created_at=created_at,
        updated_at=updated_at,
        running=_is_thread_running(thread)
        or _is_session_transcript_running(session_path),
        status="active",
    )


def _thread_title(thread: Any, thread_id: str) -> str:
    title = _object_text(thread, "name", "preview", "title")
    return title or thread_id


def _is_thread_running(thread: Any) -> bool:
    status = _object_value(thread, "status")
    if status is None:
        return False
    if isinstance(status, str):
        status_type = status
    else:
        status_type = _object_text(status, "type", "status", "value", "name")
        if not status_type:
            status_type = _object_text(
                _object_value(status, "root"),
                "type",
                "status",
                "value",
                "name",
            )

    normalized = (status_type or "").replace("_", "").lower()
    return normalized not in ("", "notloaded", "completed", "archived", "idle")


def _is_session_transcript_running(session_path: Optional[str]) -> bool:
    if not session_path:
        return False

    path = Path(session_path).expanduser()
    if not path.is_file():
        return False

    try:
        lines: deque[str] = deque(maxlen=CODEX_SESSION_RUNNING_TAIL_LINES)
        with path.open(encoding="utf-8", errors="replace") as handle:
            for line in handle:
                lines.append(line)
    except OSError:
        return False

    active_turn = False
    pending_call_ids: set[str] = set()
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        payload = entry.get("payload")
        if not isinstance(payload, dict):
            continue

        payload_type = payload.get("type")
        if entry.get("type") == "event_msg" and payload_type == "task_started":
            active_turn = True
            pending_call_ids.clear()
            continue
        if (
            entry.get("type") == "event_msg"
            and payload_type in CODEX_TERMINAL_EVENT_TYPES
        ):
            active_turn = False
            pending_call_ids.clear()
            continue

        if entry.get("type") != "response_item":
            continue
        if payload_type == "function_call":
            call_id = _payload_text(payload, "call_id", "id")
            if call_id:
                pending_call_ids.add(call_id)
        elif payload_type == "function_call_output":
            call_id = _payload_text(payload, "call_id")
            if call_id:
                pending_call_ids.discard(call_id)

    return active_turn or bool(pending_call_ids)


def _thread_git_info(thread: Any) -> Optional[dict[str, Any]]:
    git_info = _first_object_value(thread, "git_info", "gitInfo")
    if git_info is None:
        return None
    if isinstance(git_info, dict):
        payload = git_info
    elif hasattr(git_info, "model_dump"):
        payload = git_info.model_dump(mode="json", by_alias=True, exclude_none=True)
    else:
        payload = {
            "branch": _object_value(git_info, "branch"),
            "originUrl": _first_object_value(git_info, "origin_url", "originUrl"),
            "sha": _object_value(git_info, "sha"),
        }

    normalized: dict[str, Any] = {}
    for source_key, target_key in (
        ("branch", "branch"),
        ("origin_url", "originUrl"),
        ("originUrl", "originUrl"),
        ("sha", "sha"),
    ):
        value = payload.get(source_key)
        if isinstance(value, str) and value.strip():
            normalized[target_key] = value.strip()
    return normalized or None


def _first_object_value(value: Any, *names: str) -> Any:
    for name in names:
        raw = _object_value(value, name)
        if raw is not None:
            return raw
    return None


def _object_value(value: Any, *names: str) -> Any:
    current = value
    for name in names:
        if isinstance(current, dict):
            current = current.get(name)
        else:
            current = getattr(current, name, None)
    return current


def _object_text(value: Any, *names: str) -> Optional[str]:
    for name in names:
        raw = _object_value(value, name)
        if isinstance(raw, str) and raw.strip():
            return raw.strip()
        root = _object_value(raw, "root")
        if isinstance(root, str) and root.strip():
            return root.strip()
    return None


def _payload_text(payload: dict[str, Any], *names: str) -> Optional[str]:
    for name in names:
        value = payload.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _codex_time_to_iso(value: Any) -> Optional[str]:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, timezone.utc).isoformat()
    if isinstance(value, str) and value.strip():
        parsed = _parse_datetime(value.strip())
        return parsed.isoformat() if parsed else value.strip()
    return None


def _codex_enum_value(enum_name: str, value: str) -> Any:
    try:
        from openai_codex.generated import v2_all

        enum_type = getattr(v2_all, enum_name)
        return enum_type(value)
    except (ImportError, AttributeError, TypeError, ValueError):
        return value


def _sort_local_tasks(records: list[LocalTaskRecord]) -> list[LocalTaskRecord]:
    return sorted(
        records,
        key=lambda record: _parse_datetime(record.updated_at)
        or datetime.min.replace(tzinfo=timezone.utc),
        reverse=True,
    )


def _parse_json_line(value: Any) -> Optional[dict[str, Any]]:
    if isinstance(value, bytes):
        value = value.decode("utf-8", errors="ignore")
    if not isinstance(value, str) or not value.strip():
        return None
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return None
    return parsed if isinstance(parsed, dict) else None


def _first_text(record: dict[str, Any], *keys: str) -> Optional[str]:
    for key in keys:
        value = record.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def _parse_datetime(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed


def _iter_session_files(
    codex_home: Path,
    thread_id: str,
) -> Iterable[Path]:
    seen: set[str] = set()
    sessions_root = codex_home / "sessions"
    archived_root = codex_home / "archived_sessions"
    yield from _iter_unique_matches(archived_root, f"*{thread_id}*.jsonl", seen)
    yield from _iter_unique_matches(archived_root, f"*/*/*/*{thread_id}*.jsonl", seen)
    yield from _iter_unique_matches(sessions_root, f"*/*/*/*{thread_id}*.jsonl", seen)


def _iter_unique_matches(root: Path, pattern: str, seen: set[str]) -> Iterable[Path]:
    if not root.is_dir():
        return
    try:
        matches = root.glob(pattern)
    except OSError:
        return
    for path in matches:
        try:
            key = str(path.resolve())
        except OSError:
            key = str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.is_file():
            yield path


def _read_session_transcript(path: Path, thread_id: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    pending_agent_message: Optional[dict[str, Any]] = None
    processing_blocks: list[dict[str, Any]] = []
    tool_blocks_by_call_id: dict[str, dict[str, Any]] = {}
    turn_started_at: Optional[str] = None
    turn_counter = 0

    try:
        with path.open("rb") as handle:
            for raw_line in handle:
                record = _parse_json_line(raw_line)
                if record is None:
                    continue

                payload = record.get("payload")
                if not isinstance(payload, dict):
                    continue

                event_type = payload.get("type")
                timestamp = _record_timestamp(record, payload)
                if record.get("type") == "response_item":
                    if turn_counter > 0:
                        _append_response_item_block(
                            payload=payload,
                            timestamp=timestamp,
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            processing_blocks=processing_blocks,
                            tool_blocks_by_call_id=tool_blocks_by_call_id,
                        )
                    continue

                if event_type == "user_message":
                    turn_counter += 1
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = timestamp
                    message = _first_text(payload, "message")
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="user",
                                content=message,
                                created_at=timestamp,
                                status="done",
                            )
                        )
                elif event_type == "agent_message":
                    message = _first_text(payload, "message")
                    if message:
                        pending_agent_message = _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=message,
                            created_at=turn_started_at or timestamp,
                            status="streaming",
                            blocks=processing_blocks,
                        )
                elif event_type == "task_complete":
                    message = _first_text(payload, "last_agent_message")
                    _finish_processing_blocks(processing_blocks, timestamp)
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="assistant",
                                content=message,
                                created_at=turn_started_at or timestamp,
                                status="done",
                                blocks=processing_blocks,
                            )
                        )
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
                elif event_type == "turn_aborted":
                    reason = _first_text(payload, "reason") or "Codex turn aborted"
                    _finish_processing_blocks(processing_blocks, timestamp)
                    messages.append(
                        _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=reason,
                            created_at=turn_started_at or timestamp,
                            status="cancelled",
                            blocks=processing_blocks,
                        )
                    )
                    pending_agent_message = None
                    processing_blocks = []
                    tool_blocks_by_call_id = {}
                    turn_started_at = None
    except OSError:
        return []

    if pending_agent_message:
        _set_message_blocks(pending_agent_message, processing_blocks)
        messages.append(pending_agent_message)
    return messages


def _append_response_item_block(
    *,
    payload: dict[str, Any],
    timestamp: str,
    thread_id: str,
    turn_counter: int,
    processing_blocks: list[dict[str, Any]],
    tool_blocks_by_call_id: dict[str, dict[str, Any]],
) -> None:
    item_type = _normalize_codex_type(payload.get("type"))
    timestamp_ms = _timestamp_to_millis(timestamp)

    if item_type == "reasoning":
        content = _extract_reasoning_text(payload)
        if not content:
            return
        block_id = _first_text(payload, "id") or (
            f"{thread_id}:thinking:{turn_counter}:{len(processing_blocks)}"
        )
        processing_blocks.append(
            {
                "id": block_id,
                "type": "thinking",
                "content": content,
                "status": "done",
                "timestamp": timestamp_ms,
            }
        )
        return

    if item_type == "function_call":
        call_id = _response_item_call_id(payload)
        if not call_id:
            return
        raw_name = _first_text(payload, "name") or "unknown"
        raw_arguments = _parse_tool_arguments(payload.get("arguments"))
        tool_name, tool_input = _normalize_tool(raw_name, raw_arguments)
        block = {
            "id": call_id,
            "type": "tool",
            "tool_use_id": call_id,
            "tool_name": tool_name,
            "tool_input": tool_input,
            "status": "pending",
            "timestamp": timestamp_ms,
        }
        processing_blocks.append(block)
        tool_blocks_by_call_id[call_id] = block
        return

    if item_type == "function_call_output":
        call_id = _response_item_call_id(payload)
        if not call_id:
            return
        block = tool_blocks_by_call_id.get(call_id)
        if block is None:
            block = {
                "id": call_id,
                "type": "tool",
                "tool_use_id": call_id,
                "tool_name": "unknown",
                "tool_input": {},
                "timestamp": timestamp_ms,
            }
            processing_blocks.append(block)
            tool_blocks_by_call_id[call_id] = block
        block["tool_output"] = _stringify_tool_output(payload.get("output"))
        block["status"] = "done"
        _set_block_timestamp(block, timestamp_ms)
        return

    if item_type == "message":
        phase = _normalize_codex_type(payload.get("phase"))
        role = str(payload.get("role") or "").lower()
        if phase != "commentary" or role != "assistant":
            return
        content = _extract_response_message_text(payload)
        if not content:
            return
        block_id = _first_text(payload, "id") or (
            f"{thread_id}:text:{turn_counter}:{len(processing_blocks)}"
        )
        processing_blocks.append(
            {
                "id": block_id,
                "type": "text",
                "content": content,
                "status": "done",
                "timestamp": timestamp_ms,
            }
        )


def _set_message_blocks(
    message: dict[str, Any],
    blocks: list[dict[str, Any]],
) -> None:
    if blocks:
        message["blocks"] = list(blocks)


def _finish_processing_blocks(blocks: list[dict[str, Any]], timestamp: str) -> None:
    if not blocks:
        return
    _set_block_timestamp(blocks[-1], _timestamp_to_millis(timestamp))


def _set_block_timestamp(block: dict[str, Any], timestamp_ms: int) -> None:
    current = block.get("timestamp")
    if isinstance(current, (int, float)) and current >= timestamp_ms:
        return
    block["timestamp"] = timestamp_ms


def _transcript_message(
    *,
    thread_id: str,
    turn_counter: int,
    role: str,
    content: str,
    created_at: str,
    status: str,
    blocks: Optional[list[dict[str, Any]]] = None,
) -> dict[str, Any]:
    index = max(turn_counter, 0)
    message = {
        "id": f"{thread_id}:{role}:{index}",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "status": status,
    }
    _set_message_blocks(message, blocks or [])
    return message


def _record_timestamp(record: dict[str, Any], payload: dict[str, Any]) -> str:
    return _record_timestamp_value(record, payload) or utc_now_iso()


def _record_timestamp_value(
    record: dict[str, Any],
    payload: dict[str, Any],
) -> Optional[str]:
    completed_at = payload.get("completed_at")
    if isinstance(completed_at, (int, float)):
        return datetime.fromtimestamp(completed_at, timezone.utc).isoformat()

    timestamp = record.get("timestamp") or payload.get("timestamp")
    if isinstance(timestamp, str) and timestamp.strip():
        return timestamp.strip()
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return None


def _timestamp_to_millis(value: str) -> int:
    parsed = _parse_datetime(value)
    if parsed is not None:
        return int(parsed.timestamp() * 1000)
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _normalize_codex_type(value: Any) -> str:
    raw_value = getattr(value, "value", value)
    return str(raw_value or "").replace("-", "_").lower()


def _response_item_call_id(payload: dict[str, Any]) -> Optional[str]:
    return _first_text(payload, "call_id", "callId", "id")


def _parse_tool_arguments(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value:
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return {"arguments": value}
        return parsed if isinstance(parsed, dict) else {"arguments": parsed}
    return {}


def _normalize_tool(
    name: str,
    arguments: dict[str, Any],
) -> tuple[str, dict[str, Any]]:
    if name != "exec_command":
        return name, arguments

    normalized_arguments = dict(arguments)
    command = normalized_arguments.pop("cmd", None)
    workdir = normalized_arguments.pop("workdir", None)
    if command is not None:
        normalized_arguments["command"] = command
    if workdir is not None:
        normalized_arguments["cwd"] = workdir
    return "bash", normalized_arguments


def _extract_reasoning_text(payload: dict[str, Any]) -> Optional[str]:
    parts = _collect_text_parts(payload.get("summary"))
    if not parts:
        parts = _collect_text_parts(payload.get("content"))
    content = "\n".join(parts).strip()
    return content or None


def _extract_response_message_text(payload: dict[str, Any]) -> Optional[str]:
    text = _first_text(payload, "text")
    if text:
        return text
    content = "\n".join(_collect_text_parts(payload.get("content"))).strip()
    return content or None


def _collect_text_parts(value: Any) -> list[str]:
    if isinstance(value, str):
        text = value.strip()
        return [text] if text else []
    if isinstance(value, list):
        parts: list[str] = []
        for item in value:
            parts.extend(_collect_text_parts(item))
        return parts
    if isinstance(value, dict):
        parts: list[str] = []
        for key in ("text", "content"):
            parts.extend(_collect_text_parts(value.get(key)))
        return parts
    return []


def _stringify_tool_output(value: Any) -> Any:
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    try:
        return json.dumps(value, ensure_ascii=False)
    except (TypeError, ValueError):
        return str(value)
