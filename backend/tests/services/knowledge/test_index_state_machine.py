# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge indexing state machine helpers."""

from datetime import datetime, timedelta

from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge.index_state_machine import (
    _utcnow,
    mark_document_index_started,
    mark_document_index_succeeded,
    prepare_document_index_enqueue,
)


def _create_knowledge_base(test_db: Session, test_user: User) -> Kind:
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name=f"kb-{test_user.id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {"name": f"kb-{test_user.id}", "namespace": "default"},
            "spec": {"name": "Test KB"},
            "status": {"state": "Available"},
        },
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    test_db.add(kb)
    test_db.commit()
    test_db.refresh(kb)
    return kb


def _create_document(
    test_db: Session,
    test_user: User,
    knowledge_base: Kind,
    *,
    is_active: bool = False,
    index_status: DocumentIndexStatus = DocumentIndexStatus.NOT_INDEXED,
    index_generation: int = 0,
) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=0,
        name="test.pdf",
        file_extension="pdf",
        file_size=1024,
        user_id=test_user.id,
        is_active=is_active,
        status="enabled" if is_active else "disabled",
        source_type="file",
        index_status=index_status,
        index_generation=index_generation,
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)
    return document


def test_prepare_document_index_enqueue_schedules_new_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(test_db, test_user, knowledge_base)
    previous_updated_at = _utcnow() - timedelta(seconds=5)
    test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document.id).update(
        {KnowledgeDocument.updated_at: previous_updated_at},
        synchronize_session=False,
    )
    test_db.commit()

    decision = prepare_document_index_enqueue(test_db, document.id)

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert decision.generation == 1
    assert decision.reason == "scheduled"
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 1
    assert document.updated_at > previous_updated_at


def test_prepare_document_index_enqueue_skips_when_generation_is_active(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=3,
    )

    decision = prepare_document_index_enqueue(test_db, document.id)

    assert decision.should_enqueue is False
    assert decision.reason == "already_in_progress"
    assert decision.generation == 3


def test_prepare_document_index_enqueue_recovers_stale_queued_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=3,
    )
    test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document.id).update(
        {
            KnowledgeDocument.updated_at: _utcnow()
            - timedelta(seconds=settings.KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS + 5)
        },
        synchronize_session=False,
    )
    test_db.commit()
    test_db.expire_all()

    decision = prepare_document_index_enqueue(test_db, document.id)

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert decision.reason == "scheduled_after_stale_recovery"
    assert decision.previous_status == DocumentIndexStatus.QUEUED
    assert decision.generation == 4
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 4


def test_prepare_document_index_enqueue_recovers_stale_indexing_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.INDEXING,
        index_generation=6,
    )
    test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document.id).update(
        {
            KnowledgeDocument.updated_at: _utcnow()
            - timedelta(seconds=settings.KNOWLEDGE_INDEX_STALE_INDEXING_SECONDS + 5)
        },
        synchronize_session=False,
    )
    test_db.commit()
    test_db.expire_all()

    decision = prepare_document_index_enqueue(test_db, document.id)

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert decision.reason == "scheduled_after_stale_recovery"
    assert decision.previous_status == DocumentIndexStatus.INDEXING
    assert decision.generation == 7
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 7


def test_prepare_document_index_enqueue_skips_success_without_override(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        index_generation=2,
    )

    decision = prepare_document_index_enqueue(test_db, document.id)

    assert decision.should_enqueue is False
    assert decision.reason == "already_indexed"
    assert decision.generation == 2


def test_prepare_document_index_enqueue_can_replace_active_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.INDEXING,
        index_generation=4,
    )
    previous_updated_at = _utcnow() - timedelta(seconds=5)
    test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document.id).update(
        {KnowledgeDocument.updated_at: previous_updated_at},
        synchronize_session=False,
    )
    test_db.commit()

    decision = prepare_document_index_enqueue(
        test_db,
        document.id,
        replace_active=True,
    )

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert decision.generation == 5
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 5
    assert document.updated_at > previous_updated_at


def test_prepare_document_index_enqueue_allows_success_override(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        is_active=True,
        index_status=DocumentIndexStatus.SUCCESS,
        index_generation=4,
    )

    decision = prepare_document_index_enqueue(
        test_db,
        document.id,
        allow_if_success=True,
    )

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert decision.previous_status == DocumentIndexStatus.SUCCESS
    assert decision.generation == 5
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 5


def test_mark_document_index_started_skips_stale_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=2,
    )

    decision = mark_document_index_started(
        test_db,
        document_id=document.id,
        generation=1,
    )

    assert decision.should_execute is False
    assert decision.reason == "stale_generation"


def test_mark_document_index_started_skips_not_indexed_document(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.NOT_INDEXED,
        index_generation=0,
    )

    decision = mark_document_index_started(
        test_db,
        document_id=document.id,
        generation=0,
    )

    assert decision.should_execute is False
    assert decision.reason == "not_scheduled"


def test_mark_document_index_started_updates_timestamp_on_success(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=2,
    )
    previous_updated_at = _utcnow() - timedelta(seconds=5)
    test_db.query(KnowledgeDocument).filter(KnowledgeDocument.id == document.id).update(
        {KnowledgeDocument.updated_at: previous_updated_at},
        synchronize_session=False,
    )
    test_db.commit()

    decision = mark_document_index_started(
        test_db,
        document_id=document.id,
        generation=2,
    )

    test_db.refresh(document)
    assert decision.should_execute is True
    assert decision.reason == "started"
    assert document.index_status == DocumentIndexStatus.INDEXING
    assert document.updated_at > previous_updated_at


def test_mark_document_index_succeeded_only_updates_active_generation(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=2,
    )

    finalized = mark_document_index_succeeded(
        test_db,
        document_id=document.id,
        generation=1,
        chunks={"total_count": 8},
        chunk_storage_enabled=True,
    )

    test_db.refresh(document)
    assert finalized is False
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert document.index_generation == 2
