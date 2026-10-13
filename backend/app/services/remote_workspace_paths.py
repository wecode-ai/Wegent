# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Resolve task workspace roots from the executor's persisted repository binding."""

import logging
import posixpath

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)


def resolve_executor_workspace_root(base_url: str, task_id: int, timeout: float) -> str:
    try:
        with httpx.Client(timeout=timeout) as client:
            response = client.post(
                f"{base_url}/filesystem.Filesystem/Stat",
                json={"path": f"/workspace/{task_id}"},
                headers={"Connect-Protocol-Version": "1"},
            )
    except httpx.HTTPError as exc:
        logger.warning(
            "[remote_workspace] root query failed task_id=%s error=%s", task_id, exc
        )
        raise HTTPException(503, "Failed to resolve remote workspace") from exc

    if response.status_code == 404:
        raise HTTPException(404, "Workspace directory not found")
    if response.is_error:
        raise HTTPException(502, "Failed to resolve remote workspace")
    try:
        payload = response.json()
    except ValueError as exc:
        raise HTTPException(502, "Invalid workspace root response") from exc
    entry = payload.get("entry") if isinstance(payload, dict) else None
    path = entry.get("path") if isinstance(entry, dict) else None
    if (
        not isinstance(path, str)
        or not path.startswith("/")
        or path.startswith("//")
        or posixpath.normpath(path) != path
        or path == "/"
        or entry.get("type") != "FILE_TYPE_DIRECTORY"
    ):
        raise HTTPException(502, "Invalid workspace root response")
    return path
