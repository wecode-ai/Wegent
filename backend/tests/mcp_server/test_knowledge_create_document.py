# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP knowledge create_document helpers."""

import base64
from unittest.mock import MagicMock, patch

from sqlalchemy.orm import Session

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import knowledge as knowledge_tools
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.services.context import context_service


def _create_kb(db: Session, user_id: int) -> Kind:
    kb = Kind(
        user_id=user_id,
        kind="KnowledgeBase",
        name="test-kb",
        namespace="default",
        json={"spec": {"kbType": "notebook"}},
        is_active=True,
    )
    db.add(kb)
    db.commit()
    db.refresh(kb)
    return kb


def _token(user_id: int) -> TaskTokenInfo:
    return TaskTokenInfo(
        task_id=1,
        subtask_id=1,
        user_id=user_id,
        user_name="testuser",
    )


def test_create_document_from_text_defaults_file_extension_and_creates_document(
    test_db: Session, test_user
):
    kb = _create_kb(test_db, test_user.id)

    attachment = MagicMock()
    attachment.id = 999

    def fake_upload_attachment(*, db, user_id, filename, binary_data, subtask_id=0):
        assert db is test_db
        assert user_id == test_user.id
        assert filename == "doc.txt"
        assert binary_data == b"ABABABAB"
        assert subtask_id == 0
        return attachment, None

    with patch.object(
        context_service,
        "upload_attachment",
        side_effect=fake_upload_attachment,
    ):
        result = knowledge_tools._create_document_from_text(
            db=test_db,
            token_info=_token(test_user.id),
            knowledge_base_id=kb.id,
            name="doc",
            content="ABABABAB",
            file_extension=knowledge_tools._normalize_file_extension(None),
        )

    assert result["success"] is True
    doc_id = result["document"]["id"]

    created = (
        test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc_id).one()
    )
    assert created.kind_id == kb.id
    assert created.attachment_id == 999
    assert created.file_extension == "txt"
    assert created.file_size == 8
    assert created.source_type == "text"


def test_create_document_from_file_uploads_attachment_and_creates_document(
    test_db: Session, test_user
):
    kb = _create_kb(test_db, test_user.id)

    attachment = MagicMock()
    attachment.id = 1001

    def fake_upload_attachment(*, db, user_id, filename, binary_data, subtask_id=0):
        assert db is test_db
        assert user_id == test_user.id
        assert filename == "file-doc.txt"
        assert binary_data == b"ABABABAB"
        assert subtask_id == 0
        return attachment, None

    file_base64 = base64.b64encode(b"ABABABAB").decode("utf-8")

    with patch.object(
        context_service,
        "upload_attachment",
        side_effect=fake_upload_attachment,
    ):
        result = knowledge_tools._create_document_from_file(
            db=test_db,
            token_info=_token(test_user.id),
            knowledge_base_id=kb.id,
            name="file-doc",
            file_base64=file_base64,
            file_extension="txt",
        )

    assert result["success"] is True
    doc_id = result["document"]["id"]

    created = (
        test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc_id).one()
    )
    assert created.kind_id == kb.id
    assert created.attachment_id == 1001
    assert created.file_extension == "txt"
    assert created.file_size == 8
    assert created.source_type == "file"
