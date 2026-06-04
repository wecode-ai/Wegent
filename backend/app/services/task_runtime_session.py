# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Helpers for task runtime session metadata stored in Task CRD status."""

from datetime import datetime
from typing import Any, Optional

from sqlalchemy.orm.attributes import flag_modified

from app.models.task import TaskResource

CODEX_RUNTIME_PROVIDER = "codex"


class RuntimeSessionAlreadyExistsError(ValueError):
    """Raised when a task already has a different runtime session ID."""


def normalize_runtime_provider(provider: str) -> str:
    """Normalize a runtime provider key for status.runtime.sessions."""
    normalized = str(provider or "").strip().lower()
    if not normalized:
        raise ValueError("Runtime provider is required")
    return normalized


def get_task_runtime_session_id(
    task: TaskResource,
    provider: str = CODEX_RUNTIME_PROVIDER,
) -> Optional[str]:
    """Return the stored runtime session ID for a task and provider."""
    task_json = task.json if isinstance(task.json, dict) else {}
    status = (
        task_json.get("status") if isinstance(task_json.get("status"), dict) else {}
    )
    runtime = status.get("runtime") if isinstance(status.get("runtime"), dict) else {}
    sessions = (
        runtime.get("sessions") if isinstance(runtime.get("sessions"), dict) else {}
    )
    session = sessions.get(normalize_runtime_provider(provider))
    if not isinstance(session, dict):
        return None
    session_id = session.get("id")
    return str(session_id) if session_id else None


def _normalize_session_response(
    provider: str,
    session: dict[str, Any],
) -> dict[str, Any]:
    return {
        "provider": str(session.get("provider") or provider),
        "id": str(session["id"]),
        "updatedAt": str(session.get("updatedAt") or ""),
    }


def _ensure_child_dict(parent: dict[str, Any], key: str) -> dict[str, Any]:
    child = parent.get(key)
    if isinstance(child, dict):
        return child
    child = {}
    parent[key] = child
    return child


def set_task_runtime_session(
    task: TaskResource,
    *,
    provider: str,
    session_id: str,
) -> dict[str, Any]:
    """Persist a runtime session ID into task.json.status.runtime.sessions.

    Registration is create-only: retrying the same session ID is idempotent, but
    attempting to replace an existing different ID is rejected.
    """
    normalized_provider = normalize_runtime_provider(provider)
    normalized_session_id = str(session_id or "").strip()
    if not normalized_session_id:
        raise ValueError("Runtime session ID is required")

    task_json = task.json if isinstance(task.json, dict) else {}
    status = _ensure_child_dict(task_json, "status")
    runtime = _ensure_child_dict(status, "runtime")
    sessions = _ensure_child_dict(runtime, "sessions")
    existing_session = sessions.get(normalized_provider)
    if isinstance(existing_session, dict):
        existing_session_id = str(existing_session.get("id") or "").strip()
        if existing_session_id == normalized_session_id:
            return _normalize_session_response(normalized_provider, existing_session)
        if existing_session_id:
            raise RuntimeSessionAlreadyExistsError(
                f"Runtime session already exists for provider {normalized_provider}"
            )

    now = datetime.now()
    session = {
        "provider": normalized_provider,
        "id": normalized_session_id,
        "updatedAt": now.isoformat(),
    }
    sessions[normalized_provider] = session

    task.json = task_json
    task.updated_at = now
    flag_modified(task, "json")
    return session
