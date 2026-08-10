# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import timedelta
from types import SimpleNamespace
from unittest.mock import ANY, Mock

from fastapi.testclient import TestClient

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType
from app.services.attachment.public_link import generate_public_attachment_token
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
):
    context, _ = context_service.upload_attachment(
        db=test_db,
        user_id=test_user.id,
        filename="reference.mp4",
        binary_data=b"video-content",
    )
    token = generate_public_attachment_token(context.id, timedelta(minutes=1))

    response = test_client.get(
        "/api/attachments/download/shared",
        params={"token": token},
    )

    assert response.status_code == 200
    assert response.content == b"video-content"
    assert response.headers["content-type"] == "video/mp4"
