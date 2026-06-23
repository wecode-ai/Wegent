# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.models.task import TaskResource
from app.services.execution.request_builder import TaskRequestBuilder


def _task_with_fork_runtime(runtime: dict) -> TaskResource:
    return TaskResource(
        id=200,
        user_id=7,
        kind="Task",
        name="task-200",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "task-200", "namespace": "default"},
            "spec": {
                "title": "Fork",
                "prompt": "continue",
                "teamRef": {"name": "team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-200", "namespace": "default"},
                "fork": {
                    "sourceTaskId": 100,
                    "afterMessageId": 12,
                    "rootTaskId": 100,
                    "runtime": runtime,
                },
            },
            "status": {"state": "Available", "status": "COMPLETED"},
        },
    )


def test_request_builder_extracts_fork_runtime_and_inherited_sessions():
    runtime = {
        "workspace": {
            "sourceTaskId": 100,
            "archiveStorageKey": "workspace-archives/100/archive.tar.gz",
            "restoreRequired": True,
        },
        "sessions": [
            {
                "agent": "CodeX",
                "sourceTaskId": 100,
                "botId": 654,
                "threadId": "codex-thread",
            },
            "ignore-me",
        ],
    }

    fork_runtime = TaskRequestBuilder._extract_task_fork_runtime(
        _task_with_fork_runtime(runtime)
    )
    inherited_sessions = TaskRequestBuilder._extract_inherited_sessions(fork_runtime)

    assert fork_runtime == runtime
    assert inherited_sessions == [
        {
            "agent": "CodeX",
            "sourceTaskId": 100,
            "botId": 654,
            "threadId": "codex-thread",
        }
    ]
