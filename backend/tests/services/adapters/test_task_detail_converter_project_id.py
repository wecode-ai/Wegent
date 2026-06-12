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

from app.models.task import TaskResource
from app.schemas.kind import Task as TaskCrd
from app.services.adapters.task_kinds.converters import (
    convert_to_task_dict,
    convert_to_task_dict_optimized,
)


def _task_crd() -> dict:
    return {
        "apiVersion": "agent.wecode.io/v1",
        "kind": "Task",
        "metadata": {
            "name": "demo",
            "namespace": "default",
            "labels": {"taskType": "chat", "type": "online"},
        },
        "spec": {
            "title": "Demo",
            "prompt": "hello",
            "teamRef": {"name": "team-a", "namespace": "default"},
            "workspaceRef": {"name": "workspace-a", "namespace": "default"},
            "knowledgeBaseRefs": [],
        },
        "status": {"status": "RUNNING", "progress": 0},
    }


def _build_kind_task(project_id):
    task = Mock(spec=TaskResource)
    task.id = 42
    task.user_id = 1
    task.project_id = project_id
    task.client_origin = "wework"
    task.json = _task_crd()
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
