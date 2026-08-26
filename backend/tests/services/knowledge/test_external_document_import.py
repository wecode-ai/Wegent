# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service tests for single external document import."""

from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest
from sqlalchemy.orm import Session

import app.tasks.knowledge_tasks as knowledge_tasks_module
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.knowledge import (
    DocumentIndexStatus,
    DocumentSourceType,
    DocumentStatus,
    KnowledgeDocument,
)
from app.models.user import User
from app.schemas.knowledge import (
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeDocumentUpdate,
)
from app.services.knowledge.external_document_import import (
    external_document_import_service,
    run_external_document_import,
)
from app.services.knowledge.external_document_providers import (
    ExternalDocumentAlreadyImportedError,
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    get_external_document_provider,
)
from app.services.knowledge.knowledge_service import KnowledgeService


def _create_kb(test_db: Session, user_id: int, name: str = "external-import-kb") -> int:
    return KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name=name),
    )


def _create_synced_node(
    test_db: Session,
    user_id: int,
    dingtalk_node_id: str,
    name: str = "DingTalk Doc",
    node_type: str = "doc",
    is_active: bool = True,
) -> DingtalkSyncedNode:
    node = DingtalkSyncedNode(
        user_id=user_id,
        dingtalk_node_id=dingtalk_node_id,
        name=name,
        doc_url=f"https://alidocs.dingtalk.com/i/nodes/{dingtalk_node_id}",
        parent_node_id="",
        node_type=node_type,
        workspace_id="",
        is_active=is_active,
        last_synced_at=datetime.now(timezone.utc),
    )
    test_db.add(node)
    test_db.commit()
    test_db.refresh(node)
    return node


