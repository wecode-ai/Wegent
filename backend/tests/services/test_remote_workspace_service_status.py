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


def test_status_prefers_latest_non_deleted_executor_binding():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {
                "executor_name": "executor-old",
                "executor_namespace": "wegent-pod",
                "executor_deleted_at": False,
            },
            {
                "executor_name": "executor-new",
                "executor_namespace": "user-runtime",
                "executor_deleted_at": False,
            },
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_get_executor_payload",
            return_value={"status": "success", "base_url": "http://executor-runtime"},
        ) as get_executor_payload_mock,
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is True
    get_executor_payload_mock.assert_called_once_with(
        executor_name="executor-new",
        executor_namespace="user-runtime",
    )


def test_status_skips_deleted_executor_binding_when_resolving_runtime():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {
                "executor_name": "executor-active",
                "executor_namespace": "wegent-pod",
                "executor_deleted_at": False,
            },
            {
                "executor_name": "executor-deleted",
                "executor_namespace": "default",
                "executor_deleted_at": True,
            },
        ]
    }

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(service, "_get_sandbox_payload", return_value=None),
        patch.object(
            service,
            "_get_executor_payload",
            return_value={"status": "success", "base_url": "http://executor-runtime"},
        ) as get_executor_payload_mock,
    ):
        status = service.get_status(db=Mock(), task_id=1, user_id=100)

    assert status.connected is True
    assert status.available is True
    get_executor_payload_mock.assert_called_once_with(
        executor_name="executor-active",
        executor_namespace="wegent-pod",
    )


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
