# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for knowledge indexing state machine helpers."""

from datetime import datetime, timedelta
from unittest.mock import MagicMock

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import DocumentProcessingStage
from app.services.knowledge.index_state_machine import (
    _utcnow,
    mark_document_index_failed,
    mark_document_index_started,
    mark_document_index_succeeded,
    prepare_document_index_enqueue,
)
from app.services.knowledge.processing_errors import build_processing_error


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


def test_mark_document_index_failed_persists_error_and_preserves_source_config(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.INDEXING,
        index_generation=2,
    )
    document.source_config = {"converted_attachment_id": 99}
    test_db.commit()

    finalized = mark_document_index_failed(
        test_db,
        document.id,
        2,
        error=build_processing_error(
            stage=DocumentProcessingStage.INDEXING,
            code="indexing_failed",
            message="Document indexing failed. Please retry.",
            retryable=True,
            generation=2,
        ),
    )

    test_db.refresh(document)
    assert finalized is True
    assert document.index_status == DocumentIndexStatus.FAILED
    assert document.source_config["converted_attachment_id"] == 99
    assert document.processing_error_payload["code"] == "indexing_failed"
    assert document.processing_error_payload["generation"] == 2


def test_failed_old_attempt_does_not_overwrite_another_sessions_new_generation() -> (
    None
):
    engine = create_engine("sqlite:///:memory:")
    KnowledgeDocument.__table__.create(engine)
    KnowledgeDocumentExternalSource.__table__.create(engine)
    try:
        with Session(engine, expire_on_commit=False) as old_worker:
            document = KnowledgeDocument(
                kind_id=1,
                user_id=1,
                name="external.md",
                file_extension="md",
                source_type="external",
                external_source=KnowledgeDocumentExternalSource(
                    kind_id=1,
                    external_provider="dingtalk",
                    external_resource_id="source",
                ),
                index_status=DocumentIndexStatus.QUEUED,
                index_generation=1,
            )
            old_worker.add(document)
            old_worker.commit()

            with Session(engine) as new_worker:
                current = new_worker.get(KnowledgeDocument, document.id)
                current.index_generation = 2
                new_worker.commit()

            # The old worker still holds the document from before the provider call.
            assert document.index_generation == 1
            finalized = mark_document_index_failed(old_worker, document.id, 1)

            assert finalized is False
            old_worker.refresh(document)
            assert document.index_generation == 2
            assert document.index_status == DocumentIndexStatus.QUEUED
            assert document.processing_error_payload is None
    finally:
        engine.dispose()


def test_new_generation_clears_processing_error_and_preserves_source_config(
    test_db: Session, test_user: User
):
    knowledge_base = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        knowledge_base,
        index_status=DocumentIndexStatus.FAILED,
        index_generation=2,
    )
    document.source_config = {
        "converted_attachment_id": 99,
        "processing_error": {"code": "old"},
    }
    test_db.commit()

    decision = prepare_document_index_enqueue(test_db, document.id)

    test_db.refresh(document)
    assert decision.should_enqueue is True
    assert document.index_generation == 3
    assert document.processing_error_payload is None
    assert document.source_config["converted_attachment_id"] == 99


def test_stale_handoff_cannot_replace_a_newer_attempt(
    test_db: Session, test_user: User
) -> None:
    kb = _create_knowledge_base(test_db, test_user)
    document = _create_document(
        test_db,
        test_user,
        kb,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=4,
    )

    decision = prepare_document_index_enqueue(
        test_db, document.id, replace_active=True, expected_generation=2
    )

    assert decision.should_enqueue is False
    assert decision.reason == "stale_generation"
    test_db.refresh(document)
    assert document.index_generation == 4
    assert document.index_status == DocumentIndexStatus.QUEUED


class TestBeginExternalImportAttempt:
    def _create_external_document(
        self,
        test_db: Session,
        test_user: User,
        knowledge_base: Kind,
        *,
        index_status: DocumentIndexStatus = DocumentIndexStatus.QUEUED,
        index_generation: int = 2,
        with_identity: bool = True,
        with_error: bool = True,
    ) -> KnowledgeDocument:
        document = KnowledgeDocument(
            kind_id=knowledge_base.id,
            attachment_id=0,
            name="external.md",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            source_type="external",
            external_source=(
                KnowledgeDocumentExternalSource(
                    kind_id=knowledge_base.id,
                    external_provider="dingtalk",
                    external_resource_id="a" * 32,
                )
                if with_identity
                else None
            ),
            index_status=index_status,
            index_generation=index_generation,
        )
        if with_error:
            document.set_processing_error_payload(
                {
                    "stage": "system",
                    "code": "external_import_failed",
                    "message": "failed",
                    "retryable": True,
                    "generation": index_generation,
                    "occurred_at": "2026-08-26T00:00:00Z",
                }
            )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_claims_next_generation_and_requeues(
        self, test_db: Session, test_user: User
    ):
        from app.services.knowledge.index_state_machine import (
            begin_external_import_attempt,
        )

        knowledge_base = _create_knowledge_base(test_db, test_user)
        document = self._create_external_document(test_db, test_user, knowledge_base)

        decision = begin_external_import_attempt(test_db, document.id, 2)

        assert decision.should_execute is True
        assert decision.generation == 3
        test_db.refresh(document)
        assert document.index_generation == 3
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.processing_error_payload is None

    def test_skips_missing_document(self, test_db: Session, test_user: User):
        from app.services.knowledge.index_state_machine import (
            begin_external_import_attempt,
        )

        decision = begin_external_import_attempt(test_db, 999999, 2)

        assert decision.should_execute is False
        assert decision.reason == "document_not_found"

    def test_skips_document_without_external_identity(
        self, test_db: Session, test_user: User
    ):
        from app.services.knowledge.index_state_machine import (
            begin_external_import_attempt,
        )

        knowledge_base = _create_knowledge_base(test_db, test_user)
        document = self._create_external_document(
            test_db, test_user, knowledge_base, with_identity=False
        )

        decision = begin_external_import_attempt(test_db, document.id, 2)

        assert decision.should_execute is False
        assert decision.reason == "no_external_identity"
        test_db.refresh(document)
        assert document.index_generation == 2

    def test_skips_already_imported_document(self, test_db: Session, test_user: User):
        from app.services.knowledge.index_state_machine import (
            begin_external_import_attempt,
        )

        knowledge_base = _create_knowledge_base(test_db, test_user)
        document = self._create_external_document(
            test_db,
            test_user,
            knowledge_base,
            index_status=DocumentIndexStatus.SUCCESS,
            with_error=False,
        )

        decision = begin_external_import_attempt(test_db, document.id, 2)

        assert decision.should_execute is False
        assert decision.reason == "already_imported"
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.SUCCESS
        assert document.index_generation == 2

    def test_index_success_records_time_without_overwriting_source_health(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.index_state_machine import (
            mark_document_index_succeeded,
        )

        knowledge_base = _create_knowledge_base(test_db, test_user)
        document = self._create_external_document(
            test_db,
            test_user,
            knowledge_base,
            index_status=DocumentIndexStatus.INDEXING,
            with_error=False,
        )
        document.update_external_source_config(
            status="inaccessible", last_error="old failure"
        )
        test_db.commit()

        finalized = mark_document_index_succeeded(
            test_db, document.id, document.index_generation
        )

        assert finalized is True
        test_db.refresh(document)
        external = document.external_source_config
        assert external["status"] == "inaccessible"
        assert external["last_success_at"]
        assert external["last_error"] == "old failure"
