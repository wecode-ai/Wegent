# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service tests for single external document import."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    DocumentStatus,
    KnowledgeDocument,
)
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
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
from app.services.knowledge.knowledge_service import KnowledgeService
from app.services.share import knowledge_share_service

from .conftest import create_external_import_kb as _create_kb
from .conftest import create_synced_node as _create_synced_node


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
            external_provider="dingtalk",
            external_resource_id="v" * 32,
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
        assert external["last_error"] == "node not found"
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
            external_provider="dingtalk",
            external_resource_id="q" * 32,
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
            test_db.add(
                KnowledgeDocument(
                    kind_id=kb_id,
                    attachment_id=0,
                    name=f"Concurrent {resource_suffix}",
                    file_extension="md",
                    file_size=0,
                    user_id=test_user.id,
                    source_type=DocumentSourceType.EXTERNAL.value,
                    source_config={"external": {"provider": "dingtalk"}},
                    external_provider="dingtalk",
                    external_resource_id="cc" * 16,
                    index_status=DocumentIndexStatus.QUEUED,
                )
            )
            test_db.commit()

        _add("first")
        with pytest.raises(IntegrityError):
            _add("second")
        test_db.rollback()
        assert test_db.query(KnowledgeDocument).count() == 1

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
            external_provider="dingtalk",
            external_resource_id=node.dingtalk_node_id,
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
