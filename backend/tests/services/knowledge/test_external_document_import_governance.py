# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service tests for single external document import."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy import create_engine, event
from sqlalchemy.orm import Session

from app.core.exceptions import StructuredValidationException
from app.models.kind import Kind
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    DocumentStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
    KnowledgeFolderCreate,
)
from app.schemas.share import MemberRole
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalSourceUnavailableError,
    get_external_document_provider,
)
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.index_state_machine import (
    begin_external_import_attempt,
    mark_document_index_succeeded,
    prepare_document_index_enqueue,
)
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.share import knowledge_share_service

from .conftest import create_external_import_kb as _create_kb
from .conftest import create_synced_node as _create_synced_node


def test_importing_copy_cannot_be_transferred(
    test_db: Session,
    test_user: User,
    configured_dingtalk: None,
    dispatch_calls: list[dict],
) -> None:
    source_id = _create_kb(test_db, test_user.id, "source")
    target_id = _create_kb(test_db, test_user.id, "target")
    node = _create_synced_node(test_db, test_user.id, "pending-source")
    document = external_document_import_service.import_document(
        test_db, test_user, source_id, "dingtalk", node.dingtalk_node_id
    )
    attempt = begin_external_import_attempt(
        test_db, document.id, dispatch_calls[-1]["expected_generation"]
    )

    with pytest.raises(StructuredValidationException) as exc_info:
        KnowledgeService.transfer_documents_to_kb(
            test_db, source_id, target_id, [document.id], [], test_user.id
        )

    assert exc_info.value.error_code == "EXTERNAL_DOCUMENT_NOT_READY"
    current = KnowledgeService.get_document(test_db, document.id, test_user.id)
    assert current.kind_id == source_id
    assert current.index_generation == attempt.generation
    assert current.index_status == DocumentIndexStatus.QUEUED
    assert len(dispatch_calls) == 1


@pytest.mark.parametrize("selection", ["single", "batch", "folder"])
@pytest.mark.parametrize(
    ("index_status", "attachment_id"),
    [
        (state, 4321)
        for state in DocumentIndexStatus
        if state != DocumentIndexStatus.SUCCESS
    ]
    + [(DocumentIndexStatus.SUCCESS, 0)],
)
def test_not_ready_copy_rejects_entire_transfer(
    test_db: Session,
    test_user: User,
    selection: str,
    index_status: DocumentIndexStatus,
    attachment_id: int,
) -> None:
    source_id = _create_kb(test_db, test_user.id, "source")
    target_id = _create_kb(test_db, test_user.id, "target")
    folder = KnowledgeFolderService.create_folder(
        test_db, source_id, test_user.id, KnowledgeFolderCreate(name="Folder")
    )
    documents = []
    for resource_id in ("ready", "not-ready"):
        document = KnowledgeService.create_external_document(
            test_db,
            source_id,
            test_user.id,
            name=resource_id,
            external_provider="dingtalk",
            external_resource_id=resource_id,
            folder_id=folder.id,
            external_meta={"title": resource_id},
        )
        document.index_status = DocumentIndexStatus.SUCCESS
        document.attachment_id = 4321
        documents.append(document)
    blocked = documents[-1]
    blocked.index_status = index_status
    blocked.attachment_id = attachment_id
    test_db.commit()
    document_ids = (
        [doc.id for doc in documents] if selection == "batch" else [blocked.id]
    )

    with pytest.raises(StructuredValidationException) as exc_info:
        KnowledgeService.transfer_documents_to_kb(
            test_db,
            source_id,
            target_id,
            [] if selection == "folder" else document_ids,
            [folder.id] if selection == "folder" else [],
            test_user.id,
        )

    assert exc_info.value.error_code == "EXTERNAL_DOCUMENT_NOT_READY"
    assert exc_info.value.payload == {"names": ["not-ready"]}
    assert KnowledgeService.list_documents(test_db, target_id, test_user.id) == []
    assert (
        KnowledgeFolderService.get_folder_tree(test_db, target_id, test_user.id) == []
    )
    remaining = KnowledgeService.list_documents(test_db, source_id, test_user.id)
    assert {doc.id for doc in remaining} == {doc.id for doc in documents}
    assert all(doc.folder_id == folder.id for doc in remaining)
    assert blocked.index_status == index_status


