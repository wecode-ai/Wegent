# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Regression contracts for caller-authorized, independent document bodies."""

from unittest.mock import MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.kind import Kind
from app.models.knowledge import KnowledgeDocument
from app.models.subtask_context import ContextStatus, ContextType, SubtaskContext
from app.models.user import User
from app.schemas.knowledge import KnowledgeDocumentCreate, KnowledgeDocumentResponse
from app.services.context import context_service
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
