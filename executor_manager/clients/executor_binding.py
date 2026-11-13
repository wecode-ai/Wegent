# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Confirm a cloud executor's assignment before sending the turn to it."""

from typing import Any

from executor_manager.config.config import TASK_API_DOMAIN
from shared.models.openai_converter import get_metadata_field
from shared.utils.http_client import traced_sync_client

BINDING_TOKEN = "executor_binding_token"
BINDING_SCHEME = "WegentExecutorBinding"


class ObsoleteExecutorDispatch(Exception):
    """The backend no longer admits this queued execution turn."""


def bind_executor_for_dispatch(
    task: dict[str, Any], executor_name: str, executor_namespace: str
) -> dict[str, Any]:
    metadata = task.get("metadata")
    if not isinstance(metadata, dict) or BINDING_TOKEN not in metadata:
        # Requests already queued by an older backend have no binding credential.
        return task

    token = metadata[BINDING_TOKEN]
    if not isinstance(token, str) or not token:
        raise RuntimeError("Executor binding credential is invalid")

    task_id = int(get_metadata_field(task, "task_id"))
    subtask_id = int(get_metadata_field(task, "subtask_id"))
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

    runtime_metadata = metadata.copy()
    del runtime_metadata[BINDING_TOKEN]
    return {**task, "metadata": runtime_metadata}
