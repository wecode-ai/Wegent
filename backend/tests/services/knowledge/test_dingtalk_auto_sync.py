# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Automatic refresh preserves the existing imported-copy contract."""

import logging
from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus
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
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService

from .conftest import create_external_import_kb, create_synced_node


@pytest.fixture
def import_dispatches(monkeypatch) -> list[dict]:
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
def live_update_time(monkeypatch):
    probe = AsyncMock(return_value=1789562644000)
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "get_update_time", probe
    )
    return probe


def test_auto_sync_defaults_off_and_can_be_enabled_and_disabled(test_db, test_user):
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
def imported_copy(test_db, test_user, configured_dingtalk, import_dispatches):
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
    test_db, test_user, imported_copy, monkeypatch, import_dispatches
):
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
    test_db, imported_copy, live_update_time, import_dispatches, caplog
):
    """A probe without a live time is no evidence that the copy changed."""
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    imported_copy.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()
    live_update_time.return_value = None
    generation = imported_copy.index_generation

    with caplog.at_level(logging.INFO):
        assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is False

    test_db.refresh(imported_copy)
    assert imported_copy.is_active is True
    assert imported_copy.attachment_id == 1234
    assert imported_copy.index_generation == generation
    assert imported_copy.external_source_config["source_update_time"] == 1789562644000
    assert import_dispatches == []
    line = _decision_line(caplog, "unchanged")
    assert "baseline_update_time=1789562644000" in line
    assert "live_update_time=unavailable" in line


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
    test_db, imported_copy, monkeypatch, live_update_time, import_dispatches, reason
):
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
    test_db, imported_copy, live_update_time
):
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
    test_db, test_user, imported_copy
):
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


def test_failed_body_fetch_cannot_mark_old_attachment_as_current(
    test_db, test_user, imported_copy, monkeypatch, import_dispatches
):
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )
    from app.services.knowledge.index_state_machine import (
        mark_document_index_succeeded,
        prepare_document_index_enqueue,
    )

    imported_copy.attachment_id = 1234
    imported_copy.is_active = True
    imported_copy.update_external_source_config(source_update_time=1789562600000)
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
    assert imported_copy.index_status == DocumentIndexStatus.FAILED
    assert "source_update_time" not in imported_copy.external_source_config
    # Reindexing the retained attachment must not turn a failed fetch into a baseline.
    decision = prepare_document_index_enqueue(test_db, imported_copy.id)
    assert mark_document_index_succeeded(test_db, imported_copy.id, decision.generation)
    test_db.refresh(imported_copy)
    assert imported_copy.index_status == DocumentIndexStatus.SUCCESS
    import_dispatches.clear()
    assert refresh_dingtalk_copy(
        test_db, imported_copy.id, imported_copy.index_generation
    )
    assert [call["document_id"] for call in import_dispatches] == [imported_copy.id]
    assert fetch.await_count == 1


def test_auto_update_refreshes_a_changed_copy_once(
    test_db, test_user, imported_copy, monkeypatch, import_dispatches
):
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
    test_db, test_user, imported_copy, monkeypatch, import_dispatches, reason
):
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
    test_db, test_user, imported_copy, monkeypatch, import_dispatches
):
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
    test_db, test_user, imported_copy, monkeypatch, import_dispatches
):
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


@pytest.mark.parametrize("change", ["disable", "delete", "new_generation"])
def test_changes_during_probe_prevent_refresh(
    test_db, imported_copy, monkeypatch, live_update_time, import_dispatches, change
):
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


@pytest.mark.parametrize("enabled", [True, False])
def test_create_preserves_auto_sync_setting(test_db, test_user, enabled):
    kb_id = KnowledgeService.create_knowledge_base(
        test_db,
        test_user.id,
        KnowledgeBaseCreate(
            name="create-auto-sync", dingtalk_auto_sync_enabled=enabled
        ),
    )
    kb = test_db.get(Kind, kb_id)
    assert KnowledgeBaseResponse.from_kind(kb).dingtalk_auto_sync_enabled is enabled


def _decision_line(caplog, decision: str) -> str:
    """Return the single sync decision line a test asserted about."""
    return next(
        record.getMessage()
        for record in caplog.records
        if f"decision={decision} " in record.getMessage()
    )


def test_unchanged_copy_logs_the_compared_timestamps(
    test_db, imported_copy, live_update_time, caplog
):
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    live_update_time.return_value = 1789562644000
    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    imported_copy.update_external_source_config(source_update_time=1789562644000)
    test_db.commit()

    with caplog.at_level(logging.INFO):
        assert (
            refresh_dingtalk_copy(
                test_db, imported_copy.id, imported_copy.index_generation
            )
            is False
        )

    line = _decision_line(caplog, "unchanged")
    assert f"document_id={imported_copy.id}" in line
    assert "baseline_update_time=1789562644000" in line
    assert "live_update_time=1789562644000" in line


