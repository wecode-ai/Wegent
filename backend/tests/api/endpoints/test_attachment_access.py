# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import ANY, Mock

from fastapi.testclient import TestClient

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType
from app.services.attachment.public_link import build_public_attachment_download_url
from app.services.context import context_service


def test_linked_attachment_access_uses_task_permission_not_uploader_owner(monkeypatch):
    context = SimpleNamespace(
        id=10,
        user_id=5,
        subtask_id=123,
        context_type=ContextType.ATTACHMENT.value,
    )
    current_user = SimpleNamespace(id=7)
    subtask = SimpleNamespace(task_id=99)
    get_by_id = Mock(return_value=subtask)
    check_task_access = Mock(return_value=True)

    monkeypatch.setattr(attachments.subtask_store, "get_by_id", get_by_id)
    monkeypatch.setattr(attachments, "_check_task_access", check_task_access)

    attachments._ensure_attachment_access(Mock(), context, current_user)

    get_by_id.assert_called_once_with(ANY, subtask_id=123)
    check_task_access.assert_called_once_with(ANY, 99, 7)


def test_signed_public_download_does_not_require_login(
    test_client: TestClient,
    test_db,
    test_user,
    monkeypatch,
):
    context, _ = context_service.upload_attachment(
        db=test_db,
        user_id=test_user.id,
        filename="reference.mp4",
        binary_data=b"video-content",
    )
    monkeypatch.setattr(
        attachments,
        "_load_stored_attachment_binary_data",
        lambda attachment_id: (
            b"video-content" if attachment_id == context.id else None
        ),
    )
    download_url = build_public_attachment_download_url(
        context.id,
        timedelta(hours=1),
    )

    response = test_client.get(download_url)

    assert response.status_code == 200
    assert response.content == b"video-content"
    assert response.headers["content-type"] == "video/mp4"


def test_attachment_http_round_trip_uses_isolated_worker_sessions(
    test_client: TestClient,
    test_token: str,
):
    headers = {"Authorization": f"Bearer {test_token}"}

    upload_response = test_client.post(
        "/api/attachments/upload",
        headers=headers,
        files={"file": ("reference.txt", b"reference", "text/plain")},
    )
    assert upload_response.status_code == 200
    attachment_id = upload_response.json()["id"]

    detail_response = test_client.get(
        f"/api/attachments/{attachment_id}",
        headers=headers,
    )
    assert detail_response.status_code == 200
    assert detail_response.json()["filename"] == "reference.txt"

    preview_response = test_client.get(
        f"/api/attachments/{attachment_id}/preview",
        headers=headers,
    )
    assert preview_response.status_code == 200
    assert preview_response.json()["preview_text"] == "reference"

    token_response = test_client.post(
        f"/api/attachments/{attachment_id}/download-token",
        headers=headers,
    )
    assert token_response.status_code == 200
    download_response = test_client.get(
        f"/api/attachments/{attachment_id}/download",
        params={"download_token": token_response.json()["download_token"]},
    )
    assert download_response.status_code == 200
    assert download_response.content == b"reference"

    delete_response = test_client.delete(
        f"/api/attachments/{attachment_id}",
        headers=headers,
    )
    assert delete_response.status_code == 200
