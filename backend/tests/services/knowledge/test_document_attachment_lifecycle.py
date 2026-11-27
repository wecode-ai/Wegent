# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression contracts for caller-authorized, independent document bodies."""

import asyncio
from contextlib import contextmanager, nullcontext
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.knowledge import KnowledgeDocumentCreate, KnowledgeDocumentResponse
from app.services.context import context_service
from app.services.knowledge.document_read_service import DocumentReadService
from app.services.knowledge.external_document_access import get_document_access_or_raise
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.knowledge.orchestrator import knowledge_orchestrator


@pytest.fixture
def bodies(monkeypatch: pytest.MonkeyPatch) -> tuple[MagicMock, dict[str, bytes]]:
    values = {}
    storage = MagicMock()
    storage.backend_type = "mysql"
    storage.get.side_effect = values.get
    storage.save.side_effect = lambda key, data, metadata: values.__setitem__(key, data)
    storage.delete.side_effect = lambda key: values.pop(key, None) is not None
    monkeypatch.setenv("ATTACHMENT_ENCRYPTION_ENABLED", "false")
    monkeypatch.setitem(
        context_service.get_attachment_binary_data.__globals__,
        "get_storage_backend",
        lambda db: storage,
    )
    return storage, values


@pytest.fixture
def kb(test_db: Session, test_user: User) -> Kind:
    record = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="attachment-lifecycle",
        namespace="default",
        json={"spec": {}},
        is_active=True,
    )
    test_db.add(record)
    test_db.commit()
    return record


def attachment(
    db: Session, user_id: int, bodies: tuple[MagicMock, dict[str, bytes]]
) -> SubtaskContext:
    record = SubtaskContext(
        user_id=user_id,
        subtask_id=0,
        context_type=ContextType.ATTACHMENT.value,
        name="source.md",
        status=ContextStatus.READY.value,
        extracted_text="original",
        text_length=8,
        type_data={
            "storage_key": "original",
            "storage_backend": "mysql",
            "original_filename": "source.md",
            "file_extension": "md",
            "file_size": 8,
            "mime_type": "text/markdown",
        },
    )
    db.add(record)
    db.commit()
    bodies[1]["original"] = b"original"
    return record


@pytest.mark.parametrize("writer", ["count", "summary"])
def test_kb_background_write_preserves_latest_web_update_switch(test_db, kb, writer):
    from app.services.knowledge.summary_service import SummaryService

    kb.json = {"spec": {"webAutoUpdateEnabled": True}}
    test_db.commit()
    assert kb.json["spec"]["webAutoUpdateEnabled"] is True
    # Keep the already loaded Kind stale while the database has the new setting.
    test_db.execute(
        update(Kind)
        .where(Kind.id == kb.id)
        .values(json={"spec": {"webAutoUpdateEnabled": False}})
        .execution_options(synchronize_session=False)
    )
    if writer == "count":
        KnowledgeService._update_document_count_cache(test_db, kb.id)
        test_db.commit()
        assert kb.json["spec"]["document_count"] == 0
    else:
        SummaryService(test_db)._write_kb_summary_failure(kb.id, "model unavailable")
        assert kb.json["spec"]["summary"]["status"] == "failed"
    assert kb.json["spec"]["webAutoUpdateEnabled"] is False


def create(
    db: Session,
    user: User,
    kb: Kind,
    source_id: int,
    entry: str = "rest",
    trigger_indexing: bool = False,
    **kwargs,
) -> KnowledgeDocumentResponse:
    if entry == "content":
        return knowledge_orchestrator.create_document_with_content(
            db,
            user,
            kb.id,
            name="copy",
            source_type="attachment",
            attachment_id=source_id,
            trigger_indexing=trigger_indexing,
            **kwargs,
        )
    return knowledge_orchestrator.create_document_from_attachment(
        db,
        user,
        kb.id,
        KnowledgeDocumentCreate(
            name="copy",
            attachment_id=source_id,
            file_extension="md",
            file_size=8,
            **kwargs,
        ),
        trigger_indexing=trigger_indexing,
    )


