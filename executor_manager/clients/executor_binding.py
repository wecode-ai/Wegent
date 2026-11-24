# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Confirm a cloud executor's assignment before sending the turn to it."""

import os
from typing import Any

from executor_manager.config.config import TASK_API_DOMAIN
from shared.models.openai_converter import get_metadata_field
from shared.utils.http_client import traced_sync_client

BINDING_TOKEN = "executor_binding_token"
CALLBACK_TOKEN = "executor_callback_token"
BINDING_SCHEME = "WegentExecutorBinding"


def generate_callback_token() -> str:
    """Return a random credential scoped to one task callback stream."""
    return os.urandom(32).hex()


class ObsoleteExecutorDispatch(Exception):
    """The backend no longer admits this queued execution turn."""


def bind_executor_for_dispatch(
    task: dict[str, Any], executor_name: str, executor_namespace: str
) -> dict[str, Any]:
    task_id = int(get_metadata_field(task, "task_id"))
    metadata = task.get("metadata")
    if isinstance(metadata, dict) and BINDING_TOKEN in metadata:
        _confirm_executor_binding(
            task_id,
            int(get_metadata_field(task, "subtask_id")),
            metadata[BINDING_TOKEN],
            executor_name,
            executor_namespace,
        )

    # Older queued requests also need the credential provisioned with the container.
    require_callback_token(task_id)
    runtime_task = task.copy()
    for key in (CALLBACK_TOKEN, BINDING_TOKEN):
        runtime_task.pop(key, None)
    if isinstance(metadata, dict):
        runtime_task["metadata"] = metadata.copy()
        for key in (CALLBACK_TOKEN, BINDING_TOKEN):
            runtime_task["metadata"].pop(key, None)
    return runtime_task


def _confirm_executor_binding(
    task_id: int,
    subtask_id: int,
    token: Any,
    executor_name: str,
    executor_namespace: str,
) -> None:
    if not isinstance(token, str) or not token:
        raise RuntimeError("Executor binding credential is invalid")

    url = (
        f"{TASK_API_DOMAIN.rstrip('/')}/api/internal/tasks/{task_id}"
        f"/subtasks/{subtask_id}/executor-binding"
    )
    with traced_sync_client(timeout=5.0) as client:
        response = client.post(
            url,
            headers={"Authorization": f"Bearer {token}"},
            json={
                "executor_name": executor_name,
                "executor_namespace": executor_namespace,
            },
            follow_redirects=False,
        )
    if response.status_code == 410:
        raise ObsoleteExecutorDispatch("Execution turn is no longer dispatchable")
    if not response.is_success:
        raise RuntimeError(f"Executor binding failed with HTTP {response.status_code}")
    if response.json() != {"status": "bound"}:
        raise RuntimeError("Executor binding acknowledgement is invalid")


def require_callback_token(task_id: int) -> str:
    """Refuse reuse of a container whose callback credential is unavailable."""
    from executor_manager.services.sandbox.repository import get_sandbox_repository

    token = get_sandbox_repository().load_executor_callback_token(task_id)
    if not token:
        raise RuntimeError("Executor has no callback credential provisioned")
    return token


def prepare_callback_token(task_id: int, executor_name: str) -> str:
    """Return the callback credential for the task's prepared runtime."""
    from executor_manager.services.sandbox.repository import get_sandbox_repository

    callback_token = get_sandbox_repository().reserve_executor_callback_token(
        task_id, executor_name, generate_callback_token()
    )
    if not callback_token:
        raise RuntimeError("Could not persist executor callback credential")
    return callback_token
