# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.models.task import TaskResource
from app.schemas.task_fork import TaskForkRequest
from app.services.task_fork import task_fork_service


class _Db:
    def __init__(self, query_result=None):
        self.query_result = query_result
        self.committed = False
        self.refreshed = None

    def query(self, model):
        return _Query(self.query_result)

    def commit(self):
        self.committed = True

    def refresh(self, obj):
        self.refreshed = obj


class _Query:
    def __init__(self, result):
        self.result = result

    def filter(self, *conditions):
        return self

    def first(self):
        return self.result


def _task(
    task_id: int,
    *,
    status: str = "COMPLETED",
    user_id: int = 7,
    device_id: str | None = "mac",
    execution_source: str = "git_worktree",
    fork: dict | None = None,
) -> TaskResource:
    spec = {
        "title": "Original",
        "prompt": "Prompt",
        "teamRef": {"name": "team", "namespace": "default", "user_id": user_id},
        "workspaceRef": {"name": f"workspace-{task_id}", "namespace": "default"},
        "is_group_chat": False,
        "execution": {
            "workspace": {"source": execution_source, "path": "/tmp/worktree"}
        },
    }
    if device_id:
        spec["device_id"] = device_id
    if fork:
        spec["fork"] = fork
    return TaskResource(
        id=task_id,
        user_id=user_id,
        kind="Task",
        name=f"task-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {
                "name": f"task-{task_id}",
                "namespace": "default",
                "labels": {"taskType": "code"},
            },
            "spec": spec,
            "status": {
                "state": "Available",
                "status": status,
                "createdAt": datetime.now().isoformat(),
            },
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
        project_id=3,
    )


def _workspace(task_id: int) -> TaskResource:
    return TaskResource(
        id=100 + task_id,
        user_id=7,
        kind="Workspace",
        name=f"workspace-{task_id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Workspace",
            "metadata": {"name": f"workspace-{task_id}", "namespace": "default"},
            "spec": {
                "repository": {
                    "gitUrl": "git@example.com:repo.git",
                    "gitRepo": "repo",
                    "gitRepoId": 3,
                    "gitDomain": "example.com",
                    "branchName": "main",
                }
            },
            "status": {"state": "Available"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
    )


def _patch_common(monkeypatch, source, *, created=None, history=None, workspace=None):
    created_task = created or _task(2)
    captured = {}

    monkeypatch.setattr(
        "app.services.task_fork.task_store.get_active_non_deleted_task",
        lambda db, *, task_id, owner_user_id=None, client_origin=None: source,
    )
    monkeypatch.setattr(
        "app.services.task_fork.task_access_store.is_member",
        lambda db, *, task_id, user_id: True,
    )
    monkeypatch.setattr(
        "app.services.task_fork.task_fork_history_resolver.resolve_for_task",
        lambda db, *, task_id, user_id: history or [],
    )
    monkeypatch.setattr(
        "app.services.task_fork.task_store.get_workspace_by_ref",
        lambda db, *, user_id, name, namespace: workspace,
    )

    def create_pending(
        db,
        *,
        user_id,
        client_origin,
        workspace_factory,
        is_group_chat=False,
        project_id=0,
    ):
        captured["create_kwargs"] = {
            "user_id": user_id,
            "client_origin": client_origin,
            "is_group_chat": is_group_chat,
            "project_id": project_id,
        }
        captured["workspace"] = workspace_factory(created_task.id)
        return created_task, SimpleNamespace()

    monkeypatch.setattr(
        "app.services.task_fork.task_store.create_pending_task_shell_with_workspace",
        create_pending,
    )
    monkeypatch.setattr(
        "app.services.task_fork.task_store.update_json",
        lambda db, *, task, payload: setattr(task, "json", payload) or task,
    )
    return captured, created_task


def test_fork_rejects_running_source(monkeypatch):
    source = _task(1, status="RUNNING")
    monkeypatch.setattr(
        "app.services.task_fork.task_store.get_active_non_deleted_task",
        lambda db, *, task_id, owner_user_id=None, client_origin=None: source,
    )
    monkeypatch.setattr(
        "app.services.task_fork.task_access_store.is_member",
        lambda db, *, task_id, user_id: True,
    )

    with pytest.raises(HTTPException) as exc:
        task_fork_service.fork_task(
            db=_Db(),
            source_task_id=1,
            user_id=7,
            request=TaskForkRequest.model_validate({"target": {"type": "managed"}}),
            client_origin="wework",
        )

    assert exc.value.status_code == 409
    assert exc.value.detail == "task_is_running"


def test_managed_fork_clears_device_copies_workspace_and_writes_fork_metadata(
    monkeypatch,
):
    source = _task(
        1,
        fork={"sourceTaskId": 10, "afterMessageId": 2, "rootTaskId": 10},
    )
    history = [
        SimpleNamespace(subtask=SimpleNamespace(message_id=4)),
        SimpleNamespace(subtask=SimpleNamespace(message_id=6)),
    ]
    captured, created = _patch_common(
        monkeypatch,
        source,
        history=history,
        workspace=_workspace(1),
    )

    result = task_fork_service.fork_task(
        db=_Db(),
        source_task_id=1,
        user_id=7,
        request=TaskForkRequest.model_validate({"target": {"type": "managed"}}),
        client_origin="wework",
    )

    assert result.id == created.id
    assert result.json["metadata"]["name"] == "task-2"
    assert result.json["spec"]["fork"] == {
        "sourceTaskId": 1,
        "afterMessageId": 6,
        "rootTaskId": 10,
    }
    assert result.json["spec"]["workspaceRef"] == {
        "name": "workspace-2",
        "namespace": "default",
    }
    assert "device_id" not in result.json["spec"]
    assert captured["workspace"][0:2] == ("workspace-2", "default")
    assert captured["workspace"][2]["spec"]["repository"]["gitRepo"] == "repo"
    assert captured["workspace"][2]["metadata"]["labels"] == {"forkedFromTaskId": "1"}


def test_device_fork_sets_selected_online_device(monkeypatch):
    source = _task(1, device_id=None)
    _patch_common(monkeypatch, source, history=[])
    device = SimpleNamespace(json={"spec": {"status": "online"}})

    result = task_fork_service.fork_task(
        db=_Db(query_result=device),
        source_task_id=1,
        user_id=7,
        request=TaskForkRequest.model_validate(
            {"target": {"type": "device", "device_id": "macbook"}}
        ),
        client_origin="wework",
    )

    assert result.json["spec"]["device_id"] == "macbook"


def test_device_fork_rejects_offline_device(monkeypatch):
    source = _task(1, device_id=None)
    _patch_common(monkeypatch, source, history=[])
    device = SimpleNamespace(json={"spec": {"status": "offline"}})

    with pytest.raises(HTTPException) as exc:
        task_fork_service.fork_task(
            db=_Db(query_result=device),
            source_task_id=1,
            user_id=7,
            request=TaskForkRequest.model_validate(
                {"target": {"type": "device", "device_id": "macbook"}}
            ),
            client_origin="wework",
        )

    assert exc.value.status_code == 409
    assert exc.value.detail == "device_offline"


def test_managed_fork_rejects_local_path_workspace(monkeypatch):
    source = _task(1, execution_source="local_path")
    _patch_common(monkeypatch, source, history=[])

    with pytest.raises(HTTPException) as exc:
        task_fork_service.fork_task(
            db=_Db(),
            source_task_id=1,
            user_id=7,
            request=TaskForkRequest.model_validate({"target": {"type": "managed"}}),
            client_origin="wework",
        )

    assert exc.value.status_code == 409
    assert exc.value.detail == "workspace_not_available_for_target"