def test_ineligible_copy_logs_the_rejection_reason(
    test_db, test_user, imported_copy, caplog
):
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    KnowledgeService.update_knowledge_base(
        test_db,
        imported_copy.kind_id,
        test_user.id,
        KnowledgeBaseUpdate(dingtalk_auto_sync_enabled=False),
    )

    with caplog.at_level(logging.INFO):
        assert (
            refresh_dingtalk_copy(
                test_db, imported_copy.id, imported_copy.index_generation
            )
            is False
        )

    line = _decision_line(caplog, "not_eligible")
    assert "reason=auto_sync_disabled" in line
    assert f"document_id={imported_copy.id}" in line


def test_missing_live_timestamp_is_marked_in_the_refresh_decision(
    test_db, imported_copy, live_update_time, import_dispatches, caplog
):
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    test_db.commit()
    live_update_time.return_value = None

    with caplog.at_level(logging.INFO):
        assert (
            refresh_dingtalk_copy(
                test_db, imported_copy.id, imported_copy.index_generation
            )
            is True
        )

    line = _decision_line(caplog, "refresh")
    assert "live_update_time=unavailable" in line


def test_probe_failure_logs_its_cause_as_a_warning(
    test_db, imported_copy, live_update_time, caplog
):
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy
    from app.services.knowledge.external_document_providers import (
        ExternalDocumentFetchError,
    )

    live_update_time.side_effect = ExternalDocumentFetchError(
        "DingTalk metadata read failed: TimeoutError"
    )

    with caplog.at_level(logging.INFO):
        assert (
            refresh_dingtalk_copy(
                test_db, imported_copy.id, imported_copy.index_generation
            )
            is False
        )

    line = _decision_line(caplog, "probe_failed")
    assert "error=DingTalk metadata read failed: TimeoutError" in line
    assert any(
        record.levelno == logging.WARNING
        and "decision=probe_failed" in record.getMessage()
        for record in caplog.records
    )


def test_refresh_and_body_landing_log_source_timestamps(
    test_db,
    test_user,
    imported_copy,
    monkeypatch,
    import_dispatches,
    caplog,
):
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
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.delay",
        MagicMock(return_value=SimpleNamespace(id="index-task")),
    )
    imported_copy.is_active = True
    imported_copy.attachment_id = 1234
    imported_copy.update_external_source_config(source_update_time=1789562600000)
    test_db.commit()
    generation = imported_copy.index_generation

    with caplog.at_level(logging.INFO):
        assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is True
        new_generation = imported_copy.index_generation
        run_external_document_import(
            test_db, imported_copy, test_user, generation=new_generation
        )

    refresh_line = _decision_line(caplog, "refresh")
    assert "baseline_update_time=1789562600000" in refresh_line
    assert "live_update_time=1789562644000" in refresh_line
    assert "index_status_before=success" in refresh_line
    assert f"next_generation={new_generation}" in refresh_line

    landed_line = next(
        record.getMessage()
        for record in caplog.records
        if "Body landed" in record.getMessage()
    )
    assert f"document_id={imported_copy.id}" in landed_line
    assert "content_bytes=11" in landed_line
    assert "provider_update_time=1789562644000" in landed_line


def test_scan_logs_dispatched_copies_with_their_task_ids(
    test_db, imported_copy, monkeypatch, import_dispatches, caplog
):
    from app.tasks import dingtalk_auto_sync_tasks as tasks

    monkeypatch.setattr(tasks, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(
        tasks.refresh_dingtalk_copy_task,
        "apply_async",
        lambda **kwargs: SimpleNamespace(id="refresh-task-1"),
    )
    monkeypatch.setattr(
        "app.core.distributed_lock.distributed_lock.acquire_context",
        lambda *args, **kwargs: nullcontext(True),
    )

    with caplog.at_level(logging.INFO):
        assert tasks.scan_dingtalk_copies(imported_copy.kind_id) == 1

    dispatched = _decision_line(caplog, "scan_dispatched")
    assert f"document_id={imported_copy.id}" in dispatched
    assert "refresh_task_id=refresh-task-1" in dispatched
    done = _decision_line(caplog, "scan_done")
    assert "copies_examined=1" in done
    assert "copies_dispatched=1" in done


def test_scan_logs_lock_contention_instead_of_a_silent_zero(
    test_db, imported_copy, monkeypatch, caplog
):
    from app.tasks import dingtalk_auto_sync_tasks as tasks

    monkeypatch.setattr(tasks, "SessionLocal", lambda: nullcontext(test_db))
    monkeypatch.setattr(
        "app.core.distributed_lock.distributed_lock.acquire_context",
        lambda *args, **kwargs: nullcontext(False),
    )

    with caplog.at_level(logging.INFO):
        assert tasks.scan_dingtalk_copies(imported_copy.kind_id) == 0

    skipped = _decision_line(caplog, "scan_skipped")
    assert "reason=lock_not_acquired" in skipped
    assert f"kb_id={imported_copy.kind_id}" in skipped
