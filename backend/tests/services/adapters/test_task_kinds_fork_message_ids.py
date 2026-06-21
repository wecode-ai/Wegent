# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

from app.services.adapters.task_kinds import helpers


def _task(task_id: int) -> SimpleNamespace:
    return SimpleNamespace(
        id=task_id,
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Task",
            "metadata": {"name": f"task-{task_id}", "namespace": "default"},
            "spec": {
                "title": "Forked task",
                "prompt": "Prompt",
                "teamRef": {"name": "team", "namespace": "default", "user_id": 7},
                "workspaceRef": {
                    "name": f"workspace-{task_id}",
                    "namespace": "default",
                },
            },
            "status": {"state": "Available", "status": "COMPLETED"},
        },
    )


def _team() -> SimpleNamespace:
    return SimpleNamespace(
        id=1256,
        user_id=7,
        name="team",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "Team",
            "metadata": {"name": "team", "namespace": "default"},
            "spec": {
                "collaborationModel": "coordinate",
                "members": [{"botRef": {"name": "bot", "namespace": "default"}}],
            },
            "status": {"state": "Available"},
        },
    )


def test_create_subtasks_uses_fork_history_next_message_id(monkeypatch):
    calls = {}

    monkeypatch.setattr(
        helpers,
        "task_fork_history_resolver",
        SimpleNamespace(
            resolve_for_task=lambda db, *, task_id, user_id: [],
            get_next_message_id=lambda db, *, task_id, user_id: 9,
        ),
        raising=False,
    )
    monkeypatch.setattr(
        helpers.kindReader,
        "get_by_name_and_namespace",
        lambda db, user_id, kind_type, namespace, name: SimpleNamespace(id=1255),
    )

    def create_pair(db, **kwargs):
        calls.update(kwargs)

    monkeypatch.setattr(
        helpers.task_stores.subtask_store,
        "create_user_and_assistant_subtasks",
        create_pair,
    )

    helpers.create_subtasks(
        db=None,
        task=_task(1385),
        team=_team(),
        user_id=7,
        user_prompt="continue",
    )

    assert calls["user_message_id"] == 9
    assert calls["user_parent_id"] == 8
    assert calls["assistant_message_id"] == 10
    assert calls["assistant_parent_id"] == 9
