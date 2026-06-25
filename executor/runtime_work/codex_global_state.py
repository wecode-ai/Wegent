# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Partial reader for Codex App global project state."""

import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Literal, Optional
from urllib.parse import quote

from executor.runtime_work.local_task_store import normalize_workspace_path

CODEX_GLOBAL_STATE_FILENAME = ".codex-global-state.json"
SAVED_WORKSPACE_ROOTS_KEY = "electron-saved-workspace-roots"
WORKSPACE_ROOT_LABELS_KEY = "electron-workspace-root-labels"
PROJECT_ORDER_KEY = "project-order"
CodexProjectSource = Literal["local", "remote"]


@dataclass(frozen=True)
class CodexRemoteProject:
    id: str
    host_id: str
    remote_path: str
    label: Optional[str] = None


@dataclass(frozen=True)
class CodexGlobalProject:
    key: str
    name: str
    workspace_path: str
    source: CodexProjectSource
    host_id: Optional[str] = None
    order_index: Optional[int] = None


@dataclass(frozen=True)
class CodexGlobalProjectIndex:
    projects: list[CodexGlobalProject]
    projects_by_key: dict[str, CodexGlobalProject]
    projectless_thread_ids: set[str]
    thread_workspace_root_hints: dict[str, str]
    path_projects: list[tuple[str, CodexGlobalProject]]

    def project_for_thread(
        self,
        thread_id: str,
        workspace_path: str,
    ) -> Optional[CodexGlobalProject]:
        if thread_id in self.projectless_thread_ids:
            return None

        hinted_root = self.thread_workspace_root_hints.get(thread_id)
        if hinted_root:
            hinted_project = self.projects_by_key.get(
                _normalize_path_or_raw(hinted_root)
            )
            if hinted_project is not None:
                return hinted_project

        normalized_path = normalize_workspace_path(workspace_path)
        for root, project in self.path_projects:
            if _path_is_within_normalized(normalized_path, root):
                return project
        return None


@dataclass(frozen=True)
class CodexGlobalState:
    saved_workspace_roots: list[str]
    remote_projects: list[CodexRemoteProject]
    project_order: list[str]
    workspace_root_labels: dict[str, str]
    projectless_thread_ids: set[str]
    thread_workspace_root_hints: dict[str, str]

    @property
    def has_project_roots(self) -> bool:
        return bool(self.saved_workspace_roots)

    def projects(self) -> list[CodexGlobalProject]:
        projects: list[CodexGlobalProject] = []
        for index, root in enumerate(self.saved_workspace_roots):
            projects.append(
                CodexGlobalProject(
                    key=root,
                    name=self.workspace_root_labels.get(root) or _path_basename(root),
                    workspace_path=root,
                    source="local",
                    order_index=index,
                )
            )
        return projects

    def project_index(self) -> CodexGlobalProjectIndex:
        projects = self.projects()
        projects_by_key: dict[str, CodexGlobalProject] = {}
        path_projects: list[tuple[str, CodexGlobalProject]] = []
        for project in projects:
            projects_by_key[project.key] = project
            projects_by_key[project.workspace_path] = project
            path_projects.append((project.workspace_path, project))
        return CodexGlobalProjectIndex(
            projects=projects,
            projects_by_key=projects_by_key,
            projectless_thread_ids=self.projectless_thread_ids,
            thread_workspace_root_hints=self.thread_workspace_root_hints,
            path_projects=sorted(
                path_projects,
                key=lambda item: len(item[0]),
                reverse=True,
            ),
        )

    def project_for_thread(
        self,
        thread_id: str,
        workspace_path: str,
    ) -> Optional[CodexGlobalProject]:
        return self.project_index().project_for_thread(thread_id, workspace_path)


