# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Persistent local task index for native runtime sessions."""

import json
import os
import threading
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

from executor.config import config

INDEX_VERSION = 1


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def normalize_workspace_path(workspace_path: str) -> str:
    if not isinstance(workspace_path, str) or not workspace_path.strip():
        raise ValueError("workspace_path is required")
    return os.path.abspath(os.path.expanduser(workspace_path.strip()))


@dataclass
class LocalTaskRecord:
    local_task_id: str
    workspace_path: str
    title: str
    runtime: str
    workspace_kind: str = "workspace"
    worktree_id: Optional[str] = None
    runtime_handle: dict[str, Any] = field(default_factory=dict)
    parent: Optional[dict[str, Any]] = None
    children: list[dict[str, Any]] = field(default_factory=list)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    running: bool = False
    status: str = "active"


@dataclass
class LocalWorkspaceRecord:
    workspace_path: str
    runtime: str
    title: str
    runtime_handle: dict[str, Any] = field(default_factory=dict)
    created_at: str = field(default_factory=utc_now_iso)
    updated_at: str = field(default_factory=utc_now_iso)
    status: str = "active"


class LocalTaskStore:
    """JSON-backed local index of native runtime sessions."""

    _locks: dict[Path, threading.RLock] = {}
    _locks_guard = threading.Lock()

    def __init__(self, index_path: Optional[Path] = None) -> None:
        root = Path(config.WEGENT_EXECUTOR_HOME).expanduser() / "runtime-work"
        self.index_path = (
            Path(index_path).expanduser() if index_path else root / "index.json"
        )
        self.index_path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = self._lock_for(self.index_path.resolve())

    def upsert_task(self, task: LocalTaskRecord) -> None:
        workspace_path = normalize_workspace_path(task.workspace_path)
        now = utc_now_iso()
        normalized = LocalTaskRecord(
            local_task_id=task.local_task_id,
            workspace_path=workspace_path,
            title=task.title,
            runtime=task.runtime,
            workspace_kind=task.workspace_kind or "workspace",
            worktree_id=task.worktree_id,
            runtime_handle=task.runtime_handle,
            parent=task.parent,
            children=task.children,
            created_at=task.created_at or now,
            updated_at=task.updated_at or now,
            running=task.running,
            status=task.status or "active",
        )

        with self._lock:
            index = self._read_index()
            index["tasks"][normalized.local_task_id] = asdict(normalized)
            self._write_index(index)

    def upsert_workspace(self, workspace: LocalWorkspaceRecord) -> None:
        workspace_path = normalize_workspace_path(workspace.workspace_path)
        now = utc_now_iso()
        normalized = LocalWorkspaceRecord(
            workspace_path=workspace_path,
            runtime=workspace.runtime,
            title=workspace.title,
            runtime_handle=workspace.runtime_handle,
            created_at=workspace.created_at or now,
            updated_at=workspace.updated_at or now,
            status=workspace.status or "active",
        )

        with self._lock:
            index = self._read_index()
            index["workspaces"][workspace_path] = asdict(normalized)
            self._write_index(index)

    def list_workspaces(
        self,
        workspace_path: Optional[str] = None,
        include_archived: bool = False,
    ) -> list[LocalWorkspaceRecord]:
        normalized_workspace = (
            normalize_workspace_path(workspace_path) if workspace_path else None
        )
        with self._lock:
            records = [
                self._payload_to_workspace_record(payload)
                for payload in self._read_index()["workspaces"].values()
            ]

        filtered = []
        for record in records:
            if normalized_workspace and record.workspace_path != normalized_workspace:
                continue
            if not include_archived and record.status == "archived":
                continue
            filtered.append(record)

        return sorted(
            filtered,
            key=lambda record: (
                parse_task_time(record.updated_at),
                parse_task_time(record.created_at),
            ),
            reverse=True,
        )

    def list_tasks(
        self,
        workspace_path: Optional[str] = None,
        include_archived: bool = False,
    ) -> list[LocalTaskRecord]:
        normalized_workspace = (
            normalize_workspace_path(workspace_path) if workspace_path else None
        )
        with self._lock:
            records = [
                self._payload_to_record(payload)
                for payload in self._read_index()["tasks"].values()
            ]

        filtered = []
        for record in records:
            if normalized_workspace and record.workspace_path != normalized_workspace:
                continue
            if not include_archived and record.status == "archived":
                continue
            filtered.append(record)

        return sorted(
            filtered,
            key=lambda record: (
                parse_task_time(record.updated_at),
                parse_task_time(record.created_at),
            ),
            reverse=True,
        )

    def get_task(
        self,
        local_task_id: str,
        workspace_path: Optional[str] = None,
    ) -> LocalTaskRecord:
        with self._lock:
            payload = self._read_index()["tasks"].get(local_task_id)

        if payload is None:
            raise KeyError(f"Local task not found: {local_task_id}")

        task = self._payload_to_record(payload)
        if workspace_path and task.workspace_path != normalize_workspace_path(
            workspace_path
        ):
            raise KeyError(f"Local task not found in workspace: {local_task_id}")
        return task

    def update_task(
        self,
        local_task_id: str,
        updater: Callable[[LocalTaskRecord], LocalTaskRecord],
        workspace_path: Optional[str] = None,
    ) -> LocalTaskRecord:
        """Update one task atomically and return the stored record."""

        with self._lock:
            index = self._read_index()
            payload = index["tasks"].get(local_task_id)
            if payload is None:
                raise KeyError(f"Local task not found: {local_task_id}")

            current = self._payload_to_record(payload)
            if workspace_path and current.workspace_path != normalize_workspace_path(
                workspace_path
            ):
                raise KeyError(f"Local task not found in workspace: {local_task_id}")

            updated = updater(current)
            normalized = LocalTaskRecord(
                local_task_id=current.local_task_id,
                workspace_path=normalize_workspace_path(updated.workspace_path),
                title=updated.title,
                runtime=updated.runtime,
                workspace_kind=updated.workspace_kind
                or current.workspace_kind
                or "workspace",
                worktree_id=updated.worktree_id,
                runtime_handle=updated.runtime_handle,
                parent=updated.parent,
                children=updated.children,
                created_at=updated.created_at or current.created_at,
                updated_at=updated.updated_at or utc_now_iso(),
                running=updated.running,
                status=updated.status or "active",
            )
            index["tasks"][current.local_task_id] = asdict(normalized)
            self._write_index(index)
            return normalized

    def delete_task(
        self,
        local_task_id: str,
        workspace_path: Optional[str] = None,
    ) -> Optional[LocalTaskRecord]:
        """Delete one task atomically and return the removed record."""

        with self._lock:
            index = self._read_index()
            payload = index["tasks"].get(local_task_id)
            if payload is None:
                return None

            current = self._payload_to_record(payload)
            if workspace_path and current.workspace_path != normalize_workspace_path(
                workspace_path
            ):
                raise KeyError(f"Local task not found in workspace: {local_task_id}")

            index["tasks"].pop(local_task_id, None)
            self._write_index(index)
            return current

    @classmethod
    def _lock_for(cls, path: Path) -> threading.RLock:
        with cls._locks_guard:
            if path not in cls._locks:
                cls._locks[path] = threading.RLock()
            return cls._locks[path]

    def _read_index(self) -> dict[str, Any]:
        if not self.index_path.exists():
            return {"version": INDEX_VERSION, "tasks": {}, "workspaces": {}}

        try:
            data = json.loads(self.index_path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise ValueError(f"Failed to read local task index: {exc}") from exc

        tasks = data.get("tasks")
        if not isinstance(tasks, dict):
            raise ValueError("Invalid local task index: tasks must be an object")
        workspaces = data.get("workspaces")
        if workspaces is None:
            workspaces = {}
        if not isinstance(workspaces, dict):
            raise ValueError("Invalid local task index: workspaces must be an object")
        return {
            "version": data.get("version", INDEX_VERSION),
            "tasks": tasks,
            "workspaces": workspaces,
        }

    def _write_index(self, index: dict[str, Any]) -> None:
        payload = json.dumps(index, ensure_ascii=False, indent=2, sort_keys=True)
        temp_path = self.index_path.with_name(f".{self.index_path.name}.tmp")
        temp_path.write_text(payload, encoding="utf-8")
        os.replace(temp_path, self.index_path)

    def _payload_to_record(self, payload: Any) -> LocalTaskRecord:
        if not isinstance(payload, dict):
            raise ValueError("Invalid local task record")
        return LocalTaskRecord(
            local_task_id=str(payload["local_task_id"]),
            workspace_path=normalize_workspace_path(str(payload["workspace_path"])),
            title=str(payload["title"]),
            runtime=str(payload["runtime"]),
            workspace_kind=str(payload.get("workspace_kind") or "workspace"),
            worktree_id=self._optional_text_value(payload.get("worktree_id")),
            runtime_handle=self._dict_value(payload.get("runtime_handle")),
            parent=self._optional_dict_value(payload.get("parent")),
            children=self._list_value(payload.get("children")),
            created_at=str(payload.get("created_at") or utc_now_iso()),
            updated_at=str(payload.get("updated_at") or utc_now_iso()),
            running=bool(payload.get("running", False)),
            status=str(payload.get("status") or "active"),
        )

    def _payload_to_workspace_record(self, payload: Any) -> LocalWorkspaceRecord:
        if not isinstance(payload, dict):
            raise ValueError("Invalid local workspace record")
        return LocalWorkspaceRecord(
            workspace_path=normalize_workspace_path(str(payload["workspace_path"])),
            runtime=str(payload["runtime"]),
            title=str(payload.get("title") or payload["workspace_path"]),
            runtime_handle=self._dict_value(payload.get("runtime_handle")),
            created_at=str(payload.get("created_at") or utc_now_iso()),
            updated_at=str(payload.get("updated_at") or utc_now_iso()),
            status=str(payload.get("status") or "active"),
        )

    def _dict_value(self, value: Any) -> dict[str, Any]:
        return value if isinstance(value, dict) else {}

    def _optional_dict_value(self, value: Any) -> Optional[dict[str, Any]]:
        return value if isinstance(value, dict) else None

    def _optional_text_value(self, value: Any) -> Optional[str]:
        return value if isinstance(value, str) and value.strip() else None

    def _list_value(self, value: Any) -> list[dict[str, Any]]:
        return value if isinstance(value, list) else []


def parse_task_time(value: str) -> datetime:
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return datetime.min.replace(tzinfo=timezone.utc)
    if parsed.tzinfo is None:
        return parsed.replace(tzinfo=timezone.utc)
    return parsed
