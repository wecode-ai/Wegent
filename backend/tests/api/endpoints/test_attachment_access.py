# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import ANY, AsyncMock, Mock

import pytest
from fastapi import HTTPException

from app.api.endpoints.adapter import attachments
from app.models.subtask_context import ContextType
from app.services.attachment.action_authorizer import AttachmentAction


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


@pytest.mark.asyncio
async def test_share_token_metadata_does_not_run_export_authorizer(monkeypatch):
    authorize = AsyncMock()
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(
        attachments, "_validate_share_token_access", Mock(return_value=False)
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.get_attachment(
            attachment_id=10,
            share_token="invalid-token",
            db=Mock(),
            current_user=None,
        )

    assert exc_info.value.status_code == 403
    authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_share_token_preview_authorizes_after_token_and_attachment(monkeypatch):
    context = SimpleNamespace(id=10)
    authorize = AsyncMock(side_effect=HTTPException(status_code=403))
    validate = Mock(return_value=True)
    get_context = Mock(return_value=context)
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(attachments, "_validate_share_token_access", validate)
    monkeypatch.setattr(
        attachments.context_service, "get_context_optional", get_context
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.get_attachment_preview(
            attachment_id=10,
            share_token="valid-token",
            db=Mock(),
            current_user=None,
        )

    assert exc_info.value.status_code == 403
    validate.assert_called_once()
    get_context.assert_called_once()
    action_context = authorize.await_args.args[0]
    assert action_context.action is AttachmentAction.PREVIEW_BY_SHARE_TOKEN


@pytest.mark.asyncio
async def test_invalid_share_token_is_rejected_before_preview_authorizer(monkeypatch):
    authorize = AsyncMock()
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(
        attachments, "_validate_share_token_access", Mock(return_value=False)
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.get_attachment_preview(
            attachment_id=10,
            share_token="invalid-token",
            db=Mock(),
            current_user=None,
        )

    assert exc_info.value.status_code == 403
    authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_invalid_share_token_is_rejected_before_download_authorizer(monkeypatch):
    authorize = AsyncMock()
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(
        attachments,
        "_validate_share_token_access",
        Mock(return_value=False),
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.download_attachment(
            attachment_id=10,
            request=Mock(),
            share_token="invalid-token",
            db=Mock(),
            current_user=None,
        )

    assert exc_info.value.status_code == 404
    authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_public_share_checks_attachment_owner_before_authorizer(monkeypatch):
    context = SimpleNamespace(
        context_type=ContextType.ATTACHMENT.value,
        user_id=5,
    )
    authorize = AsyncMock()
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(
        attachments.context_service,
        "get_context_optional",
        Mock(return_value=context),
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.create_public_share_link(
            attachment_id=10,
            expires_in_days=7,
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "Only the attachment owner can create share links"
    authorize.assert_not_awaited()


@pytest.mark.asyncio
async def test_public_download_checks_attachment_before_authorizer(monkeypatch):
    authorize = AsyncMock()
    monkeypatch.setattr(attachments, "authorize_attachment_action", authorize)
    monkeypatch.setattr(
        attachments,
        "_verify_public_share_token",
        Mock(return_value={"attachment_id": 10}),
    )
    monkeypatch.setattr(
        attachments.context_service,
        "get_context_optional",
        Mock(return_value=None),
    )

    with pytest.raises(HTTPException) as exc_info:
        await attachments.public_download_attachment(
            token="valid-token",
            db=Mock(),
            current_user=SimpleNamespace(id=7),
        )

    assert exc_info.value.status_code == 404
    authorize.assert_not_awaited()
