# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for MCP knowledge base creation and document deletion helpers."""

from sqlalchemy.orm import Session

from app.mcp_server.auth import TaskTokenInfo
from app.mcp_server.tools import knowledge as knowledge_tools
from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument


def _token(user_id: int) -> TaskTokenInfo:
    return TaskTokenInfo(
        task_id=1,
        subtask_id=1,
        user_id=user_id,
        user_name="testuser",
    )


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


def test_create_knowledge_base_creates_kind_record(test_db: Session, test_user):
    result = knowledge_tools._create_knowledge_base(
        db=test_db,
        token_info=_token(test_user.id),
        name="My KB",
        description="desc",
        namespace="default",
        kb_type="notebook",
        summary_enabled=False,
    )

    assert result["success"] is True
    kb_id = result["knowledge_base"]["id"]

    created = test_db.query(Kind).filter(Kind.id == kb_id).one()
    assert created.kind == "KnowledgeBase"
    assert created.user_id == test_user.id
    assert created.namespace == "default"
    assert created.is_active is True


def test_delete_document_removes_document_record(test_db: Session, test_user):
    kb = _create_kb(test_db, test_user.id)

    doc = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=0,
        name="doc",
        file_extension="txt",
        file_size=1,
        user_id=test_user.id,
        source_type="text",
        source_config={},
    )
    test_db.add(doc)
    test_db.commit()
    test_db.refresh(doc)

    result = knowledge_tools._delete_document(
        db=test_db,
        token_info=_token(test_user.id),
        document_id=doc.id,
    )
    assert result["success"] is True

    remaining = test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == doc.id)
    assert remaining.count() == 0