@pytest.mark.parametrize("entry", ["rest", "content"])
@pytest.mark.parametrize(
    "invalid", ["other_owner", "missing", "wrong_type", "not_ready"]
)
def test_invalid_source_is_rejected_before_reading_body(
    test_db,
    test_user,
    test_admin_user,
    kb,
    bodies,
    entry,
    invalid,
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    if invalid == "other_owner":
        source.user_id = test_admin_user.id
    elif invalid == "wrong_type":
        source.context_type = "knowledge_base"
    elif invalid == "not_ready":
        source.status = ContextStatus.PARSING.value
    test_db.commit()
    source_id = 99999 if invalid == "missing" else source.id

    with pytest.raises(ValueError):
        create(test_db, test_user, kb, source_id, entry)

    bodies[0].get.assert_not_called()
    assert test_db.query(KnowledgeDocument).count() == 0


def test_create_discards_user_supplied_conversion_ref(
    test_db, test_user, test_admin_user, kb, bodies
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    foreign = attachment(test_db, test_admin_user.id, bodies)
    config = {"converted_attachment_id": foreign.id, "client_note": "keep this"}

    created = create(test_db, test_user, kb, source.id, source_config=config)
    stored = test_db.get(KnowledgeDocument, created.id)

    assert stored.source_config == {"client_note": "keep this"}
    assert config == {"converted_attachment_id": foreign.id, "client_note": "keep this"}
    assert test_db.get(SubtaskContext, stored.attachment_id).user_id == test_user.id
    assert test_db.get(SubtaskContext, foreign.id).user_id == test_admin_user.id


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_repeated_import_edit_and_delete_have_independent_bodies(
    test_db,
    test_user,
    kb,
    bodies,
    entry,
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    first = create(test_db, test_user, kb, source.id, entry)
    second = create(test_db, test_user, kb, source.id, entry)

    assert len({source.id, first.attachment_id, second.attachment_id}) == 3
    first_body = context_service.get_context(test_db, first.attachment_id)
    second_body = context_service.get_context(test_db, second.attachment_id)
    assert (
        len({source.storage_key, first_body.storage_key, second_body.storage_key}) == 3
    )
    assert (
        context_service.get_attachment_binary_data(test_db, first_body) == b"original"
    )

    KnowledgeService.update_document_content(test_db, first.id, "edited", test_user.id)
    assert context_service.get_attachment_binary_data(test_db, first_body) == b"edited"
    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert (
        context_service.get_attachment_binary_data(test_db, second_body) == b"original"
    )

    assert KnowledgeService.delete_document(test_db, first.id, test_user.id).success
    assert context_service.get_context_optional(test_db, first.attachment_id) is None
    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert (
        context_service.get_attachment_binary_data(test_db, second_body) == b"original"
    )


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_failed_create_cleans_unreferenced_copy(
    test_db, test_user, kb, bodies, entry
) -> None:
    source = attachment(test_db, test_user.id, bodies)

    with pytest.raises(ValueError):
        create(test_db, test_user, kb, source.id, entry, folder_id=99999)

    assert test_db.query(KnowledgeDocument).count() == 0
    assert test_db.query(SubtaskContext).count() == 1
    assert bodies[1] == {"original": b"original"}


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_committed_document_keeps_copy_when_dispatch_fails(
    test_db,
    test_user,
    kb,
    bodies,
    entry,
    monkeypatch,
) -> None:
    from app.models.knowledge import DocumentIndexStatus
    from app.tasks.knowledge_tasks import index_document_task
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    source = attachment(test_db, test_user.id, bodies)
    test_db.add(retriever_kind(test_user.id, "retriever"))
    test_db.add(embedding_model_kind(test_user.id, "embedding"))
    kb.json = {
        "spec": {
            "retrievalConfig": {
                "retriever_name": "retriever",
                "embedding_config": {"model_name": "embedding"},
            }
        }
    }
    test_db.commit()
    enqueue = MagicMock(side_effect=RuntimeError("broker unavailable"))
    monkeypatch.setattr(index_document_task, "delay", enqueue)

    with pytest.raises(RuntimeError, match="broker unavailable"):
        create(test_db, test_user, kb, source.id, entry, trigger_indexing=True)

    document = test_db.query(KnowledgeDocument).one()
    assert document.index_status == DocumentIndexStatus.FAILED
    assert document.attachment_id != source.id
    copy = context_service.get_context(test_db, document.attachment_id)
    assert context_service.get_attachment_binary_data(test_db, copy) == b"original"
    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert test_db.query(SubtaskContext).count() == 2
    enqueue.assert_called_once()


@pytest.mark.parametrize("source_type", ["text", "file"])
def test_dedicated_content_upload_creates_one_attachment(
    test_db,
    test_user,
    kb,
    bodies,
    source_type,
) -> None:
    arguments = (
        {"content": "original"}
        if source_type == "text"
        else {
            "file_base64": "b3JpZ2luYWw=",
            "file_extension": "md",
        }
    )
    document = knowledge_orchestrator.create_document_with_content(
        test_db,
        test_user,
        kb.id,
        "fresh",
        source_type,
        trigger_indexing=False,
        **arguments,
    )

    assert test_db.query(SubtaskContext).count() == 1
    body = context_service.get_context(test_db, document.attachment_id)
    assert context_service.get_attachment_binary_data(test_db, body) == b"original"
    assert "source_attachment_id" not in body.type_data
    bodies[0].save.assert_called_once()


def test_multimodal_preflight_failure_cleans_copy(
    test_db,
    test_user,
    kb,
    bodies,
    monkeypatch,
) -> None:
    from app.core.config import settings
    from app.services.knowledge.model_ref_resolver import ModelRefResolutionError

    source = attachment(test_db, test_user.id, bodies)
    source.type_data = {
        **source.type_data,
        "file_extension": "png",
        "original_filename": "source.png",
    }
    test_db.commit()
    monkeypatch.setattr(settings, "KNOWLEDGE_MULTIMODAL_ENABLED", True)

    with pytest.raises(ModelRefResolutionError):
        create(test_db, test_user, kb, source.id, trigger_indexing=True)

    assert test_db.query(KnowledgeDocument).count() == 0
    assert test_db.query(SubtaskContext).count() == 1
    assert bodies[1] == {"original": b"original"}


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_caller_kb_owner_and_document_attachment_owner_are_distinct(
    test_db,
    test_user,
    test_admin_user,
    kb,
    bodies,
    entry,
) -> None:
    from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole

    kb.user_id = test_admin_user.id
    test_db.add(
        ResourceMember.create(
            resource_type="KnowledgeBase",
            resource_id=kb.id,
            entity_type="user",
            entity_id=str(test_user.id),
            role=ResourceRole.Developer.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_admin_user.id,
        )
    )
    test_db.commit()
    source = attachment(test_db, test_admin_user.id, bodies)
    assert KnowledgeService.can_manage_knowledge_base_documents(
        test_db, kb.id, test_user.id
    )

    with pytest.raises(ValueError):
        create(test_db, test_user, kb, source.id, entry)
    bodies[0].get.assert_not_called()

    source.user_id = test_user.id
    test_db.commit()
    first = create(test_db, test_user, kb, source.id, entry)
    second = create(test_db, test_user, kb, source.id, entry)
    first_body = context_service.get_context(test_db, first.attachment_id)
    second_body = context_service.get_context(test_db, second.attachment_id)
    assert first.user_id == first_body.user_id == test_user.id
    assert first_body.user_id != kb.user_id

    KnowledgeService.update_document_content(
        test_db, first.id, "manager edit", test_admin_user.id
    )
    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert (
        context_service.get_attachment_binary_data(test_db, second_body) == b"original"
    )
    assert KnowledgeService.delete_document(
        test_db, first.id, test_admin_user.id
    ).success
    assert context_service.get_context_optional(test_db, first.attachment_id) is None
    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert (
        context_service.get_attachment_binary_data(test_db, second_body) == b"original"
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "existing",
    [
        "owned",
        "no_reference",
        "missing",
        "foreign",
        "wrong_type",
        "indexed",
        "indexed_foreign",
    ],
)
async def test_manager_web_refresh_preserves_document_attachment_ownership(
    test_db, test_user, test_admin_user, kb, bodies, monkeypatch, existing
) -> None:
    from app.models.knowledge import DocumentIndexStatus
    from app.models.resource_member import MemberStatus, ResourceMember, ResourceRole
    from app.services.knowledge.index_state_machine import mark_document_index_started
    from app.services.knowledge.web_publication import publish_candidate
    from app.services.knowledge.web_refresh import distributed_lock
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    indexed = existing.startswith("indexed")
    foreign = existing.endswith("foreign")
    if indexed:
        kb.json = {
            "spec": {
                "retrievalConfig": {
                    "retriever_name": "web-store",
                    "embedding_config": {"model_name": "web-embed"},
                }
            }
        }
        test_db.add_all(
            [
                retriever_kind(test_user.id, "web-store"),
                embedding_model_kind(test_user.id, "web-embed"),
            ]
        )
    test_admin_user.role = "user"
    test_db.add(
        ResourceMember.create(
            resource_type="KnowledgeBase",
            resource_id=kb.id,
            entity_type="user",
            entity_id=str(test_admin_user.id),
            role=ResourceRole.Maintainer.value,
            status=MemberStatus.APPROVED.value,
            invited_by_user_id=test_user.id,
        )
    )
    source = attachment(test_db, test_user.id, bodies)
    if foreign:
        source.user_id = test_admin_user.id
    elif existing == "wrong_type":
        source.context_type = ContextType.KNOWLEDGE_BASE.value
    document = KnowledgeDocument(
        user_id=test_user.id,
        kind_id=kb.id,
        attachment_id=(
            None
            if existing == "no_reference"
            else 99999 if existing == "missing" else source.id
        ),
        name="page.md",
        file_extension="md",
        source_type="web",
        source_config={"url": "https://example.com/page"},
        is_active=True,
        status="enabled",
        index_status=(
            DocumentIndexStatus.SUCCESS if indexed else DocumentIndexStatus.NOT_INDEXED
        ),
    )
    test_db.add(document)
    test_db.commit()
    assert KnowledgeService.can_manage_knowledge_document(
        test_db, kb.id, test_admin_user.id, test_user.id
    )
    if foreign or existing == "wrong_type":
        assert not get_document_access_or_raise(
            test_db, user_id=test_admin_user.id, document_id=document.id
        ).content_readable
    lease = MagicMock()
    lease.owned.return_value = True
    monkeypatch.setattr(
        distributed_lock,
        "owned_watchdog_context",
        lambda *a, **kw: nullcontext(lease),
    )
    scraped_content = "# Refreshed page\n\nNew body."
    scraper = SimpleNamespace(
        scrape_url=AsyncMock(
            return_value=SimpleNamespace(
                success=True,
                content=scraped_content,
                url="https://example.com/page",
                title="Page",
                description=None,
                scraped_at=datetime.now(timezone.utc),
            )
        )
    )
    monkeypatch.setattr(
        "app.services.knowledge.web_refresh.scrape_with_domain_lease",
        scraper.scrape_url,
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.apply_async", MagicMock()
    )

    result = await knowledge_orchestrator.refresh_web_document(
        test_db, test_admin_user, document.id, trigger_indexing=indexed
    )

    assert result["success"], result
    if indexed:
        assert document.attachment_id == source.id
        assert mark_document_index_started(
            test_db, document.id, document.index_generation
        ).should_execute
        assert publish_candidate(
            test_db,
            document_id=document.id,
            generation=document.index_generation,
            chunks=None,
            lease=lease,
        )
    test_db.expire_all()
    stored = test_db.get(KnowledgeDocument, document.id)
    body = test_db.get(SubtaskContext, stored.attachment_id)
    read = DocumentReadService().read_documents(
        test_db,
        document_ids=[stored.id],
        knowledge_base_ids=[kb.id],
        searchable_only=indexed,
    )[0]
    assert read["content"] == scraped_content
    assert stored.user_id == body.user_id == test_user.id
    assert body.subtask_id == 0
    assert body.context_type == ContextType.ATTACHMENT.value
    access = get_document_access_or_raise(
        test_db, user_id=test_admin_user.id, document_id=stored.id
    )
    assert access.content_readable
    assert access.downloadable
    assert access.attachment.id == body.id
    assert context_service.get_attachment_binary_data(test_db, body) == (
        scraped_content.encode("utf-8")
    )
    assert body.id != source.id
    if existing == "owned":
        assert test_db.get(SubtaskContext, source.id) is None
    else:
        assert source.extracted_text == "original"
        assert bodies[1]["original"] == b"original"
    if foreign:
        assert source.user_id == test_admin_user.id
        assert "web_index_version" not in source.type_data
    elif existing == "wrong_type":
        assert source.context_type == ContextType.KNOWLEDGE_BASE.value


@pytest.mark.parametrize("phase", ["before_commit", "after_commit", "refresh"])
def test_database_failure_cleans_only_uncommitted_document_body(
    test_db,
    test_user,
    kb,
    bodies,
    monkeypatch,
    phase,
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    commit = test_db.commit
    refresh = test_db.refresh

    def failing_commit():
        creating = any(
            isinstance(row, KnowledgeDocument) for row in test_db.identity_map.values()
        )
        if creating and phase == "before_commit":
            raise RuntimeError("database failure")
        commit()
        if creating and phase == "after_commit":
            raise RuntimeError("database failure")

    def failing_refresh(row, *args, **kwargs):
        if isinstance(row, KnowledgeDocument) and phase == "refresh":
            raise RuntimeError("database failure")
        return refresh(row, *args, **kwargs)

    monkeypatch.setattr(test_db, "commit", failing_commit)
    monkeypatch.setattr(test_db, "refresh", failing_refresh)
    with pytest.raises(RuntimeError, match="database failure"):
        create(test_db, test_user, kb, source.id)

    document = test_db.query(KnowledgeDocument).first()
    if phase == "before_commit":
        assert document is None
        assert test_db.query(SubtaskContext).count() == 1
        assert bodies[1] == {"original": b"original"}
    else:
        assert document is not None
        assert document.attachment_id != source.id
        copy = context_service.get_context(test_db, document.attachment_id)
        assert context_service.get_attachment_binary_data(test_db, copy) == b"original"
        assert test_db.query(SubtaskContext).count() == 2


@pytest.mark.parametrize("source_type", ["text", "file"])
def test_failed_dedicated_content_create_cleans_its_upload(
    test_db,
    test_user,
    kb,
    bodies,
    source_type,
) -> None:
    arguments = (
        {"content": "original"}
        if source_type == "text"
        else {
            "file_base64": "b3JpZ2luYWw=",
            "file_extension": "md",
        }
    )
    with pytest.raises(ValueError):
        knowledge_orchestrator.create_document_with_content(
            test_db,
            test_user,
            kb.id,
            "fresh",
            source_type,
            folder_id=99999,
            trigger_indexing=False,
            **arguments,
        )
    assert test_db.query(SubtaskContext).count() == 0
    assert not bodies[1]


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_missing_source_binary_does_not_create_a_document_or_copy(
    test_db,
    test_user,
    kb,
    bodies,
    entry,
) -> None:
    from app.services.attachment.storage_backend import StorageError

    source = attachment(test_db, test_user.id, bodies)
    bodies[1].clear()
    with pytest.raises(StorageError):
        create(test_db, test_user, kb, source.id, entry)

    assert test_db.query(KnowledgeDocument).count() == 0
    assert test_db.query(SubtaskContext).count() == 1
    bodies[0].save.assert_not_called()


@pytest.mark.parametrize("entry", ["rest", "content"])
def test_deleting_original_source_preserves_imported_document_bodies(
    test_db,
    test_user,
    kb,
    bodies,
    entry,
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    first = create(test_db, test_user, kb, source.id, entry)
    second = create(test_db, test_user, kb, source.id, entry)
    assert context_service.delete_context(test_db, source.id, test_user.id)

    for document in (first, second):
        body = context_service.get_context(test_db, document.attachment_id)
        assert context_service.get_attachment_binary_data(test_db, body) == b"original"


@pytest.mark.parametrize("entry", ["rest", "content"])
@pytest.mark.parametrize("operation", ["edit", "delete"])
def test_document_mutation_preserves_source_and_sibling_content(
    test_db,
    test_user,
    kb,
    bodies,
    entry,
    operation,
) -> None:
    source = attachment(test_db, test_user.id, bodies)
    first = create(test_db, test_user, kb, source.id, entry)
    second = create(test_db, test_user, kb, source.id, entry)
    sibling_body = context_service.get_context(test_db, second.attachment_id)

    if operation == "edit":
        KnowledgeService.update_document_content(
            test_db, first.id, "changed", test_user.id
        )
    else:
        assert KnowledgeService.delete_document(test_db, first.id, test_user.id).success

    assert context_service.get_attachment_binary_data(test_db, source) == b"original"
    assert (
        context_service.get_attachment_binary_data(test_db, sibling_body) == b"original"
    )


@pytest.mark.parametrize(
    "outcome",
    [
        "short_body",
        "draft",
        "unindexed",
        "shared_unindexed",
        "failed_unindexed",
        "blank",
        "dispatch_failure",
    ],
)
def test_web_refresh_keeps_live_body_until_publish(
    test_db, test_user, test_admin_user, kb, bodies, monkeypatch, outcome
):
    from app.models.knowledge import DocumentIndexStatus
    from app.services.knowledge.web_publication import (
        attach_version_record,
        publish_candidate,
    )
    from app.services.knowledge.web_refresh import refresh_web_document
    from app.services.rag.runtime_resolver import RagRuntimeResolver
    from app.services.web_scraper.models import InternalScrapeResult
    from app.services.web_scraper.scraper_service import WebScraperService
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    kb.json = {
        "spec": {
            "retrievalConfig": {
                "retriever_name": "web-store",
                "embedding_config": {"model_name": "web-embed"},
            }
        }
    }
    test_db.add_all(
        [
            retriever_kind(test_user.id, "web-store"),
            embedding_model_kind(test_user.id, "web-embed"),
        ]
    )
    source = attachment(test_db, test_user.id, bodies)
    document = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=source.id,
        name="web.md",
        file_extension="md",
        file_size=8,
        user_id=test_user.id,
        is_active=True,
        status="enabled",
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="web",
        source_config={"url": "https://example.org/short"},
    )
    test_db.add(document)
    if outcome in {"unindexed", "failed_unindexed", "shared_unindexed"}:
        kb.json = {"spec": {}}
        document.index_status = DocumentIndexStatus.NOT_INDEXED
        if outcome == "failed_unindexed":
            document.index_status = DocumentIndexStatus.FAILED
            document.is_active = False
    test_db.commit()
    if outcome == "shared_unindexed":
        sibling = KnowledgeDocument(
            kind_id=kb.id,
            attachment_id=source.id,
            name="shared.md",
            file_extension="md",
            file_size=8,
            user_id=test_user.id,
        )
        test_db.add(sibling)
        test_db.commit()
    if outcome == "short_body":
        derived = SubtaskContext(
            user_id=test_admin_user.id,
            subtask_id=0,
            name="fixture.md",
            context_type=ContextType.ATTACHMENT.value,
            type_data={"storage_key": "fixture", "storage_backend": "mysql"},
        )
        test_db.add(derived)
        test_db.flush()
        bodies[1]["fixture"] = b"derived fixture"
        document.index_generation = 1
        document.source_config = {
            **document.source_config,
            "published_generation": 1,
            "converted_attachment_id": derived.id,
        }
        ref = f"{document.id}@1"
        delete_spec = RagRuntimeResolver().build_delete_runtime_spec(
            db=test_db,
            knowledge_base_id=kb.id,
            document_ref=ref,
            index_owner_user_id=kb.user_id,
        )
        attach_version_record(
            source,
            {
                "document_id": document.id,
                "doc_ref": ref,
                "delete_spec": delete_spec.model_dump(mode="json"),
                "retired_attachments": [derived.id],
            },
        )
        test_db.commit()
    lease = MagicMock()
    lease.owned.return_value = True

    @contextmanager
    def owned(*args, **kwargs):
        yield lease

    monkeypatch.setattr(
        "app.services.knowledge.web_refresh.distributed_lock.owned_watchdog_context",
        owned,
    )
    body = "营业时间：周一至周五9点至18点，周末及节假日均休息。"
    service = WebScraperService()
    monkeypatch.setattr(service, "_check_crawl4ai", lambda: True)
    monkeypatch.setattr(service._guard, "validate_initial_url", lambda url: None)
    external = InternalScrapeResult(
        url=document.source_config["url"],
        markdown="  " if outcome == "blank" else body,
        status_code=200,
    )
    service._crawl4ai_strategy.scrape = AsyncMock(return_value=external)
    service._playwright_strategy.scrape = AsyncMock(return_value=external)

    async def fetch(url):
        return await service.scrape_url(url, allow_short_content=True)

    monkeypatch.setattr(
        "app.services.knowledge.web_refresh.scrape_with_domain_lease", fetch
    )
    dispatch = MagicMock(
        side_effect=(
            RuntimeError("broker unavailable")
            if outcome == "dispatch_failure"
            else None
        )
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.apply_async", dispatch
    )
    if outcome in {"blank", "dispatch_failure"}:
        with pytest.raises(ValueError if outcome == "blank" else RuntimeError):
            asyncio.run(refresh_web_document(test_db, test_user, document.id))
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.SUCCESS
        assert "_web_refresh" not in document.source_config
    else:
        result = asyncio.run(
            refresh_web_document(
                test_db, test_user, document.id, trigger_indexing=outcome != "draft"
            )
        )
        assert result["success"]
        if outcome in {"unindexed", "failed_unindexed", "shared_unindexed"}:
            assert document.attachment_id != source.id
            assert document.index_status == (
                DocumentIndexStatus.FAILED
                if outcome == "failed_unindexed"
                else DocumentIndexStatus.NOT_INDEXED
            )
            assert (
                context_service.get_attachment_binary_data(
                    test_db, test_db.get(SubtaskContext, document.attachment_id)
                ).decode()
                == body
            )
            dispatch.assert_not_called()
            if outcome == "shared_unindexed":
                assert sibling.attachment_id == source.id
                assert test_db.get(SubtaskContext, source.id) is not None
                assert bodies[1]["original"] == b"original"
            return
        assert document.attachment_id == source.id
        assert (
            context_service.get_attachment_binary_data(test_db, source) == b"original"
        )
        from app.services.knowledge.index_state_machine import (
            mark_document_index_started,
            prepare_document_index_enqueue,
        )

        if outcome == "draft":
            from app.services.knowledge.web_publication import (
                prepare_web_reindex_candidate,
            )

            decision = prepare_document_index_enqueue(
                test_db, document.id, allow_if_success=True
            )
            prepare_web_reindex_candidate(
                test_db,
                document,
                kb,
                generation=decision.generation,
                previous_status=decision.previous_status,
                requested_by=test_user.id,
            )
        candidate = document.source_config["_web_refresh"]
        assert mark_document_index_started(
            test_db, document.id, document.index_generation
        ).should_execute
        assert publish_candidate(
            test_db,
            document_id=document.id,
            generation=document.index_generation,
            chunks={"items": [{"content": body}]},
            lease=lease,
        )
        assert document.attachment_id == candidate["attachment_id"]
        assert (
            context_service.get_attachment_binary_data(
                test_db, test_db.get(SubtaskContext, document.attachment_id)
            ).decode()
            == body
        )
        assert (
            document.source_config["published_generation"] == document.index_generation
        )
        # A retired attachment survives a failed cleanup and is removed on retry.
        from app.services.knowledge.web_version_cleanup import cleanup_retired_versions

        if outcome == "draft":
            # No cleanup record may be synthesized from the current retriever.
            assert "web_index_version" not in source.type_data
            return

        assert "converted_attachment_id" not in document.source_config
        source.type_data = {
            **source.type_data,
            "web_index_version": {
                **source.type_data["web_index_version"],
                "not_before": (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat(),
            },
        }
        test_db.commit()
        gateway = MagicMock()
        gateway.delete_document_index = AsyncMock(
            side_effect=RuntimeError("vector store unavailable")
        )
        monkeypatch.setattr(
            "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
        )
        redis = MagicMock()
        redis.get.return_value = 0
        monkeypatch.setattr(
            "app.services.knowledge.web_refresh.distributed_lock._redis_client", redis
        )
        assert cleanup_retired_versions(test_db)["failed"] == 1
        assert test_db.get(SubtaskContext, source.id) is not None
        gateway.delete_document_index = AsyncMock(return_value={"status": "success"})
        assert cleanup_retired_versions(test_db)["cleaned"] == 1
        assert test_db.get(SubtaskContext, derived.id) is not None
        assert bodies[1]["fixture"] == b"derived fixture"
        assert test_db.get(SubtaskContext, document.attachment_id) is not None
    test_db.refresh(document)
    if outcome in {"blank", "dispatch_failure"}:
        assert document.attachment_id == source.id
        assert (
            context_service.get_attachment_binary_data(test_db, source) == b"original"
        )


@pytest.mark.parametrize("stop", ["complete", "scan_budget", "time_budget"])
def test_web_cleanup_processes_multiple_batches_and_resumes_budgeted_cursor(
    test_db, test_user, kb, bodies, monkeypatch, stop
):
    from app.core.config import settings
    from app.services.knowledge.web_publication import attach_version_record
    from app.services.knowledge.web_version_cleanup import (
        CURSOR_KEY,
        cleanup_retired_versions,
    )
    from app.services.rag.runtime_resolver import RagRuntimeResolver
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    kb.json = {
        "spec": {
            "retrievalConfig": {
                "retriever_name": "web-store",
                "embedding_config": {"model_name": "web-embed"},
            }
        }
    }
    test_db.add_all(
        [
            retriever_kind(test_user.id, "web-store"),
            embedding_model_kind(test_user.id, "web-embed"),
        ]
    )
    document = KnowledgeDocument(
        kind_id=kb.id,
        user_id=test_user.id,
        name="web.md",
        source_type="web",
        file_extension="md",
        file_size=8,
        index_status="success",
        index_generation=1000,
        is_active=True,
        status="enabled",
        source_config={"published_generation": 1000},
    )
    test_db.add(document)
    test_db.commit()
    spec = (
        RagRuntimeResolver()
        .build_delete_runtime_spec(
            db=test_db,
            knowledge_base_id=kb.id,
            document_ref=str(document.id),
            index_owner_user_id=kb.user_id,
        )
        .model_dump(mode="json")
    )
    records = []
    for version in [*range(1, 221), 1000, 1001, 1002, 1003]:
        key = f"cleanup-body-{version}"
        row = SubtaskContext(
            user_id=test_user.id,
            subtask_id=0,
            context_type="attachment",
            name="web.md",
            status="ready",
            extracted_text="body",
            text_length=4,
            type_data={
                "storage_key": key,
                "storage_backend": "mysql",
                "file_extension": "md",
            },
        )
        ref = f"{document.id}@{version}"
        attach_version_record(
            row,
            {
                "document_id": document.id,
                "doc_ref": ref,
                "delete_spec": {**spec, "document_ref": ref},
            },
        )
        if version != 1001:
            row.type_data["web_index_version"]["not_before"] = (
                datetime.now(timezone.utc) - timedelta(days=1)
            ).isoformat()
        if version == 1002:
            row.type_data["web_index_version"].pop("storage_captured_at_staging")
        records.append(row)
        bodies[1][key] = b"body"
    test_db.add_all(records)
    test_db.flush()
    current, future, legacy, shared = records[-4:]
    document.attachment_id = current.id
    test_db.add(
        KnowledgeDocument(
            kind_id=kb.id,
            user_id=test_user.id,
            name="legacy-sharing.md",
            file_extension="md",
            source_config={"converted_attachment_id": shared.id},
        )
    )
    retired_ids = [row.id for row in records[:220]]
    retained_ids = [row.id for row in (current, future, legacy, shared)]
    test_db.commit()

    lease = MagicMock()
    lease.owned.return_value = True
    monkeypatch.setattr(
        "app.services.knowledge.web_version_cleanup.distributed_lock.owned_watchdog_context",
        lambda *args, **kwargs: nullcontext(lease),
    )
    values = {}
    redis = MagicMock()
    redis.get.side_effect = lambda key: values.get(key, 0)
    redis.set.side_effect = lambda key, value, **kwargs: values.__setitem__(key, value)
    monkeypatch.setattr(
        "app.services.knowledge.web_version_cleanup.distributed_lock._redis_client",
        redis,
    )
    gateway = MagicMock()
    gateway.delete_document_index = AsyncMock(return_value={"status": "success"})
    monkeypatch.setattr(
        "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
    )
    monkeypatch.setattr(
        settings,
        "EXTERNAL_DOC_SYNC_RUN_MAX_DOCUMENTS",
        201 if stop == "scan_budget" else 10000,
    )
    monkeypatch.setattr(settings, "KNOWLEDGE_ATTACHMENT_ORPHAN_SCAN_BATCH_SIZE", 200)
    if stop == "time_budget":
        monkeypatch.setattr(settings, "EXTERNAL_DOC_SYNC_TIME_BUDGET_SECONDS", 10)
        monkeypatch.setattr(
            "app.services.knowledge.web_version_cleanup.monotonic",
            lambda: 10 if gateway.delete_document_index.await_count >= 201 else 0,
        )
    first = cleanup_retired_versions(test_db)
    if stop != "complete":
        assert first["cleaned"] == first["scanned"] == 201
        assert values[CURSOR_KEY] == retired_ids[200]
        monkeypatch.setattr(
            "app.services.knowledge.web_version_cleanup.monotonic", lambda: 0
        )
        second = cleanup_retired_versions(test_db)
        assert second["cleaned"] == 19
        assert second["protected"] == 3
        assert second["deferred"] == 1
    else:
        assert first["scanned"] == 224
        assert first["cleaned"] == 220
        assert first["protected"] == 3
        assert first["deferred"] == 1
    assert values[CURSOR_KEY] == 0
    assert (
        not test_db.query(SubtaskContext.id)
        .filter(SubtaskContext.id.in_(retired_ids))
        .all()
    )
    for attachment_id in retained_ids:
        assert test_db.get(SubtaskContext, attachment_id) is not None
    assert gateway.delete_document_index.await_count == len(retired_ids) + 1


@pytest.fixture
def staged_web(test_db, test_user, kb, bodies, monkeypatch):
    from app.models.knowledge import DocumentIndexStatus
    from app.services.knowledge import web_refresh
    from app.services.web_scraper import ScrapedContent
    from tests.utils.retrieval_resources import embedding_model_kind, retriever_kind

    kb.json = {
        "spec": {
            "retrievalConfig": {
                "retriever_name": "web-store",
                "embedding_config": {"model_name": "web-embed"},
            }
        }
    }
    test_db.add_all(
        [
            retriever_kind(test_user.id, "web-store"),
            embedding_model_kind(test_user.id, "web-embed"),
        ]
    )
    source = attachment(test_db, test_user.id, bodies)
    document = KnowledgeDocument(
        kind_id=kb.id,
        attachment_id=source.id,
        name="web.md",
        file_extension="md",
        file_size=8,
        user_id=test_user.id,
        is_active=True,
        status="enabled",
        index_status=DocumentIndexStatus.SUCCESS,
        source_type="web",
        source_config={"url": "https://example.org/hours"},
    )
    test_db.add(document)
    test_db.commit()
    lease = MagicMock()
    lease.owned.return_value = True
    monkeypatch.setattr(
        web_refresh.distributed_lock,
        "owned_watchdog_context",
        lambda *a, **kw: nullcontext(lease),
    )
    monkeypatch.setattr(
        web_refresh,
        "scrape_with_domain_lease",
        AsyncMock(
            return_value=ScrapedContent(
                url=document.source_config["url"],
                success=True,
                content="Updated opening hours",
            )
        ),
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.apply_async", MagicMock()
    )
    assert asyncio.run(
        web_refresh.refresh_web_document(
            test_db, test_user, document.id, trigger_indexing=False
        )
    )["success"]
    return document, lease


@pytest.mark.parametrize(
    "record_type", ["captured", "uncaptured", "missing", "missing_attachment"]
)
def test_delete_versioned_web_defers_to_recorded_storage(
    test_db, test_user, kb, staged_web, monkeypatch, record_type
):
    from app.services.knowledge.index_state_machine import mark_document_index_started
    from app.services.knowledge.web_publication import publish_candidate
    from app.services.knowledge.web_version_cleanup import cleanup_retired_versions
    from app.services.rag.remote_gateway import RemoteRagGatewayError

    document, lease = staged_web
    document_id = document.id
    assert knowledge_orchestrator.reindex_document(test_db, test_user, document_id)[
        "success"
    ]
    generation = document.index_generation
    assert mark_document_index_started(test_db, document_id, generation).should_execute
    assert publish_candidate(
        test_db,
        document_id=document_id,
        generation=generation,
        chunks=None,
        lease=lease,
    )
    attachment_id = document.attachment_id
    body = test_db.get(SubtaskContext, attachment_id)
    record = dict(body.type_data["web_index_version"])
    if record_type == "uncaptured":
        record.pop("storage_captured_at_staging")
    body.type_data = {**body.type_data, "web_index_version": record}
    if record_type == "missing":
        body.type_data = {
            key: value
            for key, value in body.type_data.items()
            if key != "web_index_version"
        }
    elif record_type == "missing_attachment":
        test_db.delete(body)
    kb.json = {"spec": {"retrievalConfig": {"retriever_name": "different-store"}}}
    test_db.commit()

    gateway = MagicMock()
    gateway.delete_document_index = AsyncMock(return_value={"status": "success"})
    monkeypatch.setattr(
        "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
    )
    redis = MagicMock()
    redis.get.return_value = 0
    monkeypatch.setattr(
        "app.services.knowledge.web_version_cleanup.distributed_lock._redis_client",
        redis,
    )
    if record_type == "missing_attachment":
        with pytest.raises(RemoteRagGatewayError) as exc:
            KnowledgeService.delete_document(
                test_db,
                document_id,
                test_user.id,
                continue_on_external_engine_failure=True,
            )
        assert exc.value.status_code == 409
        assert document.source_config["published_generation"] == generation
        gateway.delete_document_index.assert_not_awaited()
        return
    result = KnowledgeService.delete_document(test_db, document_id, test_user.id)
    assert result.success and result.cleanup.content_deleted
    assert result.cleanup.index_cleanup == "unconfirmed"
    assert test_db.get(KnowledgeDocument, document_id) is None
    gateway.delete_document_index.assert_not_awaited()
    assert test_db.get(SubtaskContext, attachment_id) is not None

    if record_type == "captured":
        body.type_data = {
            **body.type_data,
            "web_index_version": {
                **body.type_data["web_index_version"],
                "not_before": (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat(),
            },
        }
        test_db.commit()
    else:
        assert body.type_data["web_index_version"] == {
            "document_id": document_id,
            "knowledge_base_id": kb.id,
            "doc_ref": f"{document_id}@{generation}",
        }
    cleanup_retired_versions(test_db)
    if record_type == "captured":
        gateway.delete_document_index.assert_awaited_once()
        spec = gateway.delete_document_index.await_args.args[0]
        assert spec.document_ref == f"{document_id}@{generation}"
        assert spec.authorized_resources.retriever.name == "web-store"
        assert test_db.get(SubtaskContext, attachment_id) is None
    else:
        gateway.delete_document_index.assert_not_awaited()
        assert test_db.get(SubtaskContext, attachment_id) is not None


@pytest.mark.parametrize("changed", [False, True])
def test_web_refresh_recovers_missing_published_attachment(
    test_db, test_user, staged_web, monkeypatch, changed
):
    from app.services.knowledge import web_refresh
    from app.services.knowledge.index_state_machine import mark_document_index_started
    from app.services.knowledge.web_publication import publish_candidate
    from app.services.knowledge.web_version_cleanup import cleanup_retired_versions
    from app.services.web_scraper import ScrapedContent

    document, lease = staged_web
    assert knowledge_orchestrator.reindex_document(test_db, test_user, document.id)[
        "success"
    ]

    def publish():
        generation = document.index_generation
        assert mark_document_index_started(
            test_db, document.id, generation
        ).should_execute
        assert publish_candidate(
            test_db,
            document_id=document.id,
            generation=generation,
            chunks=None,
            lease=lease,
        )

    publish()
    previous = document.source_config["published_generation"]
    test_db.delete(test_db.get(SubtaskContext, document.attachment_id))
    test_db.commit()
    body = "New opening hours" if changed else "Updated opening hours"
    monkeypatch.setattr(
        web_refresh,
        "scrape_with_domain_lease",
        AsyncMock(
            return_value=ScrapedContent(
                url=document.source_config["url"], success=True, content=body
            )
        ),
    )
    assert asyncio.run(
        web_refresh.refresh_web_document(test_db, test_user, document.id)
    )["success"]
    publish()
    assert document.source_config["published_generation"] > previous
    attachment = test_db.get(SubtaskContext, document.attachment_id)
    assert (
        context_service.get_attachment_binary_data(test_db, attachment) == body.encode()
    )

    reference = f"{document.id}@{previous}"
    history = (
        test_db.query(SubtaskContext)
        .filter(
            SubtaskContext.type_data["web_index_version"]["doc_ref"].as_string()
            == reference
        )
        .one()
    )
    assert history.type_data["web_index_version"] == {
        "document_id": document.id,
        "knowledge_base_id": document.kind_id,
        "doc_ref": reference,
    }
    assert not history.storage_key
    redis = MagicMock()
    redis.get.return_value = 0
    monkeypatch.setattr(
        "app.services.knowledge.web_version_cleanup.distributed_lock._redis_client",
        redis,
    )
    gateway = MagicMock()
    gateway.delete_document_index = AsyncMock()
    monkeypatch.setattr(
        "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
    )
    cleanup_retired_versions(test_db)
    gateway.delete_document_index.assert_not_awaited()
    assert test_db.get(SubtaskContext, history.id) is not None


@pytest.mark.parametrize(
    ("disabled", "target_has_retrieval"), [(False, True), (True, True), (False, False)]
)
def test_transfer_versioned_web_reindexes_as_first_publication_in_target(
    test_db, test_user, kb, staged_web, monkeypatch, disabled, target_has_retrieval
):
    from app.services.knowledge.index_state_machine import mark_document_index_started
    from app.services.knowledge.knowledge_transfer import KnowledgeTransferService
    from app.services.knowledge.web_publication import publish_candidate

    document, lease = staged_web

    def publish():
        generation = document.index_generation
        assert mark_document_index_started(
            test_db, document.id, generation
        ).should_execute
        assert publish_candidate(
            test_db,
            document_id=document.id,
            generation=generation,
            chunks=None,
            lease=lease,
        )

    assert knowledge_orchestrator.reindex_document(test_db, test_user, document.id)[
        "success"
    ]
    publish()
    source_id = document.attachment_id
    source_reference = test_db.get(SubtaskContext, source_id).type_data[
        "web_index_version"
    ]["doc_ref"]
    if disabled:
        document.status = "disabled"
        document.source_config = {
            **document.source_config,
            "web_user_status": "disabled",
        }
    target = Kind(
        user_id=test_user.id,
        kind="KnowledgeBase",
        name="transfer-web-target",
        namespace="default",
        json=kb.json if target_has_retrieval else {"spec": {}},
        is_active=True,
    )
    test_db.add(target)
    test_db.commit()
    gateway = MagicMock()
    monkeypatch.setattr(
        "app.services.knowledge.knowledge_transfer._get_rag_gateway", lambda: gateway
    )
    assert KnowledgeTransferService.transfer_documents_to_kb(
        test_db,
        kb.id,
        target.id,
        [document.id],
        [],
        test_user.id,
    ).success
    assert document.kind_id == target.id
    assert "published_generation" not in document.source_config
    assert document.attachment_id == source_id
    gateway.delete_document_index.assert_not_called()
    if not target_has_retrieval:
        from app.services.knowledge.web_version_cleanup import cleanup_retired_versions

        source = test_db.get(SubtaskContext, source_id)
        source.type_data = {
            **source.type_data,
            "web_index_version": {
                **source.type_data["web_index_version"],
                "not_before": (
                    datetime.now(timezone.utc) - timedelta(days=1)
                ).isoformat(),
            },
        }
        test_db.commit()
        redis = MagicMock()
        redis.get.return_value = 0
        monkeypatch.setattr(
            "app.services.knowledge.web_version_cleanup.distributed_lock._redis_client",
            redis,
        )
        gateway.delete_document_index = AsyncMock(return_value={"status": "success"})
        monkeypatch.setattr(
            "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
        )
        cleanup_retired_versions(test_db)
        cleanup_retired_versions(test_db)
        gateway.delete_document_index.assert_awaited_once()
        spec = gateway.delete_document_index.await_args.args[0]
        assert spec.knowledge_base_id == kb.id and spec.document_ref == source_reference
        assert document.attachment_id == source_id
        assert (
            context_service.get_attachment_binary_data(test_db, source)
            == b"Updated opening hours"
        )
        return
    publish()
    assert document.is_active
    assert document.status == ("disabled" if disabled else "enabled")
    assert document.attachment_id != source_id
    source_record = test_db.get(SubtaskContext, source_id).type_data[
        "web_index_version"
    ]
    assert source_record["doc_ref"] == source_reference
    assert source_record["delete_spec"]["knowledge_base_id"] == kb.id
    target_record = test_db.get(SubtaskContext, document.attachment_id).type_data[
        "web_index_version"
    ]
    assert target_record["delete_spec"]["knowledge_base_id"] == target.id


@pytest.mark.parametrize("broker_unavailable", [True, False])
def test_manual_web_refresh_preserves_error_contract_on_dispatch_failure(
    test_db, test_user, staged_web, monkeypatch, broker_unavailable
):
    from kombu.exceptions import OperationalError

    document, _ = staged_web
    draft_id = document.source_config["_web_refresh"]["attachment_id"]
    error = (
        OperationalError("broker unavailable")
        if broker_unavailable
        else RuntimeError("dispatch failed")
    )
    monkeypatch.setattr(
        "app.tasks.knowledge_tasks.index_document_task.apply_async",
        MagicMock(side_effect=error),
    )
    result = asyncio.run(
        knowledge_orchestrator.refresh_web_document(test_db, test_user, document.id)
    )
    assert not result["success"]
    assert result["error_code"] == "REFRESH_FAILED"
    assert document.source_config["_web_refresh"]["attachment_id"] == draft_id


@pytest.mark.parametrize("failure", ["reload", "cancelled"])
def test_web_refresh_failed_before_dispatch_restores_draft(
    test_db, test_user, staged_web, monkeypatch, failure
):
    from app.services.knowledge import web_refresh
    from app.tasks.knowledge_tasks import index_document_task

    document, _ = staged_web
    original_draft = dict(document.source_config["_web_refresh"])
    attachment_id = document.attachment_id
    if failure == "cancelled":
        monkeypatch.setattr(
            web_refresh,
            "scrape_with_domain_lease",
            AsyncMock(side_effect=asyncio.CancelledError),
        )
        expected = asyncio.CancelledError
    else:
        refresh = test_db.refresh

        def fail_candidate_refresh(row, *args, **kwargs):
            if isinstance(row, KnowledgeDocument):
                candidate = row.source_config.get("_web_refresh", {})
                if candidate.get("attachment_id") and not candidate.get("draft"):
                    raise RuntimeError("reload failed")
            return refresh(row, *args, **kwargs)

        monkeypatch.setattr(test_db, "refresh", fail_candidate_refresh)
        expected = RuntimeError

    with pytest.raises(expected):
        asyncio.run(web_refresh.refresh_web_document(test_db, test_user, document.id))
    index_document_task.apply_async.assert_not_called()
    assert document.attachment_id == attachment_id
    assert document.index_status == "success"
    assert document.source_config["_web_refresh"] == {
        **original_draft,
        "generation": document.index_generation,
    }


@pytest.mark.parametrize("mode", ["publish", "draft", "unindexed"])
def test_web_refresh_rolls_back_when_upload_loses_lease(
    test_db, test_user, staged_web, monkeypatch, mode
):
    from app.services.knowledge import web_refresh
    from app.tasks.knowledge_tasks import index_document_task

    document, lease = staged_web
    if mode == "unindexed":
        document.index_status = "not_indexed"
        document.source_config = {"url": document.source_config["url"]}
        test_db.commit()
    old_attachment = document.attachment_id
    old_generation = document.index_generation
    upload = context_service.upload_attachment
    uploaded = []

    def upload_then_lose_lease(*args, **kwargs):
        attachment, info = upload(*args, **kwargs)
        uploaded.append(attachment.id)
        lease.owned.return_value = False
        return attachment, info

    monkeypatch.setattr(context_service, "upload_attachment", upload_then_lose_lease)
    with pytest.raises(web_refresh.WebRefreshInvalid) as raised:
        asyncio.run(
            web_refresh.refresh_web_document(
                test_db, test_user, document.id, trigger_indexing=mode == "publish"
            )
        )
    assert raised.value.code == "REFRESH_SUPERSEDED"
    index_document_task.apply_async.assert_not_called()
    assert document.attachment_id == old_attachment
    assert len(uploaded) == 1 and test_db.get(SubtaskContext, uploaded[0]) is None
    if mode == "unindexed":
        assert document.index_generation == old_generation
    else:
        assert "attachment_id" not in document.source_config["_web_refresh"]


@pytest.mark.parametrize("superseded", [False, True])
def test_web_reindex_stages_only_current_queued_generation(
    test_db, test_user, kb, staged_web, monkeypatch, superseded
):
    from app.services.knowledge.index_state_machine import (
        prepare_document_index_enqueue,
    )
    from app.services.knowledge.web_publication import prepare_web_reindex_candidate

    document, _ = staged_web
    document_id = document.id
    decision = prepare_document_index_enqueue(
        test_db, document_id, allow_if_success=True
    )
    assert decision.should_enqueue
    config = {**document.source_config, "web_user_status": "disabled"}
    generation = decision.generation + int(superseded)
    with Session(
        bind=test_db.get_bind(), join_transaction_mode="create_savepoint"
    ) as concurrent:
        concurrent.execute(
            update(KnowledgeDocument)
            .where(KnowledgeDocument.id == document_id)
            .values(
                source_config=config, status="disabled", index_generation=generation
            )
        )
        concurrent.commit()

    arguments = {
        "generation": decision.generation,
        "previous_status": decision.previous_status,
        "requested_by": test_user.id,
    }
    if superseded:
        upload = MagicMock()
        monkeypatch.setattr(context_service, "upload_attachment", upload)
        with pytest.raises(ValueError, match="superseded"):
            prepare_web_reindex_candidate(test_db, document, kb, **arguments)
        upload.assert_not_called()
        assert document.source_config == config
    else:
        prepare_web_reindex_candidate(test_db, document, kb, **arguments)
        assert (
            document.source_config["_web_refresh"]["user_status_override"] == "disabled"
        )
    assert document.status == "disabled"
    assert document.index_generation == generation


def test_unindexed_web_refresh_clears_stale_conversion_reference(
    test_db, test_user, staged_web
):
    from app.models.knowledge import DocumentIndexStatus
    from app.services.knowledge.document_text_sources import load_document_text_sources
    from app.services.knowledge.web_refresh import refresh_web_document

    document, _ = staged_web
    converted = SubtaskContext(
        user_id=test_user.id,
        subtask_id=0,
        name="converted.md",
        context_type=ContextType.ATTACHMENT.value,
        extracted_text="Old converted content",
    )
    test_db.add(converted)
    test_db.flush()
    document.source_config = {
        "url": document.source_config["url"],
        "converted_attachment_id": converted.id,
    }
    document.index_status = DocumentIndexStatus.NOT_INDEXED
    test_db.commit()
    assert asyncio.run(
        refresh_web_document(test_db, test_user, document.id, trigger_indexing=False)
    )["success"]
    text = load_document_text_sources(test_db, [document])[document.id].select_text()
    assert text == "Updated opening hours"
    assert test_db.get(SubtaskContext, converted.id) is not None


@pytest.mark.parametrize(
    "failure",
    [
        "fetch",
        "dispatch",
        "changed_splitter_dispatch",
        "index",
        "stale_takeover",
        "stale_scan",
    ],
)
def test_staged_web_body_remains_retryable_after_failed_work(
    test_db, test_user, staged_web, monkeypatch, failure
):
    from app.services.knowledge import web_refresh
    from app.services.knowledge.index_state_machine import mark_document_index_failed
    from app.services.knowledge.web_publication import publish_candidate

    document, lease = staged_web
    draft_id = document.source_config["_web_refresh"]["attachment_id"]
    if failure in {"fetch", "stale_takeover", "stale_scan"}:
        if failure == "stale_takeover":
            knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
            document.updated_at = datetime.now(timezone.utc) - timedelta(days=1)
            test_db.commit()

        async def failed_fetch(_):
            if failure == "stale_scan":
                document.updated_at = datetime.now(timezone.utc) - timedelta(days=1)
                test_db.commit()
                assert mark_document_index_failed(
                    test_db, document.id, document.index_generation, require_stale=True
                )
            raise ValueError("fetch failed")

        monkeypatch.setattr(
            web_refresh,
            "scrape_with_domain_lease",
            failed_fetch,
        )
        with pytest.raises(ValueError):
            asyncio.run(
                web_refresh.refresh_web_document(test_db, test_user, document.id)
            )
    else:
        if failure in {"dispatch", "changed_splitter_dispatch"}:
            if failure == "changed_splitter_dispatch":
                previous_splitter = document.splitter_config
                document.splitter_config = {"chunk_size": 128}
                test_db.commit()
            monkeypatch.setattr(
                "app.tasks.knowledge_tasks.index_document_task.apply_async",
                MagicMock(side_effect=RuntimeError("broker failed")),
            )
            with pytest.raises(RuntimeError):
                knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
            monkeypatch.setattr(
                "app.tasks.knowledge_tasks.index_document_task.apply_async", MagicMock()
            )
            if failure == "changed_splitter_dispatch":
                document.splitter_config = previous_splitter
                test_db.commit()
        else:
            knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
            assert mark_document_index_failed(
                test_db, document.id, document.index_generation
            )
    assert document.source_config["_web_refresh"]["draft"]
    assert document.source_config["_web_refresh"]["attachment_id"] == draft_id
    assert knowledge_orchestrator.reindex_document(test_db, test_user, document.id)[
        "success"
    ]
    from app.services.knowledge.index_state_machine import mark_document_index_started

    assert mark_document_index_started(
        test_db, document.id, document.index_generation
    ).should_execute
    assert publish_candidate(
        test_db,
        document_id=document.id,
        generation=document.index_generation,
        chunks=None,
        lease=lease,
    )
    assert (
        context_service.get_attachment_binary_data(
            test_db, test_db.get(SubtaskContext, document.attachment_id)
        )
        == b"Updated opening hours"
    )


@pytest.mark.parametrize("automatic", [False, True])
def test_refresh_returning_to_live_content_handles_previous_draft(
    test_db, test_user, kb, staged_web, monkeypatch, automatic
):
    from app.services.knowledge import web_refresh
    from app.services.knowledge.web_publication import (
        config_fingerprint,
        content_hash,
    )
    from app.services.web_scraper import ScrapedContent

    document, _ = staged_web
    kb.json = {"spec": {**kb.json["spec"], "webAutoUpdateEnabled": True}}
    document.source_config = {
        **document.source_config,
        "webAutoUpdate": {"content_hash": content_hash("original")},
        "published_index_fingerprint": config_fingerprint(kb, document, test_db),
    }
    test_db.commit()
    live_id = document.attachment_id
    monkeypatch.setattr(
        web_refresh,
        "scrape_with_domain_lease",
        AsyncMock(
            return_value=ScrapedContent(
                url=document.source_config["url"], success=True, content="original"
            )
        ),
    )
    result = asyncio.run(
        web_refresh.refresh_web_document(
            test_db,
            test_user,
            document.id,
            trigger_indexing=automatic,
            automatic=automatic,
        )
    )
    assert result["success"]
    assert document.attachment_id == live_id
    assert ("_web_refresh" in document.source_config) is automatic


@pytest.mark.parametrize("lose_during", ["validation", "retirement"])
def test_publication_lease_lost_before_commit_keeps_candidate(
    test_db, test_user, staged_web, monkeypatch, lose_during
):
    from app.services.knowledge import web_publication
    from app.services.knowledge.index_state_machine import mark_document_index_started

    document, lease = staged_web
    assert knowledge_orchestrator.reindex_document(test_db, test_user, document.id)[
        "success"
    ]
    generation = document.index_generation
    assert mark_document_index_started(test_db, document.id, generation).should_execute
    before = dict(document.source_config)
    attachment_id = document.attachment_id

    method = (
        "_requester_can_publish" if lose_during == "validation" else "retire_attachment"
    )
    original = getattr(web_publication, method)

    def lose_lease(*args):
        result = original(*args)
        lease.owned.return_value = False
        return result

    monkeypatch.setattr(web_publication, method, lose_lease)
    assert not web_publication.publish_candidate(
        test_db,
        document_id=document.id,
        generation=generation,
        chunks=None,
        lease=lease,
    )
    assert not test_db.in_transaction()
    assert document.source_config == before
    assert document.attachment_id == attachment_id


@pytest.mark.parametrize("rollback_reference", [False, True])
@pytest.mark.parametrize("changed_splitter", [False, True])
def test_expired_draft_cleanup_invalidates_reference_and_requires_refetch(
    test_db, test_user, staged_web, monkeypatch, rollback_reference, changed_splitter
):
    from app.services.knowledge.web_publication import WebDraftExpired
    from app.services.knowledge.web_version_cleanup import cleanup_retired_versions

    document, _ = staged_web
    draft_id = document.source_config["_web_refresh"]["attachment_id"]
    if rollback_reference:
        knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
    draft = test_db.get(SubtaskContext, draft_id)
    draft.type_data = {
        **draft.type_data,
        "web_index_version": {
            **draft.type_data["web_index_version"],
            "not_before": (datetime.now(timezone.utc) - timedelta(days=1)).isoformat(),
        },
    }
    test_db.commit()
    redis = MagicMock()
    redis.get.return_value = 0
    monkeypatch.setattr(
        "app.services.knowledge.web_version_cleanup.distributed_lock._redis_client",
        redis,
    )
    gateway = MagicMock()
    gateway.delete_document_index = AsyncMock(return_value={"status": "success"})
    monkeypatch.setattr(
        "app.services.rag.gateway_factory.get_rag_gateway", lambda: gateway
    )
    cleanup_retired_versions(test_db)
    assert test_db.get(SubtaskContext, draft_id) is None
    test_db.refresh(document)
    if rollback_reference:
        from app.services.knowledge.index_state_machine import (
            mark_document_index_failed,
        )

        assert mark_document_index_failed(
            test_db, document.id, document.index_generation
        )
    assert document.source_config["_web_refresh"]["expired"]
    assert document.source_config["_web_refresh"]["attachment_id"] is None
    if changed_splitter:
        document.splitter_config = {"chunk_size": 128}
        test_db.commit()
    for _ in range(2):
        with pytest.raises(WebDraftExpired, match="refresh the page"):
            knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
    assert document.processing_error_payload["code"] == "web_draft_expired"


@pytest.mark.parametrize(
    ("summary", "expected"),
    [
        ("Existing summary", "Existing summary"),
        ({"status": "generating"}, None),
        (
            {"status": "generating", "short_summary": "Existing summary"},
            {"status": "completed", "short_summary": "Existing summary"},
        ),
    ],
)
def test_same_body_reindex_preserves_summary_and_attachment_reference(
    test_db, test_user, staged_web, summary, expected
):
    from app.services.knowledge.index_state_machine import mark_document_index_started
    from app.services.knowledge.summary_service import SummaryService
    from app.services.knowledge.web_publication import publish_candidate

    document, lease = staged_web
    config = dict(document.source_config)
    config.pop("_web_refresh")
    config["published_generation"] = 1
    config["summary_attachment_id"] = 900
    document.source_config = config
    document.summary = summary
    source_attachment_id = document.attachment_id
    test_db.commit()
    knowledge_orchestrator.reindex_document(test_db, test_user, document.id)
    assert mark_document_index_started(
        test_db, document.id, document.index_generation
    ).should_execute
    assert publish_candidate(
        test_db,
        document_id=document.id,
        generation=document.index_generation,
        chunks=None,
        lease=lease,
    )
    assert not SummaryService(test_db)._persist_document_summary(
        document.id,
        {"status": "completed", "short_summary": "Stale"},
        source_attachment_id,
    )
    assert document.summary == expected
    assert document.source_config["summary_attachment_id"] == 900
