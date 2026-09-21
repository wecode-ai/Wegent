# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""Exercise IM attachment persistence through the real service and SQL storage."""

import base64
import importlib
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.models.subtask_context import SubtaskContext
from app.services.attachment.external_storage import ExternalAttachmentStorageResult
from app.services.attachment.parser import DocumentParseError
from app.services.channels.dingtalk.handler import DingTalkChannelHandler
from app.services.context.context_service import ContextService
from tests.services.channels.dingtalk.test_card_images import png_bytes

context_module = importlib.import_module("app.services.context.context_service")


@pytest.fixture
def db(monkeypatch):
    engine = create_engine("sqlite://")
    SubtaskContext.__table__.create(engine)
    monkeypatch.setattr(context_module.settings, "ATTACHMENT_STORAGE_BACKEND", "mysql")
    monkeypatch.setattr(
        context_module, "find_external_attachment_storage_adapter", lambda *_: None
    )
    monkeypatch.setenv("ATTACHMENT_ENCRYPTION_ENABLED", "false")
    with Session(engine) as session:
        yield session
    engine.dispose()


def image(data):
    return {"mime_type": "image/png", "base64_data": base64.b64encode(data).decode()}


@pytest.mark.parametrize(
    "strict,commit,expected", [(True, False, 0), (True, True, 2), (False, False, 2)]
)
def test_im_images_share_callers_transaction(db, strict, commit, expected):
    data = png_bytes()
    handler = DingTalkChannelHandler(channel_id=285)
    ids = handler._persist_im_images_as_attachments(
        db, user_id=5, subtask_id=42, images=[image(data), image(data)], strict=strict
    )
    assert len(ids) == 2
    rows = db.query(SubtaskContext).all()
    assert all(row.subtask_id == 42 and row.status == "ready" for row in rows)
    assert all(row.binary_data == data and row.image_base64 for row in rows)
    if commit:
        db.commit()
    else:
        db.rollback()
    assert db.query(SubtaskContext).count() == expected


def test_failed_second_image_does_not_commit_first_image(db):
    handler = DingTalkChannelHandler(channel_id=285)
    with pytest.raises(DocumentParseError):
        handler._persist_im_images_as_attachments(
            db,
            user_id=5,
            subtask_id=42,
            images=[image(png_bytes()), image(b"invalid image")],
            strict=True,
        )
    db.rollback()
    assert db.query(SubtaskContext).count() == 0


@pytest.mark.parametrize("commit", [True, False])
def test_external_attachment_respects_transaction_ownership(db, monkeypatch, commit):
    adapter = SimpleNamespace(
        backend_type="test-external",
        store=Mock(
            return_value=ExternalAttachmentStorageResult(
                backend_type="test-external", storage_key="image-1", skip_parsing=True
            )
        ),
    )
    monkeypatch.setattr(
        context_module, "find_external_attachment_storage_adapter", lambda *_: adapter
    )
    context, _ = ContextService().upload_attachment(
        db,
        user_id=5,
        filename="image.png",
        binary_data=png_bytes(),
        commit=commit,
    )
    assert context.status == "ready"
    db.rollback()
    assert db.query(SubtaskContext).count() == int(commit)
