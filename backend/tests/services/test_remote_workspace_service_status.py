# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

from app.services.remote_workspace_service import RemoteWorkspaceService


def test_status_connected_and_available():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": "default"},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox"},
        ),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is True
    assert status.root_path == "/home/user"
    assert status.reason is None


def test_status_connected_but_unavailable():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": "default"},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "pending", "base_url": None},
        ),
        patch.object(service, "_get_executor_payload", return_value=None),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is False
    assert status.reason == "sandbox_not_running"


def test_status_connected_with_empty_namespace():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": ""},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "pending", "base_url": None},
        ),
        patch.object(service, "_get_executor_payload", return_value=None),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is False
    assert status.reason == "sandbox_not_running"


def test_status_connected_and_available_via_executor():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "executor-1", "executor_namespace": ""},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_get_executor_payload",
            return_value={"status": "success", "base_url": "http://executor-runtime"},
        ),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is True
    assert status.root_path == "/workspace/1"
    assert status.reason is None


def test_status_connected_and_available_via_sandbox_without_executor_binding():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "", "executor_namespace": ""},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox-runtime"},
        ),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is True
    assert status.root_path == "/home/user"
    assert status.reason is None


def test_status_not_connected_without_executor_and_sandbox():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "", "executor_namespace": ""},
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is False
    assert status.available is False
    assert status.root_path == "/workspace/1"
    assert status.reason == "not_connected"
