# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for attachment sync protocol models."""

from shared.models import (
    AttachmentSyncRequest,
    AttachmentSyncResponse,
    ExecutionRequest,
)


def test_sync_request_from_execution_request_preserves_runtime_fields():
    request = ExecutionRequest(
        task_id=72,
        subtask_id=204,
        user_subtask_id=203,
        executor_name="wegent-task-user-abc",
        executor_namespace="default",
        executor_type="docker",
        auth_token="token",
        backend_url="http://backend:8000",
        skill_identity_token="identity-token",
        project_id=12,
        project_workspace_path="projects/demo",
        git_url="https://example.com/demo.git",
        executor_image="ghcr.io/wecode-ai/wegent-executor:latest",
        callback_url="http://executor-manager/executor-manager/callback",
        attachments=[
            {
                "id": 16,
                "original_filename": "frontend.zip",
                "mime_type": "application/zip",
                "file_size": 1024,
                "subtask_id": 203,
            }
        ],
    )

    sync_request = AttachmentSyncRequest.from_execution_request(request)
    payload = sync_request.to_dict()

    assert payload["task_id"] == 72
    assert payload["user_subtask_id"] == 203
    assert payload["executor_name"] == "wegent-task-user-abc"
    assert payload["project_workspace_path"] == "projects/demo"
    assert payload["callback_url"] == request.callback_url
    assert payload["attachments"] == [
        {
            "id": 16,
            "original_filename": "frontend.zip",
            "mime_type": "application/zip",
            "file_size": 1024,
            "subtask_id": 203,
        }
    ]


def test_sync_response_failed_for_request_marks_each_attachment():
    sync_request = AttachmentSyncRequest.from_dict(
        {
            "task_id": 72,
            "subtask_id": 204,
            "executorName": "wegent-task-user-abc",
            "attachments": [
                {"id": 16, "filename": "frontend.zip"},
                {"id": 17, "originalFilename": "broken.pdf"},
            ],
        }
    )

    response = AttachmentSyncResponse.failed_for_request(
        sync_request, "executor unavailable"
    )
    payload = response.to_dict()

    assert payload["executor_name"] == "wegent-task-user-abc"
    assert payload["success_count"] == 0
    assert payload["failed_count"] == 2
    assert payload["attachments"] == [
        {
            "id": 16,
            "original_filename": "frontend.zip",
            "status": "failed",
            "error": "executor unavailable",
        },
        {
            "id": 17,
            "original_filename": "broken.pdf",
            "status": "failed",
            "error": "executor unavailable",
        },
    ]


def test_sync_response_from_dict_accepts_enriched_attachment_payload():
    response = AttachmentSyncResponse.from_dict(
        {
            "task_id": 72,
            "subtask_id": 204,
            "executorName": "wegent-task-user-abc",
            "executorNamespace": "default",
            "attachments": [
                {
                    "id": 16,
                    "status": "success",
                    "originalFilename": "frontend.zip",
                    "localPath": "/workspace/demo/.wegent/attachments/72/203/frontend.zip",
                    "mimeType": "application/zip",
                    "fileSize": 1024,
                    "subtaskId": 203,
                }
            ],
        }
    )

    assert response.executor_name == "wegent-task-user-abc"
    assert response.executor_namespace == "default"
    assert response.success_count == 1
    assert response.failed_count == 0
    assert response.attachments[0].local_path.endswith("frontend.zip")
