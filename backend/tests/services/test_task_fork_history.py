# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime

import pytest

from app.models.subtask import Subtask, SubtaskRole, SubtaskStatus
from app.models.task import TaskResource
from app.services.task_fork_history import task_fork_history_resolver


def _task(task_id: int, user_id: int, fork: dict | None = None) -> TaskResource:
    spec = {
        "title": f"task-{task_id}",
        "prompt": "prompt",
        "teamRef": {"name": "team", "namespace": "default"},
        "workspaceRef": {"name": f"workspace-{task_id}", "namespace": "default"},
    }
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
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": spec,
            "status": {"state": "Available", "status": "COMPLETED"},
        },
        is_active=TaskResource.STATE_ACTIVE,
        client_origin="wework",
    )


def _subtask(
    subtask_id: int,
    task_id: int,
    user_id: int,
    message_id: int,
    role: SubtaskRole,
) -> Subtask:
    return Subtask(
        id=subtask_id,
        task_id=task_id,
        user_id=user_id,
        team_id=1,
        title=f"message-{message_id}",
        role=role,
        prompt=f"prompt-{message_id}" if role == SubtaskRole.USER else None,
        result=(
            {"value": f"answer-{message_id}"} if role == SubtaskRole.ASSISTANT else None
        ),
        message_id=message_id,
        parent_id=max(message_id - 1, 0),
        status=SubtaskStatus.COMPLETED,
        progress=100,
        bot_ids=[1],
        created_at=datetime(2026, 1, 1),
        updated_at=datetime(2026, 1, 1),
    )


def test_resolve_for_plain_task_returns_local_history(monkeypatch):
    root = _task(1, 7)
    local = [_subtask(1, 1, 7, 1, SubtaskRole.USER)]

    monkeypatch.setattr(
        "app.services.task_fork_history.task_store.get_by_id",
        lambda db, task_id, owner_user_id=None: root if task_id == 1 else None,
    )
    monkeypatch.setattr(
        "app.services.task_fork_history.subtask_store.list_by_task_ordered",
        lambda db, task_id, owner_user_id=None: local if task_id == 1 else [],
    )

    items = task_fork_history_resolver.resolve_for_task(
        db=None,
        task_id=1,
        user_id=7,
    )

    assert [item.subtask.id for item in items] == [1]
    assert items[0].inherited is False
    assert items[0].origin_task_id == 1


def test_resolve_for_fork_uses_parent_cutoff(monkeypatch):
    root = _task(1, 7)
    fork = _task(
        2,
        7,
        fork={"sourceTaskId": 1, "afterMessageId": 2, "rootTaskId": 1},
    )
    subtasks = {
        1: [
            _subtask(1, 1, 7, 1, SubtaskRole.USER),
            _subtask(2, 1, 7, 2, SubtaskRole.ASSISTANT),
            _subtask(3, 1, 7, 3, SubtaskRole.USER),
        ],
        2: [_subtask(4, 2, 7, 3, SubtaskRole.USER)],
    }

    monkeypatch.setattr(
        "app.services.task_fork_history.task_store.get_by_id",
        lambda db, task_id, owner_user_id=None: {1: root, 2: fork}.get(task_id),
    )
    monkeypatch.setattr(
        "app.services.task_fork_history.subtask_store.list_by_task_ordered",
        lambda db, task_id, owner_user_id=None: subtasks[task_id],
    )

    items = task_fork_history_resolver.resolve_for_task(
        db=None,
        task_id=2,
        user_id=7,
    )

    assert [
        (item.origin_task_id, item.subtask.message_id, item.inherited) for item in items
    ] == [
        (1, 1, True),
        (1, 2, True),
        (2, 3, False),
    ]


def test_resolve_for_fork_uses_parent_task_owner(monkeypatch):
    root = _task(1, 8)
    fork = _task(
        2,
        7,
        fork={"sourceTaskId": 1, "afterMessageId": 1, "rootTaskId": 1},
    )
    calls = []
    subtasks = {
        1: [_subtask(1, 1, 8, 1, SubtaskRole.USER)],
        2: [_subtask(2, 2, 7, 2, SubtaskRole.USER)],
    }

    def get_by_id(_db, *, task_id, owner_user_id=None):
        calls.append((task_id, owner_user_id))
        if task_id == 2 and owner_user_id == 7:
            return fork
        if task_id == 1 and owner_user_id is None:
            return root
        return None

    monkeypatch.setattr(
        "app.services.task_fork_history.task_store.get_by_id",
        get_by_id,
    )
    monkeypatch.setattr(
        "app.services.task_fork_history.subtask_store.list_by_task_ordered",
        lambda db, task_id, owner_user_id=None: (
            subtasks[task_id] if owner_user_id in {7, 8} else []
        ),
    )

    items = task_fork_history_resolver.resolve_for_task(
        db=None,
        task_id=2,
        user_id=7,
    )

    assert calls == [(2, 7), (1, None)]
    assert [
        (item.origin_task_id, item.subtask.user_id, item.subtask.message_id)
        for item in items
    ] == [(1, 8, 1), (2, 7, 2)]


def test_next_message_id_uses_inherited_boundary(monkeypatch):
    fork = _task(
        2,
        7,
        fork={"sourceTaskId": 1, "afterMessageId": 8, "rootTaskId": 1},
    )

    monkeypatch.setattr(
        "app.services.task_fork_history.task_store.get_by_id",
        lambda db, task_id, owner_user_id=None: fork,
    )
    monkeypatch.setattr(
        "app.services.task_fork_history.subtask_store.get_next_message_id",
        lambda db, task_id, owner_user_id=None: 1,
    )

    assert (
        task_fork_history_resolver.get_next_message_id(None, task_id=2, user_id=7) == 9
    )


def test_resolver_rejects_cycles(monkeypatch):
    task = _task(
        1,
        7,
        fork={"sourceTaskId": 1, "afterMessageId": 1, "rootTaskId": 1},
    )

    monkeypatch.setattr(
        "app.services.task_fork_history.task_store.get_by_id",
        lambda db, task_id, owner_user_id=None: task,
    )

    with pytest.raises(ValueError, match="cycle"):
        task_fork_history_resolver.resolve_for_task(None, task_id=1, user_id=7)
