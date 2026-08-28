# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Task-level tests for import_external_document_task."""

from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.orm import Session

from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
)
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.fixture
def task_db(test_db: Session, monkeypatch: pytest.MonkeyPatch) -> Session:
    """Point the task's SessionLocal at the test session."""

    @contextmanager
    def fake_session_local():
        yield test_db

    import app.tasks.knowledge_tasks as knowledge_tasks_module

    monkeypatch.setattr(knowledge_tasks_module, "SessionLocal", fake_session_local)
    return test_db


def _create_placeholder(
    test_db: Session, user_id: int, *, with_identity: bool = True
) -> KnowledgeDocument:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name="task-import-kb"),
    )
    document = KnowledgeDocument(
        kind_id=kb_id,
        attachment_id=0,
        name="Task Doc",
        file_extension="md",
        file_size=0,
        user_id=user_id,
        source_type=DocumentSourceType.EXTERNAL.value,
        source_config={"external": {"provider": "dingtalk"}},
        external_source=(
            KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="a" * 32,
            )
            if with_identity
            else None
        ),
        index_status=DocumentIndexStatus.QUEUED,
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)
    return document


def _run_task(document_id: int, expected_generation: int = 0) -> None:
    from app.tasks.knowledge_tasks import import_external_document_task

    import_external_document_task.run(
        document_id=document_id, expected_generation=expected_generation
    )


def test_task_imports_document_content(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_placeholder(task_db, test_user.id)
    content = ExternalDocumentContent(
        name="Task Doc",
        file_extension="md",
        content=b"# Task Doc",
        metadata={"provider": "dingtalk"},
    )
    provider = SimpleNamespace(fetch_content=AsyncMock(return_value=content))
    attached: dict = {}
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import"
        ".get_external_document_provider",
        lambda provider_id: provider,
    )

    def fake_attach(**kwargs):
        attached.update(kwargs)
        return {"scheduled": True}

    monkeypatch.setattr(
        "app.services.knowledge.orchestrator.knowledge_orchestrator"
        ".attach_external_document_content",
        fake_attach,
    )

    _run_task(document.id)

    provider.fetch_content.assert_awaited_once_with(
        task_db, test_user, document.external_resource_id
    )
    assert attached["document"].id == document.id
    assert attached["content"] is content


def test_task_skips_document_without_external_identity(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_placeholder(task_db, test_user.id, with_identity=False)
    provider = SimpleNamespace(fetch_content=AsyncMock())
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import"
        ".get_external_document_provider",
        lambda provider_id: provider,
    )

    _run_task(document.id)

    provider.fetch_content.assert_not_awaited()
    task_db.refresh(document)
    assert document.index_status == DocumentIndexStatus.QUEUED


def test_task_skips_missing_document(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    provider = SimpleNamespace(fetch_content=AsyncMock())
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import"
        ".get_external_document_provider",
        lambda provider_id: provider,
    )

    _run_task(999999)

    provider.fetch_content.assert_not_awaited()


def test_task_claims_generation_before_running(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_placeholder(task_db, test_user.id)
    content = ExternalDocumentContent(
        name="Task Doc",
        file_extension="md",
        content=b"# Task Doc",
        metadata={"provider": "dingtalk"},
    )
    provider = SimpleNamespace(fetch_content=AsyncMock(return_value=content))
    attached: dict = {}
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import"
        ".get_external_document_provider",
        lambda provider_id: provider,
    )

    def fake_attach(**kwargs):
        attached.update(kwargs)
        return {"scheduled": True}

    monkeypatch.setattr(
        "app.services.knowledge.orchestrator.knowledge_orchestrator"
        ".attach_external_document_content",
        fake_attach,
    )

    _run_task(document.id)

    task_db.refresh(document)
    assert document.index_generation == 1
    assert attached["generation"] == 1


def test_task_skips_already_imported_document(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    document = _create_placeholder(task_db, test_user.id)
    document.index_status = DocumentIndexStatus.SUCCESS
    document.index_generation = 3
    task_db.commit()
    provider = SimpleNamespace(fetch_content=AsyncMock())
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import"
        ".get_external_document_provider",
        lambda provider_id: provider,
    )

    _run_task(document.id)

    provider.fetch_content.assert_not_awaited()
    task_db.refresh(document)
    assert document.index_status == DocumentIndexStatus.SUCCESS
    assert document.index_generation == 3


@pytest.mark.parametrize("index_status", list(DocumentIndexStatus))
def test_old_task_cannot_replace_a_newer_attempt(
    task_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    index_status: DocumentIndexStatus,
) -> None:
    document = _create_placeholder(task_db, test_user.id)
    document.index_status = index_status
    document.index_generation = 2
    task_db.commit()
    provider = SimpleNamespace(
        fetch_content=AsyncMock(side_effect=RuntimeError("source unavailable"))
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import.get_external_document_provider",
        lambda provider_id: provider,
    )

    _run_task(document.id)

    provider.fetch_content.assert_not_awaited()
    task_db.refresh(document)
    assert document.index_status == index_status
    assert document.index_generation == 2
    assert document.processing_error_payload is None


def test_redelivery_during_fetch_does_not_read_source_again(
    task_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    document = _create_placeholder(task_db, test_user.id)

    async def fetch(*args):
        _run_task(document.id)
        raise RuntimeError("source unavailable")

    provider = SimpleNamespace(fetch_content=AsyncMock(side_effect=fetch))
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import.get_external_document_provider",
        lambda provider_id: provider,
    )

    _run_task(document.id)

    provider.fetch_content.assert_awaited_once()
    task_db.refresh(document)
    assert document.index_generation == 1
    assert document.index_status == DocumentIndexStatus.FAILED


def test_retry_dispatches_a_new_generation_and_ignores_the_old_message(
    task_db: Session, test_user: User, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.services.knowledge.external_document_import import (
        external_document_import_service,
    )

    document = _create_placeholder(task_db, test_user.id)
    provider = SimpleNamespace(
        fetch_content=AsyncMock(side_effect=RuntimeError("source unavailable"))
    )
    monkeypatch.setattr(
        "app.services.knowledge.external_document_import.get_external_document_provider",
        lambda provider_id: provider,
    )
    _run_task(document.id)
    dispatched = []
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.import_external_document_task.delay",
        lambda **kwargs: dispatched.append(kwargs),
    )
    external_document_import_service.retry_document_import(
        task_db, test_user, document.id
    )

    _run_task(document.id)
    provider.fetch_content.assert_awaited_once()
    assert dispatched == [{"document_id": document.id, "expected_generation": 2}]
    _run_task(**dispatched[0])

    assert provider.fetch_content.await_count == 2
    task_db.refresh(document)
    assert document.index_generation == 3