def test_transfer_checks_latest_state_not_cached_success(
    test_db: Session,
    test_user: User,
) -> None:
    source_id = _create_kb(test_db, test_user.id, "source")
    target_id = _create_kb(test_db, test_user.id, "target")
    document = KnowledgeService.create_external_document(
        test_db,
        source_id,
        test_user.id,
        name="copy",
        external_provider="dingtalk",
        external_resource_id="source",
        folder_id=0,
        external_meta={"title": "Source"},
    )
    document.attachment_id = 4321
    assert mark_document_index_succeeded(test_db, document.id, 0)
    # Model a refresh committed after this session cached the successful copy.
    test_db.connection().execute(
        KnowledgeDocument.__table__.update()
        .where(KnowledgeDocument.id == document.id)
        .values(index_status=DocumentIndexStatus.QUEUED, index_generation=1)
    )
    assert document.index_status == DocumentIndexStatus.SUCCESS

    with pytest.raises(StructuredValidationException) as exc_info:
        KnowledgeService.transfer_documents_to_kb(
            test_db, source_id, target_id, [document.id], [], test_user.id
        )

    assert exc_info.value.error_code == "EXTERNAL_DOCUMENT_NOT_READY"
    assert KnowledgeService.list_documents(test_db, target_id, test_user.id) == []


def test_moved_copy_refresh_uses_source_owner_and_target_index_owner(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    configured_dingtalk: None,
    dispatch_calls: list[dict],
) -> None:
    manager = User(user_name="target-owner", password_hash=test_user.password_hash)
    test_db.add(manager)
    test_db.commit()
    source_id = _create_kb(test_db, test_user.id, "shared-source")
    target_id = _create_kb(test_db, manager.id, "private-target")
    knowledge_share_service.add_member(
        test_db,
        resource_id=source_id,
        current_user_id=test_user.id,
        target_user_id=manager.id,
        role=MemberRole.Maintainer,
    )
    node = _create_synced_node(test_db, test_user.id, "moved-source")
    document = external_document_import_service.import_document(
        test_db, test_user, source_id, "dingtalk", node.dingtalk_node_id
    )
    document.attachment_id = 1234
    test_db.commit()
    assert mark_document_index_succeeded(test_db, document.id, 0)

    result = KnowledgeService.transfer_documents_to_kb(
        db=test_db,
        source_kb_id=source_id,
        target_kb_id=target_id,
        document_ids=[document.id],
        folder_ids=[],
        user_id=manager.id,
    )
    assert result.success
    test_db.refresh(document)
    assert document.external_source.kind_id == target_id
    assert (
        external_document_import_service.get_import_statuses(
            test_db, manager, source_id, "dingtalk", [node.dingtalk_node_id]
        )
        == {}
    )
    assert (
        node.dingtalk_node_id
        in external_document_import_service.get_import_statuses(
            test_db, manager, target_id, "dingtalk", [node.dingtalk_node_id]
        )
    )
    assert (
        KnowledgeService.get_knowledge_base(test_db, target_id, test_user.id)[1]
        is False
    )
    target = test_db.get(Kind, target_id)
    target.json = {
        **target.json,
        "spec": {
            **target.json["spec"],
            "retrievalConfig": {
                "retriever_name": "target-retriever",
                "embedding_config": {"model_name": "target-embedding"},
            },
        },
    }
    test_db.commit()
    fetch = AsyncMock(
        return_value=ExternalDocumentContent(
            name="New title", file_extension="md", content=b"new body"
        )
    )
    monkeypatch.setattr(
        get_external_document_provider("dingtalk"), "fetch_content", fetch
    )
    monkeypatch.setattr(
        "app.services.context.context_service.upload_attachment",
        MagicMock(return_value=(SimpleNamespace(id=4321), None)),
    )
    index = MagicMock(return_value=SimpleNamespace(id="target-index"))
    monkeypatch.setattr("app.tasks.knowledge_tasks.index_document_task.delay", index)

    external_document_import_service.import_document(
        test_db, manager, target_id, "dingtalk", node.dingtalk_node_id
    )
    attempt = begin_external_import_attempt(
        test_db, document.id, dispatch_calls[-1]["expected_generation"]
    )
    assert attempt.should_execute
    run_external_document_import(
        test_db, document, test_user, generation=attempt.generation
    )

    test_db.refresh(document)
    assert document.attachment_id == 4321
    assert document.user_id == test_user.id
    assert document.kind_id == target_id
    fetch.assert_awaited_once_with(test_db, test_user, node.dingtalk_node_id)
    assert index.call_args.kwargs["knowledge_base_id"] == str(target_id)
    assert index.call_args.kwargs["user_id"] == manager.id