@pytest.fixture
def configured_dingtalk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
        lambda user: True,
    )


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Capture background import task dispatches instead of hitting Celery."""
    document_ids: list[int] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(
            delay=lambda **kwargs: document_ids.append(kwargs["document_id"])
        ),
    )
    return document_ids


class TestProviderRegistry:
    def test_dingtalk_provider_is_registered(self) -> None:
        provider = get_external_document_provider("dingtalk")

        assert provider is not None
        assert provider.provider_id == "dingtalk"

    def test_unknown_provider_returns_none(self) -> None:
        assert get_external_document_provider("nope") is None


class TestImportDocument:
    def test_creates_placeholder_and_dispatches_background_fetch(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "a" * 32, name="Spec Doc")

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
            folder_id=0,
        )

        assert document.kind_id == kb_id
        assert document.name == "Spec Doc"
        assert document.source_type == DocumentSourceType.EXTERNAL.value
        assert document.external_provider == "dingtalk"
        assert document.external_resource_id == node.dingtalk_node_id
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.is_active is False
        assert document.status.value == "disabled"
        assert document.attachment_id == 0
        assert document.source_config["external"]["url"] == node.doc_url
        assert dispatched == [document.id]

    def test_external_identity_pairing_is_consistent(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "j" * 32, name="Pair Doc")
        regular = KnowledgeService.create_document(
            db=test_db,
            knowledge_base_id=kb_id,
            user_id=test_user.id,
            data=KnowledgeDocumentCreate(
                name="Regular",
                file_extension="md",
                file_size=10,
                source_type=DocumentSourceType.TEXT,
            ),
        )

        external = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        # Both columns are NULL together (regular) or set together (external).
        assert regular.external_provider is None
        assert regular.external_resource_id is None
        assert external.external_provider == "dingtalk"
        assert external.external_resource_id == node.dingtalk_node_id

    def test_rejects_unknown_provider(
        self,
        test_db: Session,
        test_user: User,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="nope",
                external_resource_id="x",
            )

        assert exc_info.value.status_code == 400

    def test_rejects_node_owned_by_another_user(
        self,
        test_db: Session,
        test_admin_user: User,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_admin_user.id, "b" * 32)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id=node.dingtalk_node_id,
            )

        assert exc_info.value.status_code == 404

    def test_rejects_non_doc_nodes(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        _create_synced_node(test_db, test_user.id, "c" * 32, node_type="folder")

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id="c" * 32,
            )

        assert exc_info.value.status_code == 400

    def test_rejects_inactive_nodes(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        _create_synced_node(test_db, test_user.id, "d" * 32, is_active=False)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id="d" * 32,
            )

        assert exc_info.value.status_code == 404

    def test_rejects_without_manage_permission(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "e" * 32)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id=node.dingtalk_node_id,
            )

        assert exc_info.value.status_code == 403

    def test_rejects_folder_from_other_knowledge_base(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        from app.schemas.knowledge import KnowledgeFolderCreate
        from app.services.knowledge.folder_service import KnowledgeFolderService

        kb_id = _create_kb(test_db, test_user.id, "external-import-kb-a")
        other_kb_id = _create_kb(test_db, test_user.id, "external-import-kb-b")
        folder = KnowledgeFolderService.create_folder(
            test_db,
            other_kb_id,
            test_user.id,
            KnowledgeFolderCreate(name="Other KB folder"),
        )
        node = _create_synced_node(test_db, test_user.id, "f" * 32)

        with pytest.raises(ValueError):
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id=node.dingtalk_node_id,
                folder_id=folder.id,
            )

    def test_rejects_duplicate_external_identity(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "g" * 32, name="Once Doc")

        external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        with pytest.raises(ExternalDocumentAlreadyImportedError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id=node.dingtalk_node_id,
            )

        assert exc_info.value.status_code == 409

    def test_placeholder_cannot_be_enabled_before_content_ready(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "i" * 32)

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        with pytest.raises(ValueError):
            KnowledgeService.update_document(
                db=test_db,
                document_id=document.id,
                user_id=test_user.id,
                data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
            )


class TestImportDocuments:
    def test_creates_one_placeholder_per_document(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        first = _create_synced_node(test_db, test_user.id, "k" * 32, name="Batch A")
        second = _create_synced_node(test_db, test_user.id, "l" * 32, name="Batch B")

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[first.dingtalk_node_id, second.dingtalk_node_id],
        )

        assert result.requested_count == 2
        assert [document.name for document in result.imported] == ["Batch A", "Batch B"]
        assert result.skipped_existing == []
        assert sorted(dispatched) == sorted(document.id for document in result.imported)
        for document in result.imported:
            assert document.source_type == DocumentSourceType.EXTERNAL
            assert document.external_provider == "dingtalk"
            assert document.index_status == DocumentIndexStatus.QUEUED
            assert document.is_active is False

    def test_deduplicates_by_external_identity(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "m" * 32, name="Dup Doc")

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[
                node.dingtalk_node_id,
                node.dingtalk_node_id,
            ],
        )

        assert result.requested_count == 1
        assert len(result.imported) == 1
        assert len(dispatched) == 1

    def test_rejects_batch_over_the_fifty_document_cap(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        resource_ids = [f"cap-{index:03d}" for index in range(51)]
        for resource_id in resource_ids:
            _create_synced_node(test_db, test_user.id, resource_id)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_documents(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_ids=resource_ids,
            )

        assert exc_info.value.status_code == 400
        assert dispatched == []

    def test_reports_already_imported_documents_as_skipped(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        existing_node = _create_synced_node(
            test_db, test_user.id, "n" * 32, name="Old Doc"
        )
        existing = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=existing_node.dingtalk_node_id,
        )
        new_node = _create_synced_node(test_db, test_user.id, "o" * 32, name="New Doc")

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[
                existing_node.dingtalk_node_id,
                new_node.dingtalk_node_id,
            ],
        )

        assert result.requested_count == 2
        assert len(result.imported) == 1
        assert [(item.resource_id, item.name) for item in result.skipped_existing] == [
            (existing_node.dingtalk_node_id, "Old Doc")
        ]
        # The already-imported document is untouched: no new dispatch for it.
        assert dispatched == [existing.id, result.imported[0].id]

    def test_rejects_invalid_item_before_creating_any_placeholder(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        good_node = _create_synced_node(test_db, test_user.id, "p" * 32, name="Good")
        _create_synced_node(
            test_db, test_user.id, "q" * 32, name="Bin File", node_type="file"
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_documents(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_ids=[
                    good_node.dingtalk_node_id,
                    "q" * 32,
                ],
            )

        assert exc_info.value.status_code == 400
        assert dispatched == []
        assert test_db.query(KnowledgeDocument).count() == 0


class TestAttachExternalDocumentContent:
    def _create_placeholder(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "attach-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Attach Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk",
            external_resource_id="k" * 32,
            index_status=DocumentIndexStatus.QUEUED,
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_uploads_attachment_and_schedules_indexing(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        content = ExternalDocumentContent(
            name="Attach Doc",
            file_extension="md",
            content=b"# Attach Doc",
            metadata={"provider": "dingtalk"},
        )
        attachment = SimpleNamespace(id=4321)
        upload_attachment = MagicMock(return_value=(attachment, None))
        scheduled: dict = {}
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            upload_attachment,
        )
        monkeypatch.setattr(
            knowledge_orchestrator,
            "_schedule_indexing_celery",
            lambda **kwargs: scheduled.update(kwargs) or {"scheduled": True},
        )

        result = knowledge_orchestrator.attach_external_document_content(
            db=test_db,
            document=document,
            user=test_user,
            content=content,
        )

        upload_attachment.assert_called_once_with(
            db=test_db,
            user_id=test_user.id,
            filename="Attach Doc.md",
            binary_data=b"# Attach Doc",
            subtask_id=0,
        )
        assert document.attachment_id == 4321
        assert document.file_size == len(b"# Attach Doc")
        assert result == {"scheduled": True}
        # replace_active supersedes the placeholder's initial queued state.
        assert scheduled["replace_active"] is True
        assert scheduled["document"].id == document.id


class TestRunExternalDocumentImport:
    def _create_placeholder(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "external-import-run-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Run Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk",
            external_resource_id="h" * 32,
            index_status=DocumentIndexStatus.QUEUED,
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_attaches_content_through_orchestrator(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        content = ExternalDocumentContent(
            name="Run Doc",
            file_extension="md",
            content=b"# Run Doc",
            metadata={"provider": "dingtalk"},
        )
        provider = SimpleNamespace(
            fetch_content=AsyncMock(return_value=content),
        )
        attached: dict = {}

        def fake_attach(**kwargs):
            attached.update(kwargs)
            return {"scheduled": True}

        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            ".attach_external_document_content",
            fake_attach,
        )

        run_external_document_import(test_db, document, test_user)

        provider.fetch_content.assert_awaited_once_with(test_db, test_user, "h" * 32)
        assert attached["document"].id == document.id
        assert attached["content"] is content

    def test_fetch_failure_marks_document_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(side_effect=ExternalDocumentFetchError("boom")),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )

        run_external_document_import(test_db, document, test_user)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_import_failed"
        assert error["retryable"] is True

    def test_unsupported_provider_marks_document_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        document.external_provider = "gone"
        document.external_resource_id = "h" * 32
        test_db.commit()

        run_external_document_import(test_db, document, test_user)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.processing_error_payload["code"] == "external_import_failed"
