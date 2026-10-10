# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Index timeouts compare the database timestamp and clock in one timezone."""

from datetime import datetime, timedelta, timezone, tzinfo
from typing import Any, Generator

import pytest
from pytest_mock import MockerFixture
from sqlalchemy import event
from sqlalchemy.engine import Connection
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db import timezone as db_time
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.services.knowledge import index_state_machine as states
from app.tasks import knowledge_tasks


class FixedClock(datetime):
    @classmethod
    def now(cls, tz: tzinfo | None = None) -> "FixedClock":
        value = cls(2026, 10, 6, 13, tzinfo=timezone.utc)
        return value.astimezone(tz) if tz else value.replace(tzinfo=None)


@pytest.fixture
def database_clock(
    test_db: Session, monkeypatch: pytest.MonkeyPatch, request: pytest.FixtureRequest
) -> Generator[None, None, None]:
    monkeypatch.setattr(states, "datetime", FixedClock)
    monkeypatch.setattr(db_time, "datetime", FixedClock, raising=False)
    monkeypatch.setattr(
        db_time, "database_datetime_timezone", lambda: timezone(timedelta(hours=8))
    )
    monkeypatch.setattr(settings, "KNOWLEDGE_INDEX_STALE_QUEUED_SECONDS", 60)
    offset = (
        request.node.callspec.params.get("offset", 8)
        if hasattr(request.node, "callspec")
        else 8
    )
    database_now = datetime(2026, 10, 6, 13 + offset).strftime("%Y-%m-%d %H:%M:%S")
    bind = test_db.get_bind()

    def database_timestamp(
        _connection: Connection,
        _cursor: Any,
        statement: str,
        parameters: Any,
        _context: Any,
        _executemany: bool,
    ) -> tuple[str, Any]:
        return (
            statement.replace("CURRENT_TIMESTAMP", "'" + database_now + "'"),
            parameters,
        )

    event.listen(bind, "before_cursor_execute", database_timestamp, retval=True)
    try:
        yield
    finally:
        event.remove(bind, "before_cursor_execute", database_timestamp)


def test_scanner_expires_mysql_timestamp_instead_of_reading_it_as_future(
    test_db: Session, test_user: User, database_clock: None, mocker: MockerFixture
) -> None:
    document = KnowledgeDocument(
        kind_id=1,
        user_id=test_user.id,
        name="timezone.md",
        file_extension="md",
        is_active=True,
        index_status=DocumentIndexStatus.QUEUED,
        index_generation=1,
        updated_at=datetime(2026, 10, 6, 20, 58),
    )
    test_db.add(document)
    test_db.commit()
    mocker.patch.object(
        knowledge_tasks,
        "SessionLocal",
        side_effect=lambda: Session(bind=test_db.get_bind()),
    )

    result = knowledge_tasks.scan_stale_index_tasks()

    assert result["marked_count"] == 1
    test_db.refresh(document)
    assert document.index_status == DocumentIndexStatus.FAILED
    assert document.processing_error_payload["retryable"] is True


@pytest.mark.parametrize("transition", ["start", "complete"])
def test_new_conversion_state_is_not_immediately_expired(
    test_db: Session,
    test_user: User,
    database_clock: None,
    mocker: MockerFixture,
    transition: str,
) -> None:
    document = KnowledgeDocument(
        kind_id=1,
        user_id=test_user.id,
        name="convert.pdf",
        file_extension="pdf",
        is_active=True,
        index_generation=1,
        index_status=(
            DocumentIndexStatus.PENDING_CONVERSION
            if transition == "start"
            else DocumentIndexStatus.CONVERTING
        ),
        updated_at=datetime(2026, 10, 6, 20, 59),
    )
    test_db.add(document)
    test_db.commit()
    mocker.patch.object(
        knowledge_tasks,
        "SessionLocal",
        side_effect=lambda: Session(bind=test_db.get_bind()),
    )

    if transition == "start":
        assert states.mark_document_conversion_started(
            test_db, document.id, 1
        ).should_execute
    else:
        assert states.mark_document_conversion_succeeded(test_db, document.id, 1)
    result = knowledge_tasks.scan_stale_index_tasks()

    assert result["marked_count"] == 0
    test_db.refresh(document)
    assert document.updated_at == datetime(2026, 10, 6, 21)