@pytest.mark.parametrize("batch", [False, True])
def test_manager_reimports_with_original_importers_source_authorization(
    test_db: Session,
    test_user: User,
    monkeypatch: pytest.MonkeyPatch,
    dispatched: list[int],
    batch: bool,
) -> None:
    manager = User(
        user_name="kb-manager",
        password_hash=test_user.password_hash,
        email="manager@example.com",
        is_active=True,
    )
    test_db.add(manager)
    test_db.commit()
    kb_id = _create_kb(test_db, test_user.id)
    knowledge_share_service.add_member(
        test_db,
        resource_id=kb_id,
        current_user_id=test_user.id,
        target_user_id=manager.id,
        role=MemberRole.Maintainer,
    )
    node = _create_synced_node(test_db, test_user.id, "owner-source")
    monkeypatch.setattr(
        "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
        lambda user: user.id == test_user.id,
    )
    document = external_document_import_service.import_document(
        test_db, test_user, kb_id, "dingtalk", node.dingtalk_node_id
    )
    document.index_status = DocumentIndexStatus.SUCCESS
    document.is_active = True
    test_db.commit()

    if batch:
        external_document_import_service.import_documents(
            test_db, manager, kb_id, "dingtalk", [node.dingtalk_node_id]
        )
    else:
        external_document_import_service.import_document(
            test_db, manager, kb_id, "dingtalk", node.dingtalk_node_id
        )

    test_db.refresh(document)
    assert document.user_id == test_user.id
    assert document.index_status == DocumentIndexStatus.QUEUED
    assert dispatched == [document.id, document.id]


