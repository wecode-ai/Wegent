# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock, patch

from app.services.shared_task import SharedTaskService


def _task_json() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {"name": "source-task", "namespace": "default", "labels": {}},
        "spec": {
            "title": "Source Task",
            "prompt": "hello",
            "teamRef": {
                "name": "source-agent",
                "namespace": "default",
                "user_id": 10,
            },
            "workspaceRef": {"name": "workspace", "namespace": "default"},
        },
        "status": {"phase": "completed"},
    }


def test_copy_shared_task_keeps_original_team_ref_and_subtask_team_id() -> None:
    service = SharedTaskService()
    db = Mock()
    query = Mock()
    query.filter.return_value = query
    query.first.return_value = SimpleNamespace(
        id=55,
        user_id=10,
        name="source-agent",
        namespace="default",
        is_active=True,
    )
    query.all.return_value = []
    db.query.return_value = query

    original_task = SimpleNamespace(
        id=1,
        user_id=10,
        kind="Task",
        name="source-task",
        namespace="default",
        json=_task_json(),
        client_origin="frontend",
    )
    original_subtask = SimpleNamespace(
        id=11,
        title="hello",
        bot_ids=[],
        role="user",
        executor_namespace="default",
        prompt="hello",
        message_id="m-1",
        parent_id=None,
        result="done",
        error_message=None,
        sender_type="user",
        sender_user_id=20,
        reply_to_subtask_id=None,
    )
    copied_task = SimpleNamespace(id=101)
    copied_subtask = SimpleNamespace(id=201)

    with patch.object(service, "_ensure_user_can_use_team") as ensure_access:
        with patch(
            "app.services.shared_task.task_store.create_task_resource",
            return_value=copied_task,
        ) as create_task:
            with patch(
                "app.services.shared_task.subtask_store.list_by_task_ordered",
                return_value=[original_subtask],
            ):
                with patch(
                    "app.services.shared_task.subtask_store.create_subtask",
                    return_value=copied_subtask,
                ) as create_subtask:
                    with patch(
                        "app.services.shared_task.subtask_store.update_fields",
                    ):
                        service._copy_task_with_subtasks(
                            db=db,
                            original_task=original_task,
                            new_user_id=20,
                            new_team_id=999,
                        )

    ensure_access.assert_called_once()
    payload = create_task.call_args.kwargs["payload"]
    assert payload["spec"]["teamRef"] == {
        "name": "source-agent",
        "namespace": "default",
        "user_id": 10,
    }
    assert create_subtask.call_args.kwargs["team_id"] == 55
