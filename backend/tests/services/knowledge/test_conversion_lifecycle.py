# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression tests for the conversion part of the document index lifecycle.

A converted document has to keep a clear status at every step: conversion may
start only for the current waiting generation, may complete only once, and a
failure or a superseded generation must never leave a stale body queryable.
"""

from datetime import datetime

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import DocumentProcessingStage
from app.services.knowledge.index_state_machine import (
    mark_document_conversion_started,
    mark_document_conversion_succeeded,
    mark_document_index_failed,
    mark_document_index_started,
    mark_document_index_succeeded,
)
from app.services.knowledge.processing_errors import (
    build_conversion_callback_error,
    build_processing_error,
)


def _create_knowledge_base(test_db: Session, test_user: User) -> Kind:
    knowledge_base = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name=f"kb-conversion-{test_user.id}",
        namespace="default",
        json={
            "apiVersion": "agent.wecode.io/v1",
            "kind": "KnowledgeBase",
            "metadata": {
                "name": f"kb-conversion-{test_user.id}",
                "namespace": "default",
            },
            "spec": {"name": "Conversion KB"},
            "status": {"state": "Available"},
        },
        created_at=datetime.now(),
        updated_at=datetime.now(),
    )
    test_db.add(knowledge_base)
    test_db.commit()
    test_db.refresh(knowledge_base)
    return knowledge_base


def _create_document(
    test_db: Session,
    test_user: User,
    knowledge_base: Kind,
    *,
    index_status: DocumentIndexStatus = DocumentIndexStatus.PENDING_CONVERSION,
    index_generation: int = 3,
) -> KnowledgeDocument:
    document = KnowledgeDocument(
        kind_id=knowledge_base.id,
        attachment_id=11,
        name="report.pdf",
        file_extension="pdf",
        file_size=1024,
        user_id=test_user.id,
        is_active=True,
        status="enabled",
        source_type="file",
        index_status=index_status,
        index_generation=index_generation,
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)
    return document


@pytest.fixture
def conversion_document(test_db: Session, test_user: User) -> KnowledgeDocument:
    knowledge_base = _create_knowledge_base(test_db, test_user)
    return _create_document(test_db, test_user, knowledge_base)


def test_conversion_start_moves_a_waiting_document_into_converting(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    decision = mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    test_db.refresh(conversion_document)
    assert decision.should_execute is True
    assert decision.reason == "conversion_started"
    assert conversion_document.index_status == DocumentIndexStatus.CONVERTING


def test_duplicate_conversion_start_is_refused(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    duplicate = mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    test_db.refresh(conversion_document)
    assert duplicate.should_execute is False
    assert duplicate.reason == "unexpected_status_converting"
    assert conversion_document.index_status == DocumentIndexStatus.CONVERTING


def test_superseded_generation_cannot_start_conversion(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    conversion_document.index_generation = 4
    test_db.commit()

    decision = mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    test_db.refresh(conversion_document)
    assert decision.should_execute is False
    assert decision.reason == "stale_generation"
    assert conversion_document.index_status == DocumentIndexStatus.PENDING_CONVERSION


def test_conversion_completion_queues_the_index_and_is_idempotent(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    assert (
        mark_document_conversion_succeeded(
            db=test_db, document_id=conversion_document.id, generation=3
        )
        is True
    )
    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.QUEUED

    # A duplicate completion callback must not move the document again.
    assert (
        mark_document_conversion_succeeded(
            db=test_db, document_id=conversion_document.id, generation=3
        )
        is False
    )
    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.QUEUED


def test_superseded_conversion_cannot_replay_completion(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    conversion_document.index_generation = 4
    test_db.commit()

    assert (
        mark_document_conversion_succeeded(
            db=test_db, document_id=conversion_document.id, generation=3
        )
        is False
    )

    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.PENDING_CONVERSION


def test_conversion_failure_marks_the_document_failed(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    error = build_conversion_callback_error(
        error_code="conversion_provider_error",
        user_message="The document conversion failed.",
        retryable=True,
        generation=3,
        error_message="mineru: timeout",
        provider="mineru",
    )

    assert (
        mark_document_index_failed(
            db=test_db,
            document_id=conversion_document.id,
            generation=3,
            error=error,
        )
        is True
    )

    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.FAILED
    persisted = conversion_document.processing_error_payload
    assert persisted is not None
    assert persisted["code"] == "conversion_provider_error"
    assert persisted["stage"] == DocumentProcessingStage.CONVERSION.value


def test_superseded_index_result_cannot_overwrite_the_converted_generation(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )
    mark_document_conversion_succeeded(
        db=test_db, document_id=conversion_document.id, generation=3
    )
    # A newer generation starts indexing before the old task reports back.
    conversion_document.index_generation = 4
    conversion_document.index_status = DocumentIndexStatus.INDEXING
    test_db.commit()

    assert (
        mark_document_index_succeeded(
            db=test_db, document_id=conversion_document.id, generation=3
        )
        is False
    )

    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.INDEXING
    assert conversion_document.index_generation == 4


def test_index_failure_after_conversion_keeps_a_clear_failed_status(
    test_db: Session, conversion_document: KnowledgeDocument
) -> None:
    """A runtime index failure on converted content is visible and not a success."""
    mark_document_conversion_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )
    mark_document_conversion_succeeded(
        db=test_db, document_id=conversion_document.id, generation=3
    )
    mark_document_index_started(
        db=test_db, document_id=conversion_document.id, generation=3
    )

    assert (
        mark_document_index_failed(
            db=test_db,
            document_id=conversion_document.id,
            generation=3,
            error=build_processing_error(
                stage=DocumentProcessingStage.INDEXING,
                code="indexing_failed",
                message="Document indexing failed. Please retry.",
                retryable=True,
                generation=3,
            ),
        )
        is True
    )

    test_db.refresh(conversion_document)
    assert conversion_document.index_status == DocumentIndexStatus.FAILED
    persisted = conversion_document.processing_error_payload
    assert persisted is not None
    assert persisted["stage"] == DocumentProcessingStage.INDEXING.value
    assert persisted["code"] == "indexing_failed"
