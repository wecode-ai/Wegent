# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Discover Codex CLI sessions as device-local runtime work items."""

import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Optional

from executor.runtime_work.local_task_store import (
    LocalTaskRecord,
    normalize_workspace_path,
    utc_now_iso,
)

DEFAULT_CODEX_SESSION_LIMIT = 100
MAX_SESSION_METADATA_LINES = 80


class CodexSessionDiscovery:
    """Read Codex local session metadata and expose user sessions as LocalTasks."""

    def __init__(
        self,
        codex_home: Optional[Path] = None,
        limit: int = DEFAULT_CODEX_SESSION_LIMIT,
    ):
        self.codex_home = Path(
            codex_home or os.environ.get("CODEX_HOME") or (Path.home() / ".codex")
        ).expanduser()
        self.limit = max(1, limit)

    def discover(self) -> list[LocalTaskRecord]:
        records = []
        for raw in _iter_recent_json_lines(
            self.codex_home / "session_index.jsonl",
            self.limit,
        ):
            normalized = self._normalize_record(raw)
            if normalized:
                records.append(normalized)

        return sorted(
            records,
            key=lambda record: _parse_datetime(record.updated_at)
            or datetime.min.replace(tzinfo=timezone.utc),
            reverse=True,
        )

    def _normalize_record(self, record: dict[str, Any]) -> Optional[LocalTaskRecord]:
        thread_id = _first_text(
            record, "id", "thread_id", "threadId", "conversation_id"
        )
        if not thread_id:
            return None

        title = (
            _first_text(record, "title", "thread_name", "summary", "name") or thread_id
        )
        updated_at = _first_text(record, "updatedAt", "updated_at", "mtime")
        metadata = self._find_session_metadata(thread_id, updated_at)
        cwd = _first_text(
            record,
            "cwd",
            "workdir",
            "workingDirectory",
            "working_directory",
        ) or metadata.get("cwd")
        if not cwd:
            return None

        thread_source = _first_text(
            record, "threadSource", "thread_source"
        ) or metadata.get("threadSource")
        if not _is_visible_thread(record, thread_source):
            return None

        timestamp = updated_at or utc_now_iso()
        return LocalTaskRecord(
            local_task_id=thread_id,
            workspace_path=normalize_workspace_path(cwd),
            title=title,
            runtime="codex",
            runtime_handle={
                "threadId": thread_id,
                "sessionPath": metadata.get("sessionPath"),
            },
            created_at=timestamp,
            updated_at=timestamp,
            running=bool(record.get("running", False)),
            status="active",
        )

    def _find_session_metadata(
        self,
        thread_id: str,
        updated_at: Optional[str],
    ) -> dict[str, str]:
        for path in _iter_session_files(self.codex_home, thread_id, updated_at):
            metadata = _read_session_metadata(path)
            if metadata:
                return metadata
        return {}

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

        for path in _iter_session_files(self.codex_home, thread_id, None):
            return path
        return None


def _iter_recent_json_lines(path: Path, limit: int) -> Iterable[dict[str, Any]]:
    if limit <= 0 or not path.is_file():
        return

    try:
        lines = path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return

    remaining = limit
    for line in reversed(lines):
        if remaining <= 0:
            return
        record = _parse_json_line(line)
        if record is None:
            continue
        remaining -= 1
        yield record


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


def _first_nested_text(value: Any, *keys: str) -> Optional[str]:
    if isinstance(value, dict):
        for key in keys:
            direct = value.get(key)
            if isinstance(direct, str) and direct.strip():
                return direct.strip()
        for child in value.values():
            found = _first_nested_text(child, *keys)
            if found:
                return found
    elif isinstance(value, list):
        for child in value:
            found = _first_nested_text(child, *keys)
            if found:
                return found
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
    updated_at: Optional[str],
) -> Iterable[Path]:
    seen: set[str] = set()
    sessions_root = codex_home / "sessions"
    parsed = _parse_datetime(updated_at)
    date_values = []
    if parsed:
        date_values.append(parsed)
        try:
            date_values.append(parsed.astimezone())
        except ValueError:
            pass

    for value in date_values:
        date_root = (
            sessions_root
            / f"{value.year:04d}"
            / f"{value.month:02d}"
            / f"{value.day:02d}"
        )
        yield from _iter_unique_matches(date_root, f"*{thread_id}*.jsonl", seen)

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


def _read_session_metadata(path: Path) -> dict[str, str]:
    cwd_keys = (
        "cwd",
        "workdir",
        "workingDirectory",
        "working_directory",
        "currentWorkingDirectory",
        "current_working_directory",
    )
    try:
        with path.open("rb") as handle:
            for line_number, raw_line in enumerate(handle):
                if line_number >= MAX_SESSION_METADATA_LINES:
                    break
                record = _parse_json_line(raw_line)
                if record is None:
                    continue
                thread_source = _first_nested_text(
                    record,
                    "thread_source",
                    "threadSource",
                )
                cwd = _first_nested_text(record, *cwd_keys)
                if cwd or thread_source:
                    return {
                        "cwd": cwd or "",
                        "threadSource": thread_source or "",
                        "sessionPath": str(path),
                    }
    except OSError:
        return {}
    return {}


def _is_visible_thread(record: dict[str, Any], thread_source: Optional[str]) -> bool:
    if bool(record.get("archived", False)):
        return False
    normalized_source = thread_source.strip().lower() if thread_source else ""
    return normalized_source in ("", "user")


def _read_session_transcript(path: Path, thread_id: str) -> list[dict[str, Any]]:
    messages: list[dict[str, Any]] = []
    pending_agent_message: Optional[dict[str, Any]] = None
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
                if event_type == "user_message":
                    turn_counter += 1
                    pending_agent_message = None
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
                            created_at=timestamp,
                            status="streaming",
                        )
                elif event_type == "task_complete":
                    message = _first_text(payload, "last_agent_message")
                    if message:
                        messages.append(
                            _transcript_message(
                                thread_id=thread_id,
                                turn_counter=turn_counter,
                                role="assistant",
                                content=message,
                                created_at=timestamp,
                                status="done",
                            )
                        )
                    pending_agent_message = None
                elif event_type == "turn_aborted":
                    reason = _first_text(payload, "reason") or "Codex turn aborted"
                    messages.append(
                        _transcript_message(
                            thread_id=thread_id,
                            turn_counter=turn_counter,
                            role="assistant",
                            content=reason,
                            created_at=timestamp,
                            status="cancelled",
                        )
                    )
                    pending_agent_message = None
    except OSError:
        return []

    if pending_agent_message:
        messages.append(pending_agent_message)
    return messages


def _transcript_message(
    *,
    thread_id: str,
    turn_counter: int,
    role: str,
    content: str,
    created_at: str,
    status: str,
) -> dict[str, Any]:
    index = max(turn_counter, 0)
    return {
        "id": f"{thread_id}:{role}:{index}",
        "role": role,
        "content": content,
        "createdAt": created_at,
        "status": status,
    }


def _record_timestamp(record: dict[str, Any], payload: dict[str, Any]) -> str:
    completed_at = payload.get("completed_at")
    if isinstance(completed_at, (int, float)):
        return datetime.fromtimestamp(completed_at, timezone.utc).isoformat()

    timestamp = record.get("timestamp") or payload.get("timestamp")
    if isinstance(timestamp, str) and timestamp.strip():
        return timestamp.strip()
    if isinstance(timestamp, (int, float)):
        return datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    return utc_now_iso()
