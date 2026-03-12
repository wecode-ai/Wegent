# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

import pytest
from fastapi import HTTPException

from app.services.remote_workspace_service import RemoteWorkspaceService


def test_list_tree_rejects_parent_escape():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")

    with pytest.raises(HTTPException) as exc:
        service.list_tree(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/../etc",
        )

    assert exc.value.status_code == 400


def test_list_tree_allows_workspace_subpath():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": "default"},
        ]
    }
    list_dir_payload = [
        {
            "name": "main.py",
            "path": "/workspace/src/main.py",
            "is_directory": False,
            "size": 128,
            "modified_at": "2026-03-11T10:00:00Z",
        }
    ]

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox"},
        ),
        patch.object(service, "_list_directory", return_value=list_dir_payload),
    ):
        result = service.list_tree(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/src",
        )

    assert result.path == "/home/user/src"
    assert len(result.entries) == 1
    assert result.entries[0].name == "main.py"


def test_list_tree_allows_executor_runtime_fallback():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": ""},
        ]
    }
    list_dir_payload = [
        {
            "name": "src",
            "path": "/workspace/src",
            "is_directory": True,
            "size": 0,
            "modified_at": "2026-03-11T10:00:00Z",
        }
    ]

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_get_executor_payload",
            return_value={"status": "success", "base_url": "http://executor-runtime"},
        ),
        patch.object(service, "_list_directory", return_value=list_dir_payload),
    ):
        result = service.list_tree(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace",
        )

    assert result.path == "/workspace/1"
    assert len(result.entries) == 1
    assert result.entries[0].name == "src"


def test_list_tree_allows_sandbox_runtime_without_executor_binding():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "", "executor_namespace": ""},
        ]
    }
    list_dir_payload = [
        {
            "name": "README.md",
            "path": "/workspace/README.md",
            "is_directory": False,
            "size": 64,
            "modified_at": "2026-03-11T10:00:00Z",
        }
    ]

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox-runtime"},
        ),
        patch.object(
            service, "_list_directory", return_value=list_dir_payload
        ) as list_tree_mock,
    ):
        result = service.list_tree(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/home/user",
        )

    assert result.path == "/home/user"
    assert len(result.entries) == 1
    assert result.entries[0].name == "README.md"
    list_tree_mock.assert_called_once_with(
        task_id=1, executor_name=None, path="/home/user"
    )