@pytest.mark.parametrize("pipeline", ["mineru", "multimodal"])
def test_dispatch_waiting_for_conversion_uses_database_time(
    test_db: Session,
    test_user: User,
    database_clock: None,
    mocker: MockerFixture,
    monkeypatch: pytest.MonkeyPatch,
    pipeline: str,
) -> None:
    from types import SimpleNamespace

    from app.core.celery_app import celery_app
    from app.models.kind import Kind
    from app.services.knowledge.multimodal_dispatch import MultimodalDispatchContext
    from app.services.knowledge.multimodal_pipeline import (
        schedule_multimodal_indexing_or_none,
    )
    from app.services.knowledge.orchestrator import KnowledgeOrchestrator

    monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_ENABLED", True)
    monkeypatch.setattr(settings, "KNOWLEDGE_CONVERSION_FILE_TYPES", "pdf")
    monkeypatch.setattr(settings, "KNOWLEDGE_MULTIMODAL_ENABLED", True)
    extension = "pdf" if pipeline == "mineru" else "png"
    kb = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="timezone-dispatch",
        namespace="default",
        json={
            "spec": {
                "name": "Timezone dispatch",
                "retrievalConfig": {
                    "retriever_name": "unit-retriever",
                    "embedding_config": {"model_name": "unit-model"},
                },
            }
        },
    )
    test_db.add(kb)
    test_db.flush()
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=test_user.id,
        name="conversion",
        file_extension=extension,
        attachment_id=0,
        source_type="file",
        is_active=True,
        index_status=DocumentIndexStatus.NOT_INDEXED,
        index_generation=0,
        updated_at=datetime(2026, 10, 6, 20, 58),
    )
    test_db.add(document)
    test_db.commit()
    send = mocker.patch.object(
        celery_app, "send_task", return_value=SimpleNamespace(id="unit-task")
    )

    if pipeline == "mineru":
        result = KnowledgeOrchestrator().reindex_document(
            test_db, test_user, document.id
        )
        assert result["success"]
    else:
        context = MultimodalDispatchContext(
            media_type="image",
            model_ref={"name": "unit-model"},
            uploader_id=test_user.id,
            uploader_name=test_user.user_name,
            original_filename="conversion.png",
            content_download_path="/unit-attachment",
        )
        assert (
            schedule_multimodal_indexing_or_none(
                test_db, kb, document, test_user, context, extension, 0, {}, settings
            )
            is not None
        )

    test_db.refresh(document)
    assert document.index_status == DocumentIndexStatus.PENDING_CONVERSION
    assert document.updated_at == datetime(2026, 10, 6, 21)
    send.assert_called_once()


@pytest.mark.parametrize("offset", [0, 8])
@pytest.mark.parametrize(
    "status",
    [
        DocumentIndexStatus.QUEUED,
        DocumentIndexStatus.PENDING_CONVERSION,
        DocumentIndexStatus.CONVERTING,
        DocumentIndexStatus.INDEXING,
    ],
)
@pytest.mark.parametrize("age,expired", [(59, False), (60, True)])
def test_scanner_observes_timeout_boundary_in_session_timezone(
    test_db: Session,
    test_user: User,
    database_clock: None,
    mocker: MockerFixture,
    monkeypatch: pytest.MonkeyPatch,
    offset: int,
    status: DocumentIndexStatus,
    age: int,
    expired: bool,
) -> None:
    monkeypatch.setattr(
        db_time,
        "database_datetime_timezone",
        lambda: timezone(timedelta(hours=offset)),
    )
    for name in ["QUEUED", "PENDING_CONVERSION", "CONVERTING", "INDEXING"]:
        monkeypatch.setattr(settings, "KNOWLEDGE_INDEX_STALE_" + name + "_SECONDS", 60)
    now = datetime(2026, 10, 6, 13 + offset)
    document = KnowledgeDocument(
        kind_id=1,
        user_id=test_user.id,
        name="boundary.md",
        file_extension="md",
        is_active=True,
        index_generation=3,
        index_status=status,
        updated_at=now - timedelta(seconds=age),
    )
    test_db.add(document)
    test_db.commit()
    mocker.patch.object(
        knowledge_tasks,
        "SessionLocal",
        side_effect=lambda: Session(bind=test_db.get_bind()),
    )

    result = knowledge_tasks.scan_stale_index_tasks()

    assert result["marked_count"] == int(expired)
    test_db.refresh(document)
    assert document.index_status == (DocumentIndexStatus.FAILED if expired else status)
    assert document.index_generation == 3


def test_conversion_transition_uses_database_clock(
    test_db: Session, test_user: User, mocker: MockerFixture
) -> None:
    from sqlalchemy import func, select

    before = test_db.execute(select(func.now())).scalar_one()
    document = KnowledgeDocument(
        kind_id=1,
        user_id=test_user.id,
        name="db-clock.pdf",
        file_extension="pdf",
        is_active=True,
        index_status=DocumentIndexStatus.PENDING_CONVERSION,
        index_generation=1,
        updated_at=before - timedelta(days=1),
    )
    test_db.add(document)
    test_db.commit()
    mocker.patch.object(
        states, "database_datetime_now", return_value=datetime(2099, 1, 1)
    )

    result = states.mark_document_conversion_started(test_db, document.id, 1)
    test_db.refresh(document)
    after = test_db.execute(select(func.now())).scalar_one()

    assert result.should_execute
    assert before <= document.updated_at <= after
