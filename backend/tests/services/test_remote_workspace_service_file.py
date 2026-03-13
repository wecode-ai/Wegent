# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import Mock, patch

from app.services.remote_workspace_service import RemoteWorkspaceService


def test_stream_file_download_sets_attachment_disposition():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")

    with (
        patch.object(service, "_get_task_detail", return_value={"subtasks": []}),
        patch.object(
            service,
            "normalize_and_validate_workspace_path",
            return_value="/workspace/a.txt",
        ),
        patch.object(
            service, "_ensure_sandbox_available", return_value="http://sandbox"
        ),
        patch.object(
            service,
            "_download_file",
            return_value=(b"hello", "text/plain"),
        ),
    ):
        response = service.stream_file(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/a.txt",
            disposition="attachment",
        )

    assert "attachment" in response.headers["Content-Disposition"]


def test_stream_file_inline_sets_inline_disposition():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")

    with (
        patch.object(service, "_get_task_detail", return_value={"subtasks": []}),
        patch.object(
            service,
            "normalize_and_validate_workspace_path",
            return_value="/workspace/a.txt",
        ),
        patch.object(
            service, "_ensure_sandbox_available", return_value="http://sandbox"
        ),
        patch.object(
            service,
            "_download_file",
            return_value=(b"hello", "text/plain"),
        ),
    ):
        response = service.stream_file(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/a.txt",
            disposition="inline",
        )

    assert "inline" in response.headers["Content-Disposition"]


def test_stream_file_non_ascii_filename_uses_rfc5987_disposition():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")

    with (
        patch.object(service, "_get_task_detail", return_value={"subtasks": []}),
        patch.object(
            service,
            "normalize_and_validate_workspace_path",
            return_value="/home/user/出师表.txt",
        ),
        patch.object(
            service, "_ensure_sandbox_available", return_value="http://sandbox"
        ),
        patch.object(
            service,
            "_download_file",
            return_value=(b"hello", "text/plain"),
        ),
    ):
        response = service.stream_file(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/home/user/出师表.txt",
            disposition="attachment",
        )

    content_disposition = response.headers["Content-Disposition"]
    assert content_disposition.startswith("attachment;")
    assert "filename*=UTF-8''" in content_disposition
    assert "%E5%87%BA%E5%B8%88%E8%A1%A8.txt" in content_disposition


def test_stream_file_reads_running_sandbox_via_envd_files_endpoint():
    service = RemoteWorkspaceService(executor_manager_url="http://executor-manager")
    task_detail = {
        "subtasks": [
            {"executor_name": "", "executor_namespace": ""},
        ]
    }
    client = Mock()
    response = Mock()
    response.status_code = 200
    response.content = b"hello from sandbox"
    response.headers = {"content-type": "text/plain"}
    response.text = "hello from sandbox"
    client.get.return_value = response
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)

    with (
        patch.object(service, "_get_task_detail", return_value=task_detail),
        patch.object(
            service,
            "_get_sandbox_payload",
            return_value={"status": "running", "base_url": "http://sandbox-runtime"},
        ),
        patch(
            "app.services.remote_workspace_service.httpx.Client", return_value=client
        ),
    ):
        response = service.stream_file(
            db=Mock(),
            task_id=1,
            user_id=100,
            path="/workspace/README.md",
            disposition="inline",
        )

    assert response.media_type == "text/plain"
    client.get.assert_called_once_with(
        "http://sandbox-runtime/files",
        params={"path": "/home/user/README.md"},
    )
