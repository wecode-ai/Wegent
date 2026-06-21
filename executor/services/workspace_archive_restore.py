#!/usr/bin/env python

# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Restore forked task workspaces from archived runtime snapshots."""

import io
import tarfile
from copy import copy
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import httpx

from executor.config import config
from executor.services.api_client import get_api_base_url
from shared.logger import setup_logger
from shared.models.execution import ExecutionRequest

logger = setup_logger("workspace_archive_restore")

HOME_ARCHIVE_PREFIX = "home"
WORKSPACE_ARCHIVE_PREFIX = "workspace"
EXECUTOR_HOME_ARCHIVE_ALLOWLIST = {
    ".claude",
    ".claude.json",
}


@dataclass(frozen=True)
class WorkspaceArchiveRestoreResult:
    restored: bool
    session_restored: bool = False
    git_restored: bool = False


async def restore_fork_workspace_archive(
    task_data: ExecutionRequest,
    workspace_path: str | Path,
) -> WorkspaceArchiveRestoreResult:
    """Download and restore the workspace archive referenced by fork runtime."""
    archive = _fork_workspace_archive(task_data)
    if not archive:
        return WorkspaceArchiveRestoreResult(restored=False)

    source_task_id = archive["sourceTaskId"]
    storage_key = archive["storageKey"]
    headers = _auth_headers(task_data)
    api_base_url = get_api_base_url()
    download_url_api = (
        f"{api_base_url}/api/internal/workspace-archives/"
        f"{source_task_id}/download-url"
    )

    async with httpx.AsyncClient(timeout=300.0) as client:
        response = await client.get(
            download_url_api,
            params={"storage_key": storage_key},
            headers=headers,
        )
        response.raise_for_status()
        download_url = response.json()["download_url"]

        archive_response = await client.get(download_url)
        archive_response.raise_for_status()

    result = restore_archive_content(
        archive_content=archive_response.content,
        workspace_path=Path(workspace_path),
        home_path=Path(config.WEGENT_EXECUTOR_HOME),
    )
    if result.restored:
        task_data.skip_git_clone = True
    return result


def restore_archive_content(
    *,
    archive_content: bytes,
    workspace_path: Path,
    home_path: Path,
) -> WorkspaceArchiveRestoreResult:
    """Restore archive bytes into executor home and workspace directories."""
    workspace_path.mkdir(parents=True, exist_ok=True)
    home_path.mkdir(parents=True, exist_ok=True)
    session_restored = False
    git_restored = False

    with tarfile.open(fileobj=io.BytesIO(archive_content), mode="r:gz") as archive:
        home_members: list[tarfile.TarInfo] = []
        workspace_members: list[tarfile.TarInfo] = []
        for member in archive.getmembers():
            if _is_session_archive_member(member.name):
                session_restored = True
            if _is_git_archive_member(member.name):
                git_restored = True

            if member.name.startswith(f"{HOME_ARCHIVE_PREFIX}/"):
                home_members.append(member)
            elif member.name.startswith(f"{WORKSPACE_ARCHIVE_PREFIX}/"):
                workspace_members.append(member)

        _extract_members(
            archive,
            _filter_restorable_members(
                _strip_member_prefix(home_members, HOME_ARCHIVE_PREFIX),
                include_names=EXECUTOR_HOME_ARCHIVE_ALLOWLIST,
            ),
            home_path,
        )
        _extract_members(
            archive,
            _filter_restorable_members(
                _strip_member_prefix(workspace_members, WORKSPACE_ARCHIVE_PREFIX),
                include_names=None,
            ),
            workspace_path,
        )

    return WorkspaceArchiveRestoreResult(
        restored=True,
        session_restored=session_restored,
        git_restored=git_restored,
    )


def _fork_workspace_archive(task_data: ExecutionRequest) -> dict[str, str] | None:
    fork_runtime = getattr(task_data, "fork_runtime", None)
    if not isinstance(fork_runtime, dict):
        return None
    archive = fork_runtime.get("workspaceArchive")
    if not isinstance(archive, dict):
        return None

    source_task_id = archive.get("sourceTaskId")
    storage_key = archive.get("storageKey")
    if source_task_id is None or not isinstance(storage_key, str) or not storage_key:
        return None
    return {
        "sourceTaskId": str(source_task_id),
        "storageKey": storage_key,
    }


def _auth_headers(task_data: ExecutionRequest) -> dict[str, str]:
    auth_token = getattr(task_data, "auth_token", None)
    if not auth_token:
        return {}
    return {"Authorization": f"Bearer {auth_token}"}


def _strip_member_prefix(
    members: Iterable[tarfile.TarInfo],
    prefix: str,
) -> list[tarfile.TarInfo]:
    stripped: list[tarfile.TarInfo] = []
    prefix_with_slash = f"{prefix}/"
    for member in members:
        member_copy = copy(member)
        member_copy.name = member.name[len(prefix_with_slash) :]
        stripped.append(member_copy)
    return stripped


def _filter_restorable_members(
    members: Iterable[tarfile.TarInfo],
    *,
    include_names: set[str] | None,
) -> list[tarfile.TarInfo]:
    filtered: list[tarfile.TarInfo] = []
    for member in members:
        normalized_name = member.name.strip("/")
        if not normalized_name or _is_unsafe_member_name(normalized_name):
            continue
        if include_names is not None:
            root_name = normalized_name.split("/", 1)[0]
            if root_name not in include_names:
                continue
        member.name = normalized_name
        filtered.append(member)
    return filtered


def _is_unsafe_member_name(name: str) -> bool:
    path = Path(name)
    return path.is_absolute() or ".." in path.parts


def _extract_members(
    archive: tarfile.TarFile,
    members: list[tarfile.TarInfo],
    path: Path,
) -> None:
    if not members:
        return
    try:
        archive.extractall(path=str(path), members=members, filter="data")
    except TypeError:
        archive.extractall(path=str(path), members=members)


def _is_session_archive_member(name: str) -> bool:
    normalized_name = name.strip("/")
    return (
        normalized_name == ".claude_session_id"
        or normalized_name.startswith(".claude_session_id_")
        or normalized_name.endswith("/.claude_session_id")
        or "/.claude_session_id_" in normalized_name
        or normalized_name == f"{HOME_ARCHIVE_PREFIX}/.claude.json"
        or normalized_name == f"{HOME_ARCHIVE_PREFIX}/.claude"
        or normalized_name.startswith(f"{HOME_ARCHIVE_PREFIX}/.claude/")
        or normalized_name.startswith(f"{HOME_ARCHIVE_PREFIX}/.codex/sessions/")
        or normalized_name.startswith(
            f"{HOME_ARCHIVE_PREFIX}/.codex/archived_sessions/"
        )
        or normalized_name.startswith(f"{HOME_ARCHIVE_PREFIX}/.codex/state/")
    )


def _is_git_archive_member(name: str) -> bool:
    normalized_name = name.strip("/")
    return (
        normalized_name == ".git"
        or normalized_name.startswith(".git/")
        or "/.git/" in normalized_name
    )
