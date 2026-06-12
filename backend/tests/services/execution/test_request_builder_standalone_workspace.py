# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import Mock

from app.core.constants import CLIENT_ORIGIN_FRONTEND, CLIENT_ORIGIN_WEWORK
from app.models.task import TaskResource
from app.services.chat.standalone_workspace import (
    WORKSPACE_PATH_LABEL,
    WORKSPACE_SOURCE_LABEL,
)
from app.services.execution.request_builder import (
    TaskRequestBuilder,
    _is_wework_standalone_chat_project,
)


def test_wework_standalone_chat_project_flag_requires_wework_project_zero():
    task = Mock(spec=TaskResource)
    task.client_origin = CLIENT_ORIGIN_WEWORK

    assert _is_wework_standalone_chat_project(task, 0) is True
    assert _is_wework_standalone_chat_project(task, None) is False
    assert _is_wework_standalone_chat_project(task, 12) is False

    task.client_origin = CLIENT_ORIGIN_FRONTEND
    assert _is_wework_standalone_chat_project(task, 0) is False


def test_wework_standalone_chat_project_flag_handles_missing_client_origin():
    task = SimpleNamespace()

    assert _is_wework_standalone_chat_project(task, 0) is False


def test_merge_standalone_chat_workspace_from_task_labels():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.project_id = 0
    task.client_origin = CLIENT_ORIGIN_WEWORK
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
        "project_id": 0,
        "workspace_source": "local_path",
        "project_workspace_path": "/tmp/chats/2026-05-29/hello",
        "execution_target_type": "local",
        "device_id": None,
        "checkout_path": None,
        "local_path": "/tmp/chats/2026-05-29/hello",
    }


def test_merge_task_spec_execution_workspace_overrides_project_path():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.project_id = 12
    task.json = {
        "spec": {
            "device_id": "device-1",
            "execution": {
                "workspace": {
                    "source": "git_worktree",
                    "path": "/workspace/worktrees/1386/Wegent",
                }
            },
        }
    }
    workspace_data = {
        "repository": {},
        "branch": None,
        "path": None,
        "project": {
            "project_id": 12,
            "workspace_source": "git",
            "project_workspace_path": "projects/d837/Wegent",
            "execution_target_type": "local",
            "device_id": "device-1",
            "checkout_path": "d837/Wegent",
            "local_path": None,
        },
    }

    merged = builder._merge_task_spec_execution_workspace(task, workspace_data)

    assert merged is True
    assert workspace_data["project"] == {
        "project_id": 12,
        "workspace_source": "git_worktree",
        "project_workspace_path": "/workspace/worktrees/1386/Wegent",
        "execution_target_type": "local",
        "device_id": "device-1",
        "checkout_path": None,
        "local_path": "/workspace/worktrees/1386/Wegent",
    }


def test_merge_task_spec_execution_workspace_derives_git_worktree_path():
    builder = TaskRequestBuilder.__new__(TaskRequestBuilder)
    task = Mock(spec=TaskResource)
    task.id = 1386
    task.project_id = 12
    task.json = {
        "spec": {
            "device_id": "device-1",
            "execution": {
                "workspace": {
                    "source": "git_worktree",
                }
            },
        }
    }
    workspace_data = {
        "repository": {},
        "branch": None,
        "path": None,
        "project": {
            "project_id": 12,
            "workspace_source": "git",
            "project_workspace_path": "projects/d837/Wegent",
            "execution_target_type": "local",
            "device_id": "device-1",
            "checkout_path": "d837/Wegent",
            "local_path": None,
        },
    }

    merged = builder._merge_task_spec_execution_workspace(task, workspace_data)

    assert merged is True
    assert workspace_data["project"] == {
        "project_id": 12,
        "workspace_source": "git_worktree",
        "project_workspace_path": "worktrees/1386/Wegent",
        "execution_target_type": "local",
        "device_id": "device-1",
        "checkout_path": None,
        "local_path": "worktrees/1386/Wegent",
    }