def load_codex_global_state(codex_home: Path) -> Optional[CodexGlobalState]:
    payload = _read_global_state_payload(codex_home)
    if payload is None:
        return None

    saved_roots = _normalized_text_list(payload.get(SAVED_WORKSPACE_ROOTS_KEY))
    project_order = _text_list(payload.get(PROJECT_ORDER_KEY))
    workspace_root_labels = _string_map(payload.get(WORKSPACE_ROOT_LABELS_KEY))
    thread_workspace_root_hints = {
        thread_id: _normalize_path_or_raw(root)
        for thread_id, root in _string_map(
            payload.get("thread-workspace-root-hints")
        ).items()
    }
    return CodexGlobalState(
        saved_workspace_roots=saved_roots,
        remote_projects=_remote_projects(payload.get("remote-projects")),
        project_order=project_order,
        workspace_root_labels={
            _normalize_path_or_raw(root): label
            for root, label in workspace_root_labels.items()
        },
        projectless_thread_ids=set(_text_list(payload.get("projectless-thread-ids"))),
        thread_workspace_root_hints=thread_workspace_root_hints,
    )


def ensure_codex_global_project(
    codex_home: Path,
    workspace_path: str,
    *,
    label: Optional[str] = None,
) -> CodexGlobalProject:
    """Add a local project root to Codex global state without creating a thread."""

    normalized_workspace = normalize_workspace_path(workspace_path)

    def mutate(payload: dict[str, Any]) -> None:
        _upsert_text_list(
            payload,
            SAVED_WORKSPACE_ROOTS_KEY,
            normalized_workspace,
            prepend=True,
        )
        _upsert_text_list(
            payload,
            PROJECT_ORDER_KEY,
            normalized_workspace,
            prepend=True,
        )
        _set_workspace_label(payload, normalized_workspace, label)

    _update_global_state_payload(codex_home, mutate)
    return CodexGlobalProject(
        key=normalized_workspace,
        name=label or _path_basename(normalized_workspace),
        workspace_path=normalized_workspace,
        source="local",
    )


