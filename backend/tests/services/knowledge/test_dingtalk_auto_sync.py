# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Automatic refresh preserves the existing imported-copy contract."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus, KnowledgeDocument
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeBaseResponse,
    KnowledgeBaseUpdate,
)
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalSourceUnavailableError,
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService

from .conftest import create_external_import_kb, create_synced_node


@pytest.fixture
def import_dispatches(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Record queued import attempts instead of publishing to the broker."""
    from app.tasks import knowledge_tasks

    calls: list[dict] = []
    monkeypatch.setattr(
        knowledge_tasks,
        "import_external_document_task",
        SimpleNamespace(delay=lambda **kwargs: calls.append(kwargs)),
    )
    return calls


@pytest.fixture(autouse=True)
def live_update_time(monkeypatch: pytest.MonkeyPatch) -> AsyncMock:
    probe = AsyncMock(return_value=1789562644000)
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "get_update_time", probe
    )
    return probe


def test_auto_sync_defaults_off_and_can_be_enabled_and_disabled(
    test_db: Session, test_user: User
) -> None:
    kb_id = create_external_import_kb(test_db, test_user.id)
    kb = test_db.get(Kind, kb_id)
    assert KnowledgeBaseResponse.from_kind(kb).dingtalk_auto_sync_enabled is False

    for enabled in (True, False):
        KnowledgeService.update_knowledge_base(
            test_db,
            kb_id,
            test_user.id,
            KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=enabled),
        )
        test_db.refresh(kb)
        assert KnowledgeBaseResponse.from_kind(kb).dingtalk_auto_sync_enabled is enabled


@pytest.fixture
def imported_copy(
    test_db: Session,
    test_user: User,
    configured_dingtalk: None,
    import_dispatches: list[dict],
) -> KnowledgeDocument:
    kb_id = create_external_import_kb(test_db, test_user.id)
    node = create_synced_node(test_db, test_user.id, "auto-copy")
    document = external_document_import_service.import_document(
        test_db, test_user, kb_id, "dingtalk", node.dingtalk_node_id
    )
    document.index_status = DocumentIndexStatus.SUCCESS
    kb = test_db.get(Kind, kb_id)
    kb.json = {
        **kb.json,
        "spec": {
            **kb.json["spec"],
            "retrievalConfig": {
                "retriever_name": "test-retriever",
                "embedding_config": {"model_name": "test-embedding"},
            },
        },
    }
    test_db.commit()
    KnowledgeService.update_knowledge_base(
        test_db,
        kb_id,
        test_user.id,
        KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=True),
    )
    import_dispatches.clear()
    return document


def test_unchanged_copy_stays_available_without_fetching_content(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    imported_copy.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()
    provider = get_external_document_provider("dingtalk")
    monkeypatch.setattr(
        provider, "get_update_time", AsyncMock(return_value=1789562644000)
    )
    fetch = AsyncMock()
    monkeypatch.setattr(provider, "fetch_content", fetch)
    generation = imported_copy.index_generation

    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is False
    test_db.refresh(imported_copy)
    assert imported_copy.is_active is True
    assert imported_copy.index_status == DocumentIndexStatus.SUCCESS
    assert imported_copy.index_generation == generation
    fetch.assert_not_awaited()
    assert import_dispatches == []


def test_missing_live_timestamp_keeps_an_available_copy(
    test_db: Session,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    """A probe without a live time is no evidence that the copy changed."""
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    imported_copy.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()
    live_update_time.return_value = None
    generation = imported_copy.index_generation

    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is False

    test_db.refresh(imported_copy)
    assert imported_copy.is_active is True
    assert imported_copy.attachment_id == 1234
    assert imported_copy.index_generation == generation
    assert imported_copy.external_source_config["source_update_time"] == 1789562644000
    assert import_dispatches == []


@pytest.mark.parametrize(
    "reason",
    [
        "changed",
        "missing_baseline",
        "missing_time_without_baseline",
        "missing_time_failed",
        "failed",
        "inactive",
        "no_attachment",
    ],
)
def test_copy_needing_update_is_not_skipped(
    test_db: Session,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
    reason: str,
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )

    imported_copy.is_active = reason != "inactive"
    imported_copy.attachment_id = 0 if reason == "no_attachment" else 1234
    imported_copy.update_external_source_config(
        source_update_time=(
            None
            if reason in ("missing_baseline", "missing_time_without_baseline")
            else 1789562644000
        )
    )
    if reason == "changed":
        live_update_time.return_value = 1789562645000
    if reason in ("missing_time_without_baseline", "missing_time_failed"):
        live_update_time.return_value = None
    if reason in ("failed", "missing_time_failed"):
        imported_copy.index_status = DocumentIndexStatus.FAILED
    test_db.commit()
    generation = imported_copy.index_generation
    fetch = AsyncMock(side_effect=ExternalDocumentFetchError("Source fetch attempted"))
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is True
    test_db.refresh(imported_copy)
    assert imported_copy.is_active is False
    assert [call["document_id"] for call in import_dispatches] == [imported_copy.id]
    # The probe only decides; the body belongs to the queued worker.
    fetch.assert_not_awaited()


def test_probe_failure_preserves_available_copy(
    test_db: Session,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )

    imported_copy.is_active = True
    test_db.commit()
    generation = imported_copy.index_generation
    live_update_time.side_effect = ExternalDocumentFetchError("Probe failed")
    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is False
    test_db.refresh(imported_copy)
    assert imported_copy.is_active is True
    assert imported_copy.index_status == DocumentIndexStatus.SUCCESS
    assert imported_copy.index_generation == generation


def test_manual_reimport_invalidates_automatic_baseline(
    test_db: Session, test_user: User, imported_copy: KnowledgeDocument
) -> None:
    imported_copy.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()
    external_document_import_service.import_document(
        test_db,
        test_user,
        imported_copy.kind_id,
        "dingtalk",
        imported_copy.external_resource_id,
    )
    test_db.refresh(imported_copy)
    assert "source_update_time" not in imported_copy.external_source_config


def test_failed_body_fetch_keeps_old_attachment_without_marking_it_current(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )

    imported_copy.attachment_id = 1234
    imported_copy.is_active = True
    imported_copy.update_external_source_config(
        source_update_time=1789562600000,
        last_success_at="2026-09-17T00:00:00+00:00",
    )
    test_db.commit()
    fetch = AsyncMock(side_effect=ExternalDocumentFetchError("New body unavailable"))
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    assert refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )
    # The queued task owns the body fetch; drive that same body here.
    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )
    test_db.refresh(imported_copy)
    assert imported_copy.attachment_id == 1234
    assert imported_copy.index_status == DocumentIndexStatus.SUCCESS
    assert imported_copy.is_active is True
    assert "source_update_time" not in imported_copy.external_source_config
    # The failed fetch established no new source baseline, so the next scan
    # must try again even while the old attachment remains available.
    import_dispatches.clear()
    assert refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )
    assert [call["document_id"] for call in import_dispatches] == [imported_copy.id]
    assert fetch.await_count == 1


def test_auto_update_refreshes_a_changed_copy_once(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="Updated source",
            file_extension="md",
            content=b"new content",
            metadata={"source_update_time": 1789562644000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge.index_state_machine import mark_document_index_succeeded

    index_task = MagicMock(return_value=SimpleNamespace(id="index-task"))
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.delay", index_task
    )
    generation = imported_copy.index_generation
    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is True
    assert [call["document_id"] for call in import_dispatches] == [imported_copy.id]
    # The queued task owns the body fetch; drive that same body here.
    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )
    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    index_task.assert_called_once()
    assert current.index_status == DocumentIndexStatus.QUEUED
    assert (
        test_db.get(SubtaskContext, current.attachment_id).extracted_text
        == "new content"
    )
    assert mark_document_index_succeeded(test_db, current.id, current.index_generation)
    assert current.external_resource_id == "auto-copy"
    assert current.external_source_config["last_success_at"]
    assert current.external_source_config["source_update_time"] == 1789562644000
    # The next cycle compares that baseline against the live timestamp and skips.
    test_db.refresh(current)
    current.is_active = True
    test_db.commit()
    assert refresh_dingtalk_copy(test_db, current.id, current.index_generation) is False
    fetch.assert_awaited_once()


@pytest.mark.parametrize(
    "reason", ["disabled", "deleted", "permission", "inactive_user", "processing"]
)
def test_auto_update_rechecks_eligibility_at_execution(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
    reason: str,
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    doc_id, generation = imported_copy.id, imported_copy.index_generation
    if reason == "disabled":
        KnowledgeService.update_knowledge_base(
            test_db,
            imported_copy.kind_id,
            test_user.id,
            KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=False),
        )
    elif reason == "deleted":
        test_db.delete(imported_copy)
    elif reason == "permission":
        monkeypatch.setattr(
            KnowledgeService, "can_manage_knowledge_base_documents", lambda *args: False
        )
    elif reason == "inactive_user":
        test_user.is_active = False
    else:
        imported_copy.index_status = DocumentIndexStatus.QUEUED
    test_db.commit()
    fetch = AsyncMock()
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    assert refresh_dingtalk_copy(test_db, doc_id, generation) is False
    fetch.assert_not_awaited()
    assert import_dispatches == []


def test_scan_pages_enabled_copies_and_isolates_dispatch_failure(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    from app.tasks import dingtalk_auto_sync_tasks as tasks

    ids = [imported_copy.id]
    for source in ("second-copy", "third-copy"):
        create_synced_node(test_db, test_user.id, source)
        doc = external_document_import_service.import_document(
            test_db, test_user, imported_copy.kind_id, "dingtalk", source
        )
        doc.index_status = DocumentIndexStatus.SUCCESS
        ids.append(doc.id)
    test_db.commit()
    calls = []

    def dispatch(*, args, expires):
        calls.append(args[0])
        if args[0] == ids[0]:
            raise RuntimeError("broker unavailable")

    monkeypatch.setattr(tasks, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(tasks, "BATCH_SIZE", 1)
    monkeypatch.setattr(tasks.refresh_dingtalk_copy_task, "apply_async", dispatch)
    monkeypatch.setattr(
        "app.core.distributed_lock.distributed_lock.acquire_context",
        lambda *args, **kwargs: nullcontext(True),
    )
    assert tasks.scan_dingtalk_copies() == 2
    assert calls == ids

    calls.clear()
    other_kb = create_external_import_kb(test_db, test_user.id, "another-kb")
    assert tasks.scan_dingtalk_copies(other_kb) == 0
    assert calls == []
    assert tasks.scan_dingtalk_copies(imported_copy.kind_id) == 2
    assert calls == ids

    KnowledgeService.update_knowledge_base(
        test_db,
        imported_copy.kind_id,
        test_user.id,
        KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=False),
    )
    calls.clear()
    assert tasks.scan_dingtalk_copies() == 0
    assert calls == []


def test_failed_source_keeps_copy_and_can_update_next_cycle(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalSourceUnavailableError,
    )

    fetch = AsyncMock(side_effect=ExternalSourceUnavailableError("Access revoked"))
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    assert refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )
    # The queued task owns the body fetch; drive that same body here.
    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )
    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.index_status == DocumentIndexStatus.FAILED
    assert current.external_source_config["status"] == "inaccessible"
    import_dispatches.clear()
    assert refresh_dingtalk_copy(test_db, current.id, current.index_generation)
    assert [call["document_id"] for call in import_dispatches] == [current.id]
    assert fetch.await_count == 1


def _serve_existing_content(
    test_db: Session, document: KnowledgeDocument, text: str
) -> int:
    """Leave the copy exactly as a successful import does: active with a body."""
    from app.models.subtask_context import SubtaskContext
    from shared.models.db import ContextStatus, ContextType

    attachment = SubtaskContext(
        subtask_id=0,
        user_id=document.user_id,
        context_type=ContextType.ATTACHMENT.value,
        name="copy.md",
        status=ContextStatus.READY.value,
        extracted_text=text,
    )
    test_db.add(attachment)
    test_db.commit()
    test_db.refresh(attachment)
    document.is_active = True
    document.attachment_id = attachment.id
    document.index_status = DocumentIndexStatus.SUCCESS
    document.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()
    return attachment.id


def test_deleted_source_marks_the_copy_inaccessible_and_keeps_its_content(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalSourceUnavailableError,
    )

    attachment_id = _serve_existing_content(test_db, imported_copy, "导入时的正文")
    live_update_time.side_effect = ExternalSourceUnavailableError(
        "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)",
        error_code="external_source_missing",
    )

    assert (
        refresh_dingtalk_copy(test_db, imported_copy.id, imported_copy.index_generation)
        is False
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    external = current.external_source_config
    assert external["status"] == "inaccessible"
    assert (
        external["last_error"]
        == "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)"
    )
    assert external["sync"]["last_error_code"] == "external_source_missing"
    assert external["sync"]["last_checked_at"]
    # The copy keeps serving its last successful body and index.
    assert current.index_status == DocumentIndexStatus.SUCCESS
    assert current.is_active is True
    assert current.attachment_id == attachment_id
    assert test_db.get(SubtaskContext, attachment_id).extracted_text == "导入时的正文"
    assert import_dispatches == []


def test_transient_probe_failure_keeps_the_copy_usable(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )

    attachment_id = _serve_existing_content(test_db, imported_copy, "导入时的正文")
    live_update_time.side_effect = ExternalDocumentFetchError(
        "DingTalk metadata read timed out"
    )

    assert (
        refresh_dingtalk_copy(test_db, imported_copy.id, imported_copy.index_generation)
        is False
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    external = current.external_source_config
    # A check that proves nothing about the source must not claim it is gone.
    assert external["status"] != "inaccessible"
    assert external["sync"]["last_error_code"] == "external_sync_check_failed"
    # The transient reason itself stays visible to the user.
    assert external["last_error"] == "DingTalk metadata read timed out"
    assert current.index_status == DocumentIndexStatus.SUCCESS
    assert current.is_active is True
    assert current.attachment_id == attachment_id
    assert import_dispatches == []


def test_repeated_probe_failure_keeps_the_recorded_reason(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
        ExternalSourceUnavailableError,
    )

    _serve_existing_content(test_db, imported_copy, "导入时的正文")
    live_update_time.side_effect = ExternalSourceUnavailableError(
        "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)",
        error_code="external_source_missing",
    )
    assert not refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )

    live_update_time.side_effect = ExternalDocumentFetchError(
        "DingTalk metadata read failed: ClientError"
    )
    assert not refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    external = current.external_source_config
    # The later inconclusive check keeps the earlier specific reason.
    assert external["status"] == "inaccessible"
    assert (
        external["last_error"]
        == "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)"
    )
    assert external["sync"]["last_error_code"] == "external_source_missing"


def test_recovered_source_returns_to_accessible(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalSourceUnavailableError,
    )

    _serve_existing_content(test_db, imported_copy, "导入时的正文")
    live_update_time.side_effect = ExternalSourceUnavailableError(
        "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)",
        error_code="external_source_missing",
    )
    assert not refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )

    # The next cycle reaches the source again and finds it unchanged.
    live_update_time.side_effect = None
    live_update_time.return_value = 1789562644000
    assert not refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    external = current.external_source_config
    assert external["status"] == "accessible"
    assert "last_error" not in external
    assert "last_error_code" not in external["sync"]
    assert current.index_status == DocumentIndexStatus.SUCCESS
    assert import_dispatches == []


def test_landed_body_restores_accessible_after_a_deleted_source(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    """A manual reimport that reads the source again clears the warning."""
    from app.services.knowledge.index_state_machine import mark_document_index_succeeded

    imported_copy.update_external_source_config(
        status="inaccessible",
        last_error="workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)",
        sync={
            "last_checked_at": "2026-09-17T00:00:00+00:00",
            "last_error_code": "external_source_missing",
        },
    )
    imported_copy.index_status = DocumentIndexStatus.QUEUED
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="恢复的正文",
            file_extension="md",
            content=b"restored content",
            metadata={"source_update_time": 1789562649000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.delay",
        MagicMock(return_value=SimpleNamespace(id="index-task")),
    )

    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )
    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.external_source_config["status"] == "accessible"
    assert "last_error" not in current.external_source_config
    assert mark_document_index_succeeded(test_db, current.id, current.index_generation)
    test_db.refresh(current)
    external = current.external_source_config
    assert external["status"] == "accessible"
    assert "last_error" not in external
    assert "last_error_code" not in external["sync"]


@pytest.mark.parametrize("change", ["disable", "delete", "new_generation"])
def test_changes_during_probe_prevent_refresh(
    test_db: Session,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
    change: str,
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    document_id, generation = imported_copy.id, imported_copy.index_generation

    async def probe(*args):
        if change == "delete":
            test_db.delete(imported_copy)
        elif change == "disable":
            kb = test_db.get(Kind, imported_copy.kind_id)
            kb.json = {
                **kb.json,
                "spec": {**kb.json["spec"], "dingtalkAutoSyncEnabled": False},
            }
        else:
            imported_copy.index_generation += 1
        test_db.commit()
        return 1789562644000

    live_update_time.side_effect = probe
    fetch = AsyncMock()
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    assert refresh_dingtalk_copy(test_db, document_id, generation) is False
    fetch.assert_not_awaited()
    assert import_dispatches == []


@pytest.mark.parametrize("probe_result", ["success", "missing", "transient"])
def test_old_probe_does_not_overwrite_a_newer_generation(
    test_db: Session,
    imported_copy: KnowledgeDocument,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
    probe_result: str,
) -> None:
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    document_id = imported_copy.id
    generation = imported_copy.index_generation

    async def probe(*args):
        imported_copy.index_generation += 1
        imported_copy.update_external_source_config(
            status="sync_error",
            last_error="newer attempt failed",
            sync={"last_error_code": "newer_attempt"},
        )
        test_db.commit()
        if probe_result == "missing":
            raise ExternalSourceUnavailableError("old source result")
        if probe_result == "transient":
            raise ExternalDocumentFetchError("old probe failed")
        return 1789562644000

    live_update_time.side_effect = probe

    assert not refresh_dingtalk_copy(test_db, document_id, generation)
    test_db.refresh(imported_copy)
    assert imported_copy.index_generation == generation + 1
    assert imported_copy.external_source_config["status"] == "sync_error"
    assert imported_copy.external_source_config["last_error"] == "newer attempt failed"
    assert imported_copy.external_source_config["sync"] == {
        "last_error_code": "newer_attempt"
    }
    assert import_dispatches == []


@pytest.mark.parametrize("enabled", [True, False])
def test_create_preserves_auto_sync_setting(
    test_db: Session, test_user: User, enabled: bool
) -> None:
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(
            name="create-auto-sync", dingtalk_auto_sync_enabled=enabled
        ),
    )
    kb = test_db.get(Kind, kb_id)
    assert KnowledgeBaseResponse.from_kind(kb).dingtalk_auto_sync_enabled is enabled


def test_scan_dispatches_nothing_while_another_scan_holds_the_lock(
    test_db: Session, imported_copy: KnowledgeDocument, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Lock contention must skip the run rather than double-dispatch copies."""
    from app.tasks import dingtalk_auto_sync_tasks as tasks

    monkeypatch.setattr(tasks, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(
        "app.core.distributed_lock.distributed_lock.acquire_context",
        lambda *args, **kwargs: nullcontext(False),
    )
    monkeypatch.setattr(
        tasks.refresh_dingtalk_copy_task,
        "apply_async",
        lambda **kwargs: pytest.fail("dispatched while another scan held the lock"),
    )

    assert tasks.scan_dingtalk_copies(imported_copy.kind_id) == 0


def _mock_index_task(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.delay",
        MagicMock(return_value=SimpleNamespace(id="index-task")),
    )


def test_auto_sync_success_renames_the_copy_to_the_latest_source_name(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    """The daily sync lands the source's latest title on the copy."""
    from app.models.subtask_context import SubtaskContext
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地旧名称"
    test_db.commit()
    live_update_time.return_value = 1789562645000
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="最新来源名称",
            file_extension="md",
            content=b"new body",
            metadata={"title": "最新来源名称", "source_update_time": 1789562645000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    _mock_index_task(monkeypatch)

    assert refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )
    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "最新来源名称"
    assert (
        test_db.get(SubtaskContext, current.attachment_id).extracted_text == "new body"
    )


def test_manual_sync_success_renames_the_copy_to_the_latest_source_name(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    """The per-document manual trigger lands the source's latest title too."""
    from app.models.subtask_context import SubtaskContext

    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地旧名称"
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="最新来源名称",
            file_extension="md",
            content=b"new body",
            metadata={"title": "最新来源名称", "source_update_time": 1789562645000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    _mock_index_task(monkeypatch)

    refreshed = external_document_import_service.request_source_refresh(
        test_db, test_user, imported_copy.id
    )
    run_external_document_import(
        test_db, refreshed, test_user, generation=refreshed.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "最新来源名称"
    assert (
        test_db.get(SubtaskContext, current.attachment_id).extracted_text == "new body"
    )


def test_manual_reimport_renames_the_copy_to_the_latest_source_name(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    """A repeated import resolves the node's current title and lands it."""
    from app.models.dingtalk_doc import DingtalkSyncedNode
    from app.models.subtask_context import SubtaskContext

    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地旧名称"
    test_db.commit()
    node = (
        test_db.query(DingtalkSyncedNode)
        .filter(
            DingtalkSyncedNode.user_id == test_user.id,
            DingtalkSyncedNode.dingtalk_node_id == imported_copy.external_resource_id,
        )
        .first()
    )
    assert node is not None
    node.name = "重命名的来源"
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="重命名的来源",
            file_extension="md",
            content=b"new body",
            metadata={"title": "重命名的来源", "source_update_time": 1789562645000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    _mock_index_task(monkeypatch)

    external_document_import_service.import_document(
        test_db,
        test_user,
        imported_copy.kind_id,
        "dingtalk",
        imported_copy.external_resource_id,
    )
    run_external_document_import(
        test_db, imported_copy, test_user, generation=imported_copy.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "重命名的来源"
    assert (
        test_db.get(SubtaskContext, current.attachment_id).extracted_text == "new body"
    )


def test_oversized_source_title_lands_truncated(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    """A source title longer than the name column lands truncated, not failing."""
    source_title = "钉" * 300
    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地旧名称"
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name=source_title,
            file_extension="md",
            content=b"new body",
            metadata={"title": source_title, "source_update_time": 1789562645000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    _mock_index_task(monkeypatch)

    refreshed = external_document_import_service.request_source_refresh(
        test_db, test_user, imported_copy.id
    )
    run_external_document_import(
        test_db, refreshed, test_user, generation=refreshed.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "钉" * 255


def test_blank_source_title_keeps_the_copy_name(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    import_dispatches: list[dict],
) -> None:
    """A source that reports no title never replaces the copy's own name."""
    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地旧名称"
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="   ",
            file_extension="md",
            content=b"new body",
            metadata={"source_update_time": 1789562645000},
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    _mock_index_task(monkeypatch)

    refreshed = external_document_import_service.request_source_refresh(
        test_db, test_user, imported_copy.id
    )
    run_external_document_import(
        test_db, refreshed, test_user, generation=refreshed.index_generation
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "本地旧名称"


def test_unchanged_source_keeps_the_copy_name(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
) -> None:
    """A probe that reports no change never reaches the body or the name."""
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地名称"
    test_db.commit()
    fetch = AsyncMock()
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )

    assert (
        refresh_dingtalk_copy(test_db, imported_copy.id, imported_copy.index_generation)
        is False
    )

    fetch.assert_not_awaited()
    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "本地名称"


@pytest.mark.parametrize(
    "probe_error",
    [
        ExternalDocumentFetchError("DingTalk metadata read timed out"),
        ExternalSourceUnavailableError(
            "workspace node has been recycled (logId 2135ce2f17897129652262261e04fa)",
            error_code="external_source_missing",
        ),
    ],
)
def test_probe_failure_never_renames_the_copy(
    test_db: Session,
    test_user: User,
    imported_copy: KnowledgeDocument,
    monkeypatch: pytest.MonkeyPatch,
    live_update_time: AsyncMock,
    import_dispatches: list[dict],
    probe_error: Exception,
) -> None:
    """A probe that cannot establish a change leaves the name untouched."""
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    _serve_existing_content(test_db, imported_copy, "旧正文")
    imported_copy.name = "本地名称"
    test_db.commit()
    live_update_time.side_effect = probe_error

    assert (
        refresh_dingtalk_copy(test_db, imported_copy.id, imported_copy.index_generation)
        is False
    )

    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.name == "本地名称"
