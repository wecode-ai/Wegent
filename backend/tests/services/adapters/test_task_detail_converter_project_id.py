# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Regression tests for task detail converters exposing ``project_id``.

Both ``convert_to_task_dict`` and ``convert_to_task_dict_optimized`` must
include ``project_id`` in the returned payload so the frontend can correctly
classify opened tasks into projects vs. standalone conversations.
"""

from types import SimpleNamespace
from unittest.mock import Mock, patch

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.task import TaskResource
from app.schemas.kind import Task as TaskCrd
from app.services.adapters.task_kinds.converters import (
    convert_to_task_dict,
    convert_to_task_dict_optimized,
)


def _task_crd(
    execution_workspace: dict | None = None,
    external_knowledge_refs: list[dict] | None = None,
    team_user_id: int | None = None,
) -> dict:
    team_ref = {"name": "team-a", "namespace": "default"}
    if team_user_id is not None:
        team_ref["user_id"] = team_user_id
    spec = {
        "title": "Demo",
        "prompt": "hello",
        "teamRef": team_ref,
        "workspaceRef": {"name": "workspace-a", "namespace": "default"},
        "knowledgeBaseRefs": [],
    }
    if execution_workspace:
        spec["execution"] = {"workspace": execution_workspace}
    if external_knowledge_refs is not None:
        spec["externalKnowledgeRefs"] = external_knowledge_refs

    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "demo",
            "namespace": "default",
            "labels": {"taskType": "chat", "type": "online"},
        },
        "spec": spec,
        "status": {"status": "RUNNING", "progress": 0},
    }


def _build_kind_task(
    project_id,
    execution_workspace: dict | None = None,
    external_knowledge_refs: list[dict] | None = None,
    team_user_id: int | None = None,
):
    task = Mock(spec=TaskResource)
    task.id = 42
    task.user_id = 1
    task.project_id = project_id
    task.client_origin = "wework"
    task.json = _task_crd(
        execution_workspace, external_knowledge_refs, team_user_id=team_user_id
    )
    return task


@pytest.mark.unit
def test_convert_to_task_dict_includes_project_id_for_project_task():
    db = Mock(spec=Session)
    db.query.return_value.filter.return_value.first.return_value = None

    task = _build_kind_task(project_id=1821)

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.readers.users.userReader.get_by_id",
            return_value=SimpleNamespace(user_name="alice"),
        ),
    ):
        result = convert_to_task_dict(task, db, user_id=1)

    assert result["project_id"] == 1821


@pytest.mark.unit
def test_convert_to_task_dict_uses_task_team_ref_owner_when_names_overlap(test_db):
    public_team = Kind(
        user_id=0,
        kind="Team",
        name="team-a",
        namespace="default",
        json={},
        is_active=True,
    )
    personal_team = Kind(
        user_id=2,
        kind="Team",
        name="team-a",
        namespace="default",
        json={},
        is_active=True,
    )
    test_db.add_all([public_team, personal_team])
    test_db.commit()

    task = _build_kind_task(project_id=0, team_user_id=0)

    with patch(
        "app.services.readers.users.userReader.get_by_id",
        return_value=SimpleNamespace(user_name="alice"),
    ):
        result = convert_to_task_dict(task, test_db, user_id=2)

    assert result["team_id"] == public_team.id


@pytest.mark.unit
def test_convert_to_task_dict_includes_project_id_zero_for_standalone_task():
    db = Mock(spec=Session)
    db.query.return_value.filter.return_value.first.return_value = None

    task = _build_kind_task(project_id=0)

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.readers.users.userReader.get_by_id",
            return_value=SimpleNamespace(user_name="alice"),
        ),
    ):
        result = convert_to_task_dict(task, db, user_id=1)

    assert result["project_id"] == 0


@pytest.mark.unit
def test_convert_to_task_dict_normalizes_none_project_id_to_zero():
    db = Mock(spec=Session)
    db.query.return_value.filter.return_value.first.return_value = None

    task = _build_kind_task(project_id=None)

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.readers.users.userReader.get_by_id",
            return_value=SimpleNamespace(user_name="alice"),
        ),
    ):
        result = convert_to_task_dict(task, db, user_id=1)

    assert result["project_id"] == 0


@pytest.mark.unit
def test_convert_to_task_dict_includes_execution_workspace_path():
    db = Mock(spec=Session)
    db.query.return_value.filter.return_value.first.return_value = None
    task = _build_kind_task(
        project_id=1821,
        execution_workspace={
            "source": "git_worktree",
            "path": "/workspace/worktrees/42/Wegent",
        },
    )

    with (
        patch(
            "app.services.readers.kinds.kindReader.get_by_name_and_namespace",
            return_value=None,
        ),
        patch(
            "app.services.readers.users.userReader.get_by_id",
            return_value=SimpleNamespace(user_name="alice"),
        ),
    ):
        result = convert_to_task_dict(task, db, user_id=1)

    assert result["execution_workspace_source"] == "git_worktree"
    assert result["execution_workspace_path"] == "/workspace/worktrees/42/Wegent"


@pytest.mark.unit
def test_convert_to_task_dict_optimized_includes_project_id_for_project_task():
    task = _build_kind_task(project_id=1821)
    task_crd = TaskCrd.model_validate(task.json)
    related_data = {
        "workspace_data": {},
        "created_at": None,
        "updated_at": None,
        "completed_at": None,
        "is_group_chat": False,
    }

    result = convert_to_task_dict_optimized(task, related_data, task_crd)

    assert result["project_id"] == 1821


@pytest.mark.unit
def test_convert_to_task_dict_optimized_includes_project_id_zero_for_standalone_task():
    task = _build_kind_task(project_id=0)
    task_crd = TaskCrd.model_validate(task.json)
    related_data = {
        "workspace_data": {},
        "created_at": None,
        "updated_at": None,
        "completed_at": None,
        "is_group_chat": False,
    }

    result = convert_to_task_dict_optimized(task, related_data, task_crd)

    assert result["project_id"] == 0


@pytest.mark.unit
def test_convert_to_task_dict_optimized_includes_execution_workspace_path():
    task = _build_kind_task(
        project_id=1821,
        execution_workspace={
            "source": "git_worktree",
            "path": "/workspace/worktrees/42/Wegent",
        },
    )
    task_crd = TaskCrd.model_validate(task.json)
    related_data = {
        "workspace_data": {},
        "created_at": None,
        "updated_at": None,
        "completed_at": None,
        "is_group_chat": False,
    }

    result = convert_to_task_dict_optimized(task, related_data, task_crd)

    assert result["execution_workspace_source"] == "git_worktree"
    assert result["execution_workspace_path"] == "/workspace/worktrees/42/Wegent"


@pytest.mark.unit
def test_convert_to_task_dict_optimized_includes_external_knowledge_refs():
    task = _build_kind_task(
        project_id=1821,
        external_knowledge_refs=[
            {
                "provider": "demo",
                "mode": "explicit",
                "id": "kb-1",
                "name": "Demo KB",
                "scope": "organization",
            }
        ],
    )
    task_crd = TaskCrd.model_validate(task.json)
    related_data = {
        "workspace_data": {},
        "created_at": None,
        "updated_at": None,
        "completed_at": None,
        "is_group_chat": False,
    }

    result = convert_to_task_dict_optimized(task, related_data, task_crd)

    assert result["external_knowledge_refs"] == [
        {
            "provider": "demo",
            "mode": "explicit",
            "id": "kb-1",
            "name": "Demo KB",
            "scope": "organization",
        }
    ]
