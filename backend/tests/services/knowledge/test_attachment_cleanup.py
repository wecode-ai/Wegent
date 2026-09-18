# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for scoped, retryable knowledge attachment orphan cleanup."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock

from sqlalchemy.orm import Session

from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.services.attachment.storage_backend import StorageError
from app.services.context.context_service import context_service
from app.services.knowledge.attachment_cleanup import (
    EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER,
    cleanup_orphaned_knowledge_attachments,
)


def _attachment(
    db: Session,
    user_id: int,
    *,
    created_at: datetime,
    owned: bool = True,
) -> SubtaskContext:
    type_data = {
        "storage_key": "attachments/test",
        "storage_backend": "mysql",
    }
    if owned:
        type_data["lifecycle_owner"] = EXTERNAL_WIKI_ATTACHMENT_LIFECYCLE_OWNER
    context = SubtaskContext(
        subtask_id=0,
        user_id=user_id,
        context_type=ContextType.ATTACHMENT.value,
        name="page.md",
        status=ContextStatus.READY.value,
        type_data=type_data,
        created_at=created_at,
    )
    db.add(context)
    db.commit()
    db.refresh(context)
    return context


def _document(
    db: Session,
    user_id: int,
    *,
    attachment_id: int,
    converted_attachment_id: int | None = None,
) -> KnowledgeDocument:
    source_config = {}
    if converted_attachment_id is not None:
        source_config["converted_attachment_id"] = converted_attachment_id
    document = KnowledgeDocument(
        kind_id=1,
        attachment_id=attachment_id,
        name="page.md",
        file_extension="md",
        file_size=1,
        user_id=user_id,
        source_type="file",
        source_config=source_config,
    )
    db.add(document)
    db.commit()
    db.refresh(document)
    return document


def test_cleanup_deletes_only_aged_unreferenced_owned_attachments(
    test_db: Session,
    test_user,
    monkeypatch,
) -> None:
    now = datetime(2026, 9, 14, 12, 0, 0)
    orphan = _attachment(test_db, test_user.id, created_at=now - timedelta(hours=25))
    unmarked = _attachment(
        test_db,
        test_user.id,
        created_at=now - timedelta(hours=25),
        owned=False,
    )
    recent = _attachment(test_db, test_user.id, created_at=now - timedelta(hours=2))
    delete_context = MagicMock(return_value=True)
    monkeypatch.setattr(context_service, "delete_context", delete_context)

    report = cleanup_orphaned_knowledge_attachments(
        test_db,
        retention_hours=24,
        batch_size=100,
        now=now,
    )

    assert report.deleted == 1
    assert report.scanned == 1
    delete_context.assert_called_once_with(
        test_db,
        orphan.id,
        test_user.id,
        keep_row_on_storage_failure=True,
    )
    assert {unmarked.id, recent.id}.isdisjoint(
        {call.args[1] for call in delete_context.call_args_list}
    )


def test_cleanup_preserves_direct_and_converted_document_references(
    test_db: Session,
    test_user,
    monkeypatch,
) -> None:
    now = datetime(2026, 9, 14, 12, 0, 0)
    direct = _attachment(test_db, test_user.id, created_at=now - timedelta(days=2))
    converted = _attachment(test_db, test_user.id, created_at=now - timedelta(days=2))
    _document(
        test_db,
        test_user.id,
        attachment_id=direct.id,
        converted_attachment_id=converted.id,
    )
    delete_context = MagicMock(return_value=True)
    monkeypatch.setattr(context_service, "delete_context", delete_context)

    report = cleanup_orphaned_knowledge_attachments(
        test_db,
        retention_hours=24,
        batch_size=100,
        now=now,
    )

    assert report.scanned == 0
    assert report.referenced == 0
    assert report.deleted == 0
    delete_context.assert_not_called()


def test_cleanup_continues_after_one_candidate_raises(
    test_db: Session,
    test_user,
    monkeypatch,
) -> None:
    now = datetime(2026, 9, 14, 12, 0, 0)
    first = _attachment(test_db, test_user.id, created_at=now - timedelta(days=2))
    second = _attachment(test_db, test_user.id, created_at=now - timedelta(days=2))
    delete_context = MagicMock(side_effect=[RuntimeError("database failure"), True])
    rollback = MagicMock(wraps=test_db.rollback)
    monkeypatch.setattr(context_service, "delete_context", delete_context)
    monkeypatch.setattr(test_db, "rollback", rollback)

    report = cleanup_orphaned_knowledge_attachments(
        test_db,
        retention_hours=24,
        batch_size=100,
        now=now,
    )

    assert report.scanned == 2
    assert report.deleted == 1
    assert report.retryable_failures == 1
    assert [call.args[1] for call in delete_context.call_args_list] == [
        first.id,
        second.id,
    ]
    rollback.assert_called_once_with()


def test_storage_delete_failure_keeps_row_for_retry(
    test_db: Session,
    test_user,
    monkeypatch,
) -> None:
    context = _attachment(
        test_db,
        test_user.id,
        created_at=datetime(2026, 9, 12, 12, 0, 0),
    )
    storage = MagicMock()
    storage.delete.side_effect = StorageError("unavailable", context.storage_key)
    monkeypatch.setitem(
        context_service.delete_context.__globals__,
        "get_storage_backend",
        lambda _db: storage,
    )

    deleted = context_service.delete_context(
        test_db,
        context.id,
        test_user.id,
        keep_row_on_storage_failure=True,
    )

    assert deleted is False
    assert test_db.get(SubtaskContext, context.id) is not None


def test_storage_delete_failure_preserves_default_delete_contract(
    test_db: Session,
    test_user,
    monkeypatch,
) -> None:
    context = _attachment(
        test_db,
        test_user.id,
        created_at=datetime(2026, 9, 12, 12, 0, 0),
        owned=False,
    )
    context_id = context.id
    storage = MagicMock()
    storage.delete.side_effect = StorageError("unavailable", context.storage_key)
    monkeypatch.setitem(
        context_service.delete_context.__globals__,
        "get_storage_backend",
        lambda _db: storage,
    )

    deleted = context_service.delete_context(test_db, context_id, test_user.id)

    assert deleted is True
    assert test_db.get(SubtaskContext, context_id) is None
