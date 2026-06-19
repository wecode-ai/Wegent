# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.kind import Task, TaskForkSpec
from app.schemas.task_fork import (
    DeviceTaskForkTarget,
    ManagedTaskForkTarget,
    TaskForkRequest,
)


def test_task_fork_spec_round_trips_camel_case_fields():
    spec = TaskForkSpec(sourceTaskId=10, afterMessageId=6, rootTaskId=3)

    assert spec.model_dump(mode="json") == {
        "sourceTaskId": 10,
        "afterMessageId": 6,
        "rootTaskId": 3,
    }


def test_task_crd_accepts_optional_fork_metadata():
    task = Task.model_validate(
        {
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": "task-2", "namespace": "default"},
            "spec": {
                "title": "Fork",
                "prompt": "hello",
                "teamRef": {"name": "team", "namespace": "default"},
                "workspaceRef": {"name": "workspace-2", "namespace": "default"},
                "fork": {
                    "sourceTaskId": 1,
                    "afterMessageId": 4,
                    "rootTaskId": 1,
                },
            },
            "status": {"state": "Available", "status": "COMPLETED"},
        }
    )

    assert task.spec.fork is not None
    assert task.spec.fork.sourceTaskId == 1
    assert task.spec.fork.afterMessageId == 4
    assert task.spec.fork.rootTaskId == 1


def test_managed_fork_target_parses_without_device_id():
    request = TaskForkRequest.model_validate({"target": {"type": "managed"}})

    assert isinstance(request.target, ManagedTaskForkTarget)
    assert request.target.type == "managed"


def test_device_fork_target_requires_device_id():
    request = TaskForkRequest.model_validate(
        {"target": {"type": "device", "device_id": "macbook"}}
    )

    assert isinstance(request.target, DeviceTaskForkTarget)
    assert request.target.device_id == "macbook"