class TestExternalSourceUnavailable:
    def test_old_source_failure_cannot_overwrite_newer_success(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        engine = create_engine("sqlite:///:memory:")
        KnowledgeDocument.__table__.create(engine)
        KnowledgeDocumentExternalSource.__table__.create(engine)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(side_effect=ExternalSourceUnavailableError("gone"))
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import.get_external_document_provider",
            lambda provider_id: provider,
        )
        try:
            with Session(engine) as old_worker:
                document = KnowledgeDocument(
                    kind_id=1,
                    user_id=1,
                    name="Source",
                    file_extension="md",
                    source_type="external",
                    external_source=KnowledgeDocumentExternalSource(
                        kind_id=1,
                        external_provider="dingtalk",
                        external_resource_id="source",
                    ),
                    index_generation=1,
                    index_status=DocumentIndexStatus.QUEUED,
                )
                old_worker.add(document)
                old_worker.commit()
                document_id = document.id
                advanced = False

                def complete_new_attempt(session: Session) -> None:
                    nonlocal advanced
                    if advanced:
                        return
                    advanced = True
                    # A retry completes after the old failure becomes visible.
                    with Session(engine) as new_worker:
                        decision = prepare_document_index_enqueue(
                            new_worker, document_id
                        )
                        assert decision.should_enqueue
                        # The newer attempt has read and landed the source metadata.
                        current = new_worker.get(KnowledgeDocument, document_id)
                        current.update_external_source_config(
                            status="accessible", last_error=None
                        )
                        new_worker.commit()
                        assert mark_document_index_succeeded(
                            new_worker, document_id, decision.generation
                        )

                event.listen(old_worker, "after_commit", complete_new_attempt)
                run_external_document_import(
                    old_worker, document, SimpleNamespace(id=1), generation=1
                )

            with Session(engine) as reader:
                current = reader.get(KnowledgeDocument, document_id)
                assert current.index_generation == 2
                assert current.index_status == DocumentIndexStatus.SUCCESS
                assert current.external_source_config["status"] == "accessible"
                assert "last_error" not in current.external_source_config
                assert current.processing_error_payload is None
        finally:
            engine.dispose()

    def _create_live_document(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "source-unavailable-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Unavailable Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk", "title": "Old"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="v" * 32,
            ),
            index_status=DocumentIndexStatus.QUEUED,
            index_generation=1,
            is_active=False,
            status="disabled",
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_unavailable_initial_import_is_retryable_and_marked_inaccessible(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_live_document(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(
                side_effect=ExternalSourceUnavailableError("node not found")
            ),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user, generation=1)

        test_db.refresh(document)
        # The failed placeholder survives so the user can retry it.
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.attachment_id == 0
        assert document.is_active is False
        external = document.source_config["external"]
        assert external["status"] == "inaccessible"
        assert external["last_error"] == (
            "The external source is no longer accessible. Restore access "
            "and retry the import."
        )
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_source_unavailable"

    def test_transient_fetch_failure_does_not_mark_inaccessible(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_live_document(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(side_effect=ExternalDocumentFetchError("boom")),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user, generation=1)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.processing_error_payload["code"] == "external_import_failed"
        assert document.source_config["external"].get("status") is None

    def test_stale_generation_does_not_mark_inaccessible(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_live_document(test_db, test_user)
        # A newer attempt already superseded this run's generation.
        document.index_generation = 2
        document.index_status = DocumentIndexStatus.INDEXING
        test_db.commit()
        provider = SimpleNamespace(
            fetch_content=AsyncMock(
                side_effect=ExternalSourceUnavailableError("node not found")
            ),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user, generation=1)

        test_db.refresh(document)
        # The stale attempt must not overwrite the newer attempt's outcome.
        assert document.index_status == DocumentIndexStatus.INDEXING
        assert document.source_config["external"].get("status") is None


class TestExternalDocumentBodyReadOnly:
    def _create_external_document(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "readonly-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=888,
            name="Readonly Doc",
            file_extension="md",
            file_size=100,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="q" * 32,
            ),
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
            status="enabled",
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_body_edit_is_rejected(self, test_db: Session, test_user: User) -> None:
        document = self._create_external_document(test_db, test_user)

        with pytest.raises(ValueError, match="read-only"):
            KnowledgeService.update_document_content(
                db=test_db,
                document_id=document.id,
                content="# edited",
                user_id=test_user.id,
            )

    def test_rename_still_allowed(self, test_db: Session, test_user: User) -> None:
        document = self._create_external_document(test_db, test_user)

        updated = KnowledgeService.update_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
            data=KnowledgeDocumentUpdate(name="Renamed Doc"),
        )

        assert updated is not None
        assert updated.name == "Renamed Doc"


class TestConcurrentDuplicateIdentity:
    def test_long_provider_title_is_preserved_in_metadata_and_fits_document_name(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "long-external-title-kb")
        long_title = "长" * 500
        node = _create_synced_node(
            test_db,
            test_user.id,
            "ab" * 16,
            name=long_title,
        )

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert document.name == long_title[:255]
        assert document.external_source_config["title"] == long_title

    def test_unique_index_rejects_second_row(
        self, test_db: Session, test_user: User
    ) -> None:
        from sqlalchemy.exc import IntegrityError

        kb_id = _create_kb(test_db, test_user.id, "concurrent-external-kb")

        def _add(resource_suffix: str) -> None:
            KnowledgeService.create_external_document(
                test_db,
                kb_id,
                test_user.id,
                name=f"Concurrent {resource_suffix}",
                external_provider="dingtalk",
                external_resource_id="cc" * 16,
                folder_id=0,
                external_meta={},
            )

        _add("first")
        with pytest.raises(IntegrityError):
            _add("second")
        assert test_db.is_active
        assert test_db.query(KnowledgeDocument).count() == 1
        assert test_db.query(KnowledgeDocumentExternalSource).count() == 1

    def test_import_reuses_identity_created_by_concurrent_request(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from sqlalchemy.exc import IntegrityError

        kb_id = _create_kb(test_db, test_user.id, "concurrent-external-kb-2")
        node = _create_synced_node(test_db, test_user.id, "dd" * 16, name="Race Doc")
        loser = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Race Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id=node.dingtalk_node_id,
            ),
            index_status=DocumentIndexStatus.QUEUED,
            is_active=False,
        )
        test_db.add(loser)
        test_db.commit()

        # Simulate a race: the initial identity lookup misses, another request
        # commits the winner, and this request loses on the unique index.
        lookups = iter([None, loser])
        monkeypatch.setattr(
            external_document_import_service,
            "_find_existing_document",
            lambda *args: next(lookups),
        )

        def raise_integrity_error(**kwargs):
            raise IntegrityError("duplicate external identity", None, Exception())

        monkeypatch.setattr(
            KnowledgeService,
            "create_external_document",
            staticmethod(raise_integrity_error),
        )

        result = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert result.id == loser.id
        assert test_db.query(KnowledgeDocument).count() == 1
        assert dispatch_calls == []

    def test_settled_document_is_reported_as_updated(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """A document settled by a concurrent request is counted, not lost."""
        kb_id = _create_kb(test_db, test_user.id)
        settled_node = _create_synced_node(
            test_db, test_user.id, "ee" * 16, name="Settled Doc"
        )
        settled = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=settled_node.dingtalk_node_id,
        )
        settled.index_status = DocumentIndexStatus.SUCCESS
        test_db.commit()

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[settled_node.dingtalk_node_id],
        )

        assert result.created == []
        assert [document.id for document in result.updated] == [settled.id]
        assert result.processing == []

    def test_batch_does_not_hide_unrelated_integrity_error(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from sqlalchemy.exc import IntegrityError

        kb_id = _create_kb(test_db, test_user.id, "batch-integrity-kb")
        node = _create_synced_node(test_db, test_user.id, "fa" * 16)

        def raise_integrity_error(**kwargs):
            raise IntegrityError("not a duplicate", None, Exception())

        monkeypatch.setattr(
            KnowledgeService,
            "create_external_document",
            staticmethod(raise_integrity_error),
        )

        with pytest.raises(ExternalDocumentImportError, match="could not be imported"):
            external_document_import_service.import_documents(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_ids=[node.dingtalk_node_id],
            )

        assert dispatch_calls == []
