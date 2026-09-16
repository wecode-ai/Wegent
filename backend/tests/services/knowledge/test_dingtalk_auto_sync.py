# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Automatic refresh preserves the existing imported-copy contract."""

from contextlib import nullcontext
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.models.kind import Kind
from app.models.knowledge import DocumentIndexStatus
from app.schemas.knowledge import KnowledgeBaseResponse, KnowledgeBaseUpdate
from app.services.knowledge.external_document_import import (
    external_document_import_service,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService

from .conftest import create_external_import_kb, create_synced_node


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
def imported_copy(test_db, test_user, configured_dingtalk, dispatched):
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
    return document


def test_auto_update_refreshes_same_copy_once_without_directory_cache(
    test_db, test_user, imported_copy, monkeypatch
):
    from app.models.dingtalk_doc import DingtalkSyncedNode
    from app.services.knowledge.dingtalk_auto_sync import refresh_dingtalk_copy

    test_db.query(DingtalkSyncedNode).delete()
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="Updated source", file_extension="md", content=b"new content"
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
    assert refresh_dingtalk_copy(test_db, imported_copy.id, generation) is False
    fetch.assert_awaited_once()


@pytest.mark.parametrize(
    "reason", ["disabled", "deleted", "permission", "inactive_user", "processing"]
)
def test_auto_update_rechecks_eligibility_at_execution(
    test_db, test_user, imported_copy, monkeypatch, reason
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


def test_scan_pages_enabled_copies_and_isolates_dispatch_failure(
    test_db, test_user, imported_copy, monkeypatch, dispatched
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
    test_db, test_user, imported_copy, monkeypatch
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
    current = KnowledgeService.get_document(test_db, imported_copy.id, test_user.id)
    assert current.index_status == DocumentIndexStatus.FAILED
    assert current.external_source_config["status"] == "inaccessible"
    assert refresh_dingtalk_copy(test_db, current.id, current.index_generation)
    assert fetch.await_count == 2
