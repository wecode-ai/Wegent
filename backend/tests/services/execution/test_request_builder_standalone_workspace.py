# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock

from app.models.task import TaskResource
from app.services.chat.standalone_workspace import (
    WORKSPACE_PATH_LABEL,
    WORKSPACE_SOURCE_LABEL,
)
from app.services.execution import request_builder
from app.services.execution.request_builder import TaskRequestBuilder


def test_merge_standalone_chat_workspace_from_task_labels():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.json = {
        "metadata": {
            "labels": {
                WORKSPACE_PATH_LABEL: "/tmp/chats/2026-05-29/hello",
                WORKSPACE_SOURCE_LABEL: "local_path",
            }
        }
    }
    workspace_data = {"repository": {}, "branch": None, "path": None}

    builder._merge_standalone_chat_workspace(task, workspace_data)

    assert workspace_data["project"] == {
        "project_id": None,
        "workspace_source": "local_path",
        "project_workspace_path": "/tmp/chats/2026-05-29/hello",
        "execution_target_type": "local",
        "device_id": None,
        "checkout_path": None,
        "local_path": "/tmp/chats/2026-05-29/hello",
    }


def test_merge_task_execution_workspace_uses_task_workspace_when_standalone_disabled(
    monkeypatch,
):
    monkeypatch.setattr(
        request_builder.settings,
        "CHAT_STANDALONE_WORKSPACE_ENABLED",
        False,
        raising=False,
    )
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.id = 1234
    task.project_id = 0
    task.json = {"metadata": {"labels": {}}}
    workspace_data = {"repository": {}, "branch": None, "path": None}

    builder._merge_task_execution_workspace(task, workspace_data)

    assert workspace_data["project"] == {
        "project_id": None,
        "workspace_source": "local_path",
        "project_workspace_path": "1234",
        "execution_target_type": "local",
        "device_id": None,
        "checkout_path": None,
        "local_path": "1234",
    }


def test_merge_task_execution_workspace_preserves_existing_standalone_path_when_disabled(
    monkeypatch,
):
    monkeypatch.setattr(
        request_builder.settings,
        "CHAT_STANDALONE_WORKSPACE_ENABLED",
        False,
    )
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.id = 1234
    task.project_id = 0
    task.json = {
        "metadata": {
            "labels": {
                WORKSPACE_PATH_LABEL: "/tmp/chats/2026-05-29/hello",
                WORKSPACE_SOURCE_LABEL: "local_path",
            }
        }
    }
    workspace_data = {"repository": {}, "branch": None, "path": None}

    builder._merge_task_execution_workspace(task, workspace_data)

    assert workspace_data["project"] == {
        "project_id": None,
        "workspace_source": "local_path",
        "project_workspace_path": "/tmp/chats/2026-05-29/hello",
        "execution_target_type": "local",
        "device_id": None,
        "checkout_path": None,
        "local_path": "/tmp/chats/2026-05-29/hello",
    }


def test_merge_task_execution_workspace_does_not_override_git_workspace_when_disabled(
    monkeypatch,
):
    monkeypatch.setattr(
        request_builder.settings,
        "CHAT_STANDALONE_WORKSPACE_ENABLED",
        False,
    )
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.id = 1234
    task.project_id = 0
    task.json = {"metadata": {"labels": {}}}
    workspace_data = {
        "repository": {"gitUrl": "https://example.com/acme/repo.git"},
        "branch": "main",
        "path": None,
    }

    builder._merge_task_execution_workspace(task, workspace_data)

    assert "project" not in workspace_data