def notify_running_codex_app_workspace_root(workspace_path: str) -> bool:
    """Ask a running macOS Codex App to register the project in its UI state."""

    if sys.platform != "darwin" or not _is_codex_app_running():
        return False

    normalized_workspace = normalize_workspace_path(workspace_path)
    deeplink = f"codex://new?path={quote(normalized_workspace, safe='')}"
    try:
        result = subprocess.run(
            ["open", "-g", deeplink],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=3,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def rename_codex_global_project(
    codex_home: Path,
    workspace_path: str,
    label: str,
) -> CodexGlobalProject:
    """Update the display label for a local project root."""

    normalized_workspace = normalize_workspace_path(workspace_path)
    normalized_label = label.strip()
    if not normalized_label:
        raise ValueError("label is required")

    def mutate(payload: dict[str, Any]) -> None:
        _upsert_text_list(payload, SAVED_WORKSPACE_ROOTS_KEY, normalized_workspace)
        _upsert_text_list(payload, PROJECT_ORDER_KEY, normalized_workspace)
        _set_workspace_label(payload, normalized_workspace, normalized_label)

    _update_global_state_payload(codex_home, mutate)
    return CodexGlobalProject(
        key=normalized_workspace,
        name=normalized_label,
        workspace_path=normalized_workspace,
        source="local",
    )


def remove_codex_global_project(codex_home: Path, workspace_path: str) -> str:
    """Remove a local project root from Codex global state without deleting threads."""

    normalized_workspace = normalize_workspace_path(workspace_path)

    def mutate(payload: dict[str, Any]) -> None:
        _remove_text_list_item(payload, SAVED_WORKSPACE_ROOTS_KEY, normalized_workspace)
        _remove_text_list_item(payload, PROJECT_ORDER_KEY, normalized_workspace)
        labels = payload.get(WORKSPACE_ROOT_LABELS_KEY)
        if isinstance(labels, dict):
            labels.pop(normalized_workspace, None)

    _update_global_state_payload(codex_home, mutate)
    return normalized_workspace


def _read_global_state_payload(codex_home: Path) -> Optional[dict[str, Any]]:
    path = Path(codex_home).expanduser() / CODEX_GLOBAL_STATE_FILENAME
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return payload if isinstance(payload, dict) else None


def _is_codex_app_running() -> bool:
    try:
        result = subprocess.run(
            ["pgrep", "-f", "/Applications/Codex.app/Contents"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=1,
        )
    except (OSError, subprocess.SubprocessError):
        return False
    return result.returncode == 0


def _update_global_state_payload(
    codex_home: Path,
    mutate: Callable[[dict[str, Any]], None],
) -> dict[str, Any]:
    codex_home = Path(codex_home).expanduser()
    path = codex_home / CODEX_GLOBAL_STATE_FILENAME
    payload = _read_global_state_payload(codex_home) or {}
    mutate(payload)
    codex_home.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w",
        encoding="utf-8",
        dir=codex_home,
        prefix=f".{CODEX_GLOBAL_STATE_FILENAME}.",
        suffix=".tmp",
        delete=False,
    ) as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.write("\n")
        temporary_path = Path(handle.name)
    os.replace(temporary_path, path)
    return payload


def _upsert_text_list(
    payload: dict[str, Any],
    key: str,
    item: str,
    *,
    prepend: bool = False,
) -> None:
    values = _text_list(payload.get(key))
    if item not in values:
        if prepend:
            values.insert(0, item)
        else:
            values.append(item)
    payload[key] = values


def _remove_text_list_item(
    payload: dict[str, Any],
    key: str,
    item: str,
) -> None:
    payload[key] = [value for value in _text_list(payload.get(key)) if value != item]


def _set_workspace_label(
    payload: dict[str, Any],
    workspace_path: str,
    label: Optional[str],
) -> None:
    normalized_label = label.strip() if isinstance(label, str) else ""
    labels = payload.get(WORKSPACE_ROOT_LABELS_KEY)
    if not isinstance(labels, dict):
        labels = {}
    if normalized_label:
        labels[workspace_path] = normalized_label
    else:
        labels.pop(workspace_path, None)
    payload[WORKSPACE_ROOT_LABELS_KEY] = labels


def _remote_projects(value: Any) -> list[CodexRemoteProject]:
    if not isinstance(value, list):
        return []

    projects = []
    for item in value:
        if not isinstance(item, dict):
            continue
        project_id = _clean_text(item.get("id"))
        host_id = _clean_text(item.get("hostId"))
        remote_path = _clean_text(item.get("remotePath"))
        if not project_id or not host_id or not remote_path:
            continue
        projects.append(
            CodexRemoteProject(
                id=project_id,
                host_id=host_id,
                remote_path=normalize_workspace_path(remote_path),
                label=_clean_text(item.get("label")),
            )
        )
    return projects


def _normalized_text_list(value: Any) -> list[str]:
    return [_normalize_path_or_raw(item) for item in _text_list(value)]


def _text_list(value: Any) -> list[str]:
    if not isinstance(value, list):
        return []
    result = []
    seen = set()
    for item in value:
        text = _clean_text(item)
        if not text or text in seen:
            continue
        seen.add(text)
        result.append(text)
    return result


def _string_map(value: Any) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    result = {}
    for key, item in value.items():
        clean_key = _clean_text(key)
        clean_item = _clean_text(item)
        if clean_key and clean_item:
            result[clean_key] = clean_item
    return result


def _clean_text(value: Any) -> Optional[str]:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _normalize_path_or_raw(value: str) -> str:
    try:
        return normalize_workspace_path(value)
    except ValueError:
        return value.strip()


def _path_basename(path: str) -> str:
    normalized = path.rstrip(os.sep)
    return Path(normalized).name or normalized


def _path_is_within_normalized(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([path, root]) == root
    except ValueError:
        return False
