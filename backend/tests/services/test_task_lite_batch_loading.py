# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.services.adapters.task_kinds.helpers import (
    _batch_query_teams,
    _get_team_display_name,
    _get_team_icon,
    build_lite_task_groups,
    build_lite_task_list,
)


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


def _team_json(name: str, display_name: str, icon: str) -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Team",
        "metadata": {
            "name": name,
            "namespace": "default",
            "displayName": display_name,
        },
        "spec": {
            "members": [],
            "collaborationModel": "solo",
            "description": "",
            "icon": icon,
        },
    }


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
            "team_name": "team-a",
            "team_namespace": "default",
            "team_display_name": "Agent A",
            "team_icon": "sparkles",
            "device_id": None,
            "device_name": None,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": True,
        },
        "2": {
            "workspace_data": {"git_repo": "repo-b"},
            "team_id": 102,
            "team_name": "team-b",
            "team_namespace": "default",
            "team_display_name": "Agent B",
            "team_icon": "bot",
            "device_id": "device-1",
            "device_name": "Mac Studio",
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
    assert result[0]["team_name"] == "team-a"
    assert result[0]["team_namespace"] == "default"
    assert result[0]["team_display_name"] == "Agent A"
    assert result[0]["team_icon"] == "sparkles"
    assert result[0]["device_id"] is None
    assert result[0]["device_name"] is None
    assert result[0]["git_repo"] == "repo-a"
    assert result[0]["is_group_chat"] is True
    assert result[1]["team_id"] == 102
    assert result[1]["team_name"] == "team-b"
    assert result[1]["team_namespace"] == "default"
    assert result[1]["team_display_name"] == "Agent B"
    assert result[1]["team_icon"] == "bot"
    assert result[1]["device_id"] == "device-1"
    assert result[1]["device_name"] == "Mac Studio"
    assert result[1]["git_repo"] == "repo-b"
    assert result[1]["is_group_chat"] is False
    mock_batch.assert_called_once_with(db, tasks, 7)
    db.execute.assert_not_called()


@pytest.mark.unit
def test_build_lite_task_groups_groups_current_page_by_team_metadata():
    db = Mock(spec=Session)
    tasks = [
        _build_task(1, "Task One"),
        _build_task(2, "Task Two"),
        _build_task(3, "Task Three"),
    ]
    now = datetime.now()
    related_data = {
        "1": {
            "workspace_data": {"git_repo": "repo-a"},
            "team_id": 101,
            "team_name": "team-a",
            "team_namespace": "default",
            "team_display_name": "Agent A",
            "team_icon": "sparkles",
            "device_id": None,
            "device_name": None,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": False,
        },
        "2": {
            "workspace_data": {"git_repo": "repo-b"},
            "team_id": 102,
            "team_name": "team-b",
            "team_namespace": "default",
            "team_display_name": "Agent B",
            "team_icon": "bot",
            "device_id": "device-1",
            "device_name": "Mac Studio",
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": False,
        },
        "3": {
            "workspace_data": {"git_repo": "repo-c"},
            "team_id": 101,
            "team_name": "team-a",
            "team_namespace": "default",
            "team_display_name": "Agent A",
            "team_icon": "sparkles",
            "device_id": None,
            "device_name": None,
            "created_at": now,
            "updated_at": now,
            "completed_at": None,
            "is_group_chat": False,
        },
    }

    with patch(
        "app.services.adapters.task_kinds.helpers.get_tasks_related_data_batch",
        return_value=related_data,
    ):
        groups = build_lite_task_groups(db, tasks, user_id=7)

    assert [group["group_type"] for group in groups] == ["team", "device"]
    assert [group["team_id"] for group in groups] == [101, None]
    assert groups[0]["team_display_name"] == "Agent A"
    assert groups[0]["team_icon"] == "sparkles"
    assert [item["id"] for item in groups[0]["items"]] == [1, 3]
    assert groups[1]["device_id"] == "device-1"
    assert groups[1]["device_name"] == "Mac Studio"
    assert groups[1]["team_icon"] is None
    assert [item["id"] for item in groups[1]["items"]] == [2]


@pytest.mark.unit
def test_batch_query_teams_includes_public_system_team_metadata(test_db):
    public_team = Kind(
        user_id=0,
        kind="Team",
        name="wegent-chat",
        namespace="default",
        json=_team_json("wegent-chat", "Wegent Chat", "users"),
        is_active=True,
    )
    test_db.add(public_team)
    test_db.commit()

    teams = _batch_query_teams(test_db, {("wegent-chat", "default")}, user_id=7)

    team = teams["wegent-chat:default"]
    assert team.user_id == 0
    assert _get_team_display_name(team) == "Wegent Chat"
    assert _get_team_icon(team) == "users"
