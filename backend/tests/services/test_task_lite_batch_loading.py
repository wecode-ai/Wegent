# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.task import TaskResource
from app.services.adapters.task_kinds.helpers import build_lite_task_list


def _task_json(title: str) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": title.lower().replace(" ", "-"),
            "namespace": "default",
            "labels": {"taskType": "chat", "type": "online"},
        },
        "spec": {
            "title": title,
            "prompt": "test",
            "teamRef": {"name": "team-a", "namespace": "default"},
            "workspaceRef": {"name": "workspace-a", "namespace": "default"},
            "knowledgeBaseRefs": [],
        },
        "status": {"status": "PENDING", "progress": 0},
    }


def _build_task(task_id: int, title: str) -> Mock:
    task = Mock(spec=TaskResource)
    task.id = task_id
    task.json = _task_json(title)
    now = datetime.now()
    task.created_at = now
    task.updated_at = now
    return task


@pytest.mark.unit
def test_build_lite_task_list_uses_batch_related_data_and_avoids_per_task_sql():
    db = Mock(spec=Session)

    mock_query = Mock()
    mock_query.filter.return_value = mock_query
    mock_query.group_by.return_value = mock_query
    mock_query.all.return_value = []
    db.query.return_value = mock_query

    mock_execute_result = Mock()
    mock_execute_result.fetchone.return_value = None
    db.execute.return_value = mock_execute_result

    tasks = [_build_task(1, "Task One"), _build_task(2, "Task Two")]
    now = datetime.now()
    related_data = {
        "1": {
            "workspace_data": {"git_repo": "repo-a"},
            "team_id": 101,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": True,
        },
        "2": {
            "workspace_data": {"git_repo": "repo-b"},
            "team_id": 102,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": False,
        },
    }

    with patch(
        "app.services.adapters.task_kinds.helpers.get_tasks_related_data_batch",
        return_value=related_data,
    ) as mock_batch:
        result = build_lite_task_list(db, tasks, user_id=7)

    assert len(result) == 2
    assert result[0]["team_id"] == 101
    assert result[0]["git_repo"] == "repo-a"
    assert result[0]["is_group_chat"] is True
    assert result[1]["team_id"] == 102
    assert result[1]["git_repo"] == "repo-b"
    assert result[1]["is_group_chat"] is False
    mock_batch.assert_called_once_with(db, tasks, 7)
    db.execute.assert_not_called()
