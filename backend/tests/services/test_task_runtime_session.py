# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.models.task import TaskResource
from app.schemas.kind import Task
from app.services.task_runtime_session import (
    RuntimeSessionAlreadyExistsError,
    get_task_runtime_session_id,
    set_task_runtime_session,
)


def test_set_and_get_task_runtime_session():
    task = TaskResource(
        id=1664,
        user_id=1,
        kind="Task",
        name="task-1664",
        namespace="default",
        json={"status": {"status": "RUNNING"}},
    )

    session = set_task_runtime_session(
        task,
        provider="codex",
        session_id="019e90f8-83da-7f21-953b-5fe33183d1be",
    )

    assert session["provider"] == "codex"
    assert session["id"] == "019e90f8-83da-7f21-953b-5fe33183d1be"
    assert (
        task.json["status"]["runtime"]["sessions"]["codex"]["id"]
        == "019e90f8-83da-7f21-953b-5fe33183d1be"
    )
    assert (
        get_task_runtime_session_id(task, "codex")
        == "019e90f8-83da-7f21-953b-5fe33183d1be"
    )


def test_set_task_runtime_session_is_idempotent_for_same_id():
    task = TaskResource(
        id=1664,
        user_id=1,
        kind="Task",
        name="task-1664",
        namespace="default",
        json={"status": {"status": "RUNNING"}},
    )

    first = set_task_runtime_session(
        task,
        provider="codex",
        session_id="thread-1",
    )
    second = set_task_runtime_session(
        task,
        provider="codex",
        session_id="thread-1",
    )

    assert second == first
    assert task.json["status"]["runtime"]["sessions"]["codex"]["id"] == "thread-1"


def test_set_task_runtime_session_rejects_different_existing_id():
    task = TaskResource(
        id=1664,
        user_id=1,
        kind="Task",
        name="task-1664",
        namespace="default",
        json={"status": {"status": "RUNNING"}},
    )
    set_task_runtime_session(
        task,
        provider="codex",
        session_id="thread-1",
    )

    with pytest.raises(RuntimeSessionAlreadyExistsError):
        set_task_runtime_session(
            task,
            provider="codex",
            session_id="thread-2",
        )

    assert task.json["status"]["runtime"]["sessions"]["codex"]["id"] == "thread-1"


def test_set_task_runtime_session_replaces_null_runtime():
    task = TaskResource(
        id=1682,
        user_id=1,
        kind="Task",
        name="task-1682",
        namespace="default",
        json={"status": {"status": "RUNNING", "runtime": None}},
    )

    set_task_runtime_session(
        task,
        provider="codex",
        session_id="thread-1",
    )

    assert task.json["status"]["runtime"]["sessions"]["codex"]["id"] == "thread-1"


def test_task_schema_preserves_runtime_session():
    task_json = {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "task-1664", "namespace": "default"},
        "spec": {
            "title": "Task 1664",
            "prompt": "hello",
            "teamRef": {"name": "team", "namespace": "default"},
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {
            "status": "RUNNING",
            "runtime": {
                "sessions": {
                    "codex": {
                        "provider": "codex",
                        "id": "019e90f8-83da-7f21-953b-5fe33183d1be",
                        "updatedAt": "2026-06-04T10:00:00",
                    }
                }
            },
        },
    }

    dumped = Task.model_validate(task_json).model_dump(mode="json")

    assert (
        dumped["status"]["runtime"]["sessions"]["codex"]["id"]
        == "019e90f8-83da-7f21-953b-5fe33183d1be"
    )
