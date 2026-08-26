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
    ExternalDocumentContent,
    ExternalDocumentFetchError,
    ExternalDocumentImportError,
    ExternalSourceUnavailableError,
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


@pytest.fixture
def dispatch_calls(monkeypatch: pytest.MonkeyPatch) -> list[dict]:
    """Capture full background import task dispatch kwargs (incl. update)."""
    calls: list[dict] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(delay=lambda **kwargs: calls.append(kwargs)),
    )
    return calls


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

    def test_reimport_updates_existing_document(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
    ) -> None:
        from app.schemas.knowledge import KnowledgeFolderCreate
        from app.services.knowledge.folder_service import KnowledgeFolderService

        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "g" * 32, name="Once Doc")

        first = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )
        # Simulate a successful import, then user-owned changes.
        first.index_status = DocumentIndexStatus.SUCCESS
        first.is_active = True
        first.attachment_id = 777
        first.name = "My Renamed Doc"
        test_db.commit()
        folder = KnowledgeFolderService.create_folder(
            test_db, kb_id, test_user.id, KnowledgeFolderCreate(name="Keep")
        )
        first.folder_id = folder.id
        test_db.commit()

        second = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        # The same record is reused and re-queued for an update; the user's
        # name and folder survive the re-import.
        assert second.id == first.id
        assert test_db.query(KnowledgeDocument).count() == 1
        assert second.name == "My Renamed Doc"
        assert second.folder_id == folder.id
        assert second.is_active is True
        assert second.index_status == DocumentIndexStatus.QUEUED
        assert dispatch_calls == [
            {"document_id": first.id, "update": False},
            {"document_id": first.id, "update": True},
        ]

    def test_reimport_while_in_progress_is_rejected(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "w" * 32, name="Busy Doc")

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )
        assert document.index_status == DocumentIndexStatus.QUEUED

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.import_document(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_id=node.dingtalk_node_id,
            )

        assert exc_info.value.status_code == 409
        # Only the initial dispatch happened; no second task was queued.
        assert dispatch_calls == [{"document_id": document.id, "update": False}]

    def test_reimport_after_delete_creates_new_document(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        import app.services.knowledge.knowledge_service as knowledge_service_module

        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "x" * 32, name="Gone Doc")

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )
        monkeypatch.setattr(
            knowledge_service_module, "_get_delete_gateway", MagicMock()
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(return_value=True),
        )
        KnowledgeService.delete_document(
            db=test_db, document_id=document.id, user_id=test_user.id
        )

        recreated = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        # Deleting the document released the external identity: re-import
        # creates a fresh record instead of reviving the old one.
        assert recreated.id != document.id
        assert test_db.query(KnowledgeDocument).count() == 1
        assert recreated.name == "Gone Doc"

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

    def test_updates_settled_documents_and_imports_new_ones(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
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
        # A settled (successful) document is queued for an update, not skipped.
        existing.index_status = DocumentIndexStatus.SUCCESS
        test_db.commit()
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
        assert [item.name for item in result.updated_existing] == ["Old Doc"]
        assert result.skipped_existing == []
        # Placeholders are created first, then updates are queued.
        assert dispatch_calls == [
            {"document_id": existing.id, "update": False},
            {"document_id": result.imported[0].id, "update": False},
            {"document_id": existing.id, "update": True},
        ]

    def test_skips_documents_still_being_processed(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        busy_node = _create_synced_node(
            test_db, test_user.id, "y" * 32, name="Busy Doc"
        )
        busy = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=busy_node.dingtalk_node_id,
        )
        assert busy.index_status == DocumentIndexStatus.QUEUED

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[busy_node.dingtalk_node_id],
        )

        assert result.imported == []
        assert result.updated_existing == []
        assert [(item.resource_id, item.name) for item in result.skipped_existing] == [
            (busy_node.dingtalk_node_id, "Busy Doc")
        ]
        assert dispatch_calls == [{"document_id": busy.id, "update": False}]

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
            generation=0,
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

    def test_deleted_document_is_not_revived_and_attachment_cleaned(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.external_document_providers import (
            ExternalImportLostWriteError,
        )
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        document_id = document.id
        # Bulk delete keeps the in-memory ORM object's loaded attributes, the
        # same state a worker session holds when another session deletes the
        # row mid-run.
        test_db.query(KnowledgeDocument).filter(
            KnowledgeDocument.id == document_id
        ).delete(synchronize_session=False)
        test_db.commit()

        content = ExternalDocumentContent(
            name="Attach Doc",
            file_extension="md",
            content=b"# Attach Doc",
            metadata={},
        )
        attachment = SimpleNamespace(id=4321)
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )

        with pytest.raises(ExternalImportLostWriteError):
            knowledge_orchestrator.attach_external_document_content(
                db=test_db,
                document=document,
                user=test_user,
                content=content,
                generation=0,
            )

        # The orphan attachment created by this attempt is removed...
        assert deleted_ids == [
            {
                "db": test_db,
                "context_id": 4321,
                "user_id": test_user.id,
            }
        ]
        # ...and the document row is not recreated.
        assert (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .count()
            == 0
        )

    def test_superseded_generation_does_not_overwrite(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.external_document_providers import (
            ExternalImportLostWriteError,
        )
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        # A newer attempt already claimed generation 2 and landed its content.
        document.index_generation = 2
        document.attachment_id = 5555
        test_db.commit()

        attachment = SimpleNamespace(id=4321)
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )

        with pytest.raises(ExternalImportLostWriteError):
            knowledge_orchestrator.attach_external_document_content(
                db=test_db,
                document=document,
                user=test_user,
                content=ExternalDocumentContent(
                    name="Attach Doc",
                    file_extension="md",
                    content=b"# stale",
                    metadata={},
                ),
                generation=1,
            )

        test_db.refresh(document)
        # The stale attempt neither overwrote the attachment nor deleted the
        # newer attempt's valid attachment.
        assert document.attachment_id == 5555
        assert deleted_ids == [
            {"db": test_db, "context_id": 4321, "user_id": test_user.id}
        ]

    def test_successful_retry_replaces_previous_attachment(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        document.index_generation = 1
        document.attachment_id = 1111
        test_db.commit()

        attachment = SimpleNamespace(id=2222)
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            "._schedule_indexing_celery",
            lambda **kwargs: {"scheduled": True},
        )

        knowledge_orchestrator.attach_external_document_content(
            db=test_db,
            document=document,
            user=test_user,
            content=ExternalDocumentContent(
                name="Attach Doc",
                file_extension="md",
                content=b"# fresh",
                metadata={},
            ),
            generation=1,
        )

        test_db.refresh(document)
        assert document.attachment_id == 2222
        assert document.file_size == len(b"# fresh")
        # Only the replaced attachment of this document is deleted.
        assert deleted_ids == [
            {"db": test_db, "context_id": 1111, "user_id": test_user.id}
        ]


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

        run_external_document_import(test_db, document, test_user, generation=0)

        provider.fetch_content.assert_awaited_once_with(test_db, test_user, "h" * 32)
        assert attached["document"].id == document.id
        assert attached["content"] is content
        assert attached["generation"] == 0

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

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_import_failed"
        assert error["retryable"] is True
        assert error["generation"] == 0

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

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.processing_error_payload["code"] == "external_import_failed"

    def test_stale_generation_failure_is_ignored(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        document = self._create_placeholder(test_db, test_user)
        # A newer attempt already superseded this run's generation.
        document.index_generation = 2
        document.index_status = DocumentIndexStatus.INDEXING
        test_db.commit()
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
        assert document.index_status == DocumentIndexStatus.INDEXING
        assert document.index_generation == 2
        assert document.processing_error_payload is None

    def test_lost_write_stands_down_without_marking_failed(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.external_document_providers import (
            ExternalImportLostWriteError,
        )

        document = self._create_placeholder(test_db, test_user)
        provider = SimpleNamespace(
            fetch_content=AsyncMock(
                return_value=ExternalDocumentContent(
                    name="Run Doc",
                    file_extension="md",
                    content=b"# Run Doc",
                    metadata={},
                )
            ),
        )
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import"
            ".get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.knowledge.orchestrator.knowledge_orchestrator"
            ".attach_external_document_content",
            MagicMock(side_effect=ExternalImportLostWriteError("superseded")),
        )

        run_external_document_import(test_db, document, test_user, generation=0)

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.processing_error_payload is None

    def test_single_failure_does_not_affect_sibling_documents(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "batch-independence-kb")
        failing = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Failing Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk",
            external_resource_id="r" * 32,
            index_status=DocumentIndexStatus.QUEUED,
        )
        succeeding = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Succeeding Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk",
            external_resource_id="s" * 32,
            index_status=DocumentIndexStatus.QUEUED,
        )
        test_db.add_all([failing, succeeding])
        test_db.commit()

        def fake_fetch(db, user, resource_id):
            if resource_id == "r" * 32:
                raise ExternalDocumentFetchError("boom")
            return ExternalDocumentContent(
                name="Succeeding Doc",
                file_extension="md",
                content=b"# ok",
                metadata={},
            )

        provider = SimpleNamespace(fetch_content=AsyncMock(side_effect=fake_fetch))
        attached: list[int] = []

        def fake_attach(**kwargs):
            attached.append(kwargs["document"].id)
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

        run_external_document_import(test_db, failing, test_user, generation=0)
        run_external_document_import(test_db, succeeding, test_user, generation=0)

        test_db.refresh(failing)
        test_db.refresh(succeeding)
        assert failing.index_status == DocumentIndexStatus.FAILED
        assert failing.processing_error_payload["code"] == "external_import_failed"
        assert succeeding.index_status == DocumentIndexStatus.QUEUED
        assert succeeding.processing_error_payload is None
        assert attached == [succeeding.id]


class TestRetryDocumentImport:
    def _create_failed_document(
        self,
        test_db: Session,
        test_user: User,
        *,
        index_status: DocumentIndexStatus = DocumentIndexStatus.FAILED,
        external: bool = True,
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "retry-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=0,
            name="Retry Doc",
            file_extension="md",
            file_size=0,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk" if external else None,
            external_resource_id="t" * 32 if external else None,
            index_status=index_status,
            index_generation=0,
        )
        document.set_processing_error_payload(
            {
                "stage": "system",
                "code": "external_import_failed",
                "message": "failed",
                "retryable": True,
                "generation": 0,
                "occurred_at": "2026-08-26T00:00:00Z",
            }
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_reuses_same_document_and_redispatches(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(test_db, test_user)

        result = external_document_import_service.retry_document_import(
            db=test_db, user=test_user, document_id=document.id
        )

        assert result.id == document.id
        assert dispatched == [document.id]
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.index_generation == 1
        assert document.processing_error_payload is None
        # Retry reuses the record instead of creating a copy.
        assert test_db.query(KnowledgeDocument).count() == 1

    def test_rejects_retry_while_import_in_progress(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(
            test_db, test_user, index_status=DocumentIndexStatus.QUEUED
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 409
        assert dispatched == []
        test_db.refresh(document)
        assert document.index_generation == 0

    def test_rejects_retry_of_successful_import(
        self,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(
            test_db, test_user, index_status=DocumentIndexStatus.SUCCESS
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 409
        assert dispatched == []

    def test_rejects_non_external_document(
        self,
        test_db: Session,
        test_user: User,
    ) -> None:
        document = self._create_failed_document(test_db, test_user, external=False)

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 400

    def test_rejects_missing_document(
        self,
        test_db: Session,
        test_user: User,
    ) -> None:
        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=999999
            )

        assert exc_info.value.status_code == 404

    def test_rejects_without_manage_permission(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
        dispatched: list[int],
    ) -> None:
        document = self._create_failed_document(test_db, test_user)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        with pytest.raises(ExternalDocumentImportError) as exc_info:
            external_document_import_service.retry_document_import(
                db=test_db, user=test_user, document_id=document.id
            )

        assert exc_info.value.status_code == 403
        assert dispatched == []


class TestExternalDocumentPreviewAndEnableGuards:
    def _create_document(
        self,
        test_db: Session,
        test_user: User,
        *,
        attachment_id: int = 0,
        index_status: DocumentIndexStatus,
        is_active: bool = False,
        external: bool = True,
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "guards-external-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=attachment_id,
            name="Guard Doc",
            file_extension="md",
            file_size=10,
            user_id=test_user.id,
            source_type=(DocumentSourceType.EXTERNAL.value if external else "file"),
            source_config={"external": {"provider": "dingtalk"}},
            external_provider="dingtalk" if external else None,
            external_resource_id="u" * 32 if external else None,
            index_status=index_status,
            is_active=is_active,
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_placeholder_cannot_be_previewed(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db, test_user, index_status=DocumentIndexStatus.QUEUED
        )

        with pytest.raises(ValueError, match="not ready"):
            knowledge_orchestrator.read_document_content(
                db=test_db, user=test_user, document_id=document.id
            )

    def test_failed_import_cannot_be_previewed(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=False,
        )

        with pytest.raises(ValueError, match="not ready"):
            knowledge_orchestrator.read_document_content(
                db=test_db, user=test_user, document_id=document.id
            )

    def test_indexed_external_document_passes_preview_guard(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
        )

        # Guard passes; the read itself is exercised by the read-service tests.
        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_failed_reindex_of_active_document_stays_previewable(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=True,
        )

        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_non_external_failed_document_unchanged(
        self, test_db: Session, test_user: User
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            external=False,
        )

        knowledge_orchestrator._assert_external_document_previewable(document)

    def test_failed_import_cannot_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
        )

        with pytest.raises(ValueError):
            KnowledgeService.update_document(
                db=test_db,
                document_id=document.id,
                user_id=test_user.id,
                data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
            )

    def test_successful_import_can_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
        )

        updated = KnowledgeService.update_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
            data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
        )

        assert updated is not None
        assert updated.status == DocumentStatus.ENABLED

    def test_failed_reindex_of_active_document_can_be_enabled(
        self, test_db: Session, test_user: User
    ) -> None:
        document = self._create_document(
            test_db,
            test_user,
            attachment_id=99,
            index_status=DocumentIndexStatus.FAILED,
            is_active=True,
        )

        updated = KnowledgeService.update_document(
            db=test_db,
            document_id=document.id,
            user_id=test_user.id,
            data=KnowledgeDocumentUpdate(status=DocumentStatus.ENABLED),
        )

        assert updated is not None
        assert updated.status == DocumentStatus.ENABLED


class TestExternalUpdateSnapshotReplacement:
    """Re-import of a live document stages the new version before swapping."""

    def _create_live_document(
        self,
        test_db: Session,
        test_user: User,
        *,
        index_status: DocumentIndexStatus = DocumentIndexStatus.SUCCESS,
        is_active: bool = True,
        attachment_id: int = 1111,
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "external-update-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=attachment_id,
            name="Live Doc",
            file_extension="md",
            file_size=100,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={
                "external": {
                    "provider": "dingtalk",
                    "resource_id": "z" * 32,
                    "title": "Live Doc",
                    "url": "https://alidocs.dingtalk.com/i/nodes/live",
                }
            },
            external_provider="dingtalk",
            external_resource_id="z" * 32,
            index_status=index_status,
            index_generation=3,
            is_active=is_active,
            status="enabled" if is_active else "disabled",
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_update_stages_attachment_and_keeps_old_snapshot(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_live_document(test_db, test_user)
        attachment = SimpleNamespace(id=2222)
        scheduled: dict = {}
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )
        monkeypatch.setattr(
            knowledge_orchestrator,
            "_schedule_indexing_celery",
            lambda **kwargs: scheduled.update(kwargs) or {"scheduled": True},
        )

        knowledge_orchestrator.attach_external_document_content(
            db=test_db,
            document=document,
            user=test_user,
            content=ExternalDocumentContent(
                name="Live Doc v2",
                file_extension="md",
                content=b"# Live Doc v2",
                metadata={
                    "provider": "dingtalk",
                    "resource_id": "z" * 32,
                    "title": "Live Doc v2",
                    "url": "https://alidocs.dingtalk.com/i/nodes/live-v2",
                },
            ),
            generation=3,
        )

        test_db.refresh(document)
        # The old snapshot keeps serving reads; the new body is staged.
        assert document.attachment_id == 1111
        assert document.file_size == 100
        assert document.is_active is True
        external = document.source_config["external"]
        assert external["pending_attachment_id"] == 2222
        assert external["pending_file_size"] == len(b"# Live Doc v2")
        assert external["title"] == "Live Doc v2"
        assert external["url"] == "https://alidocs.dingtalk.com/i/nodes/live-v2"
        # Nothing was deleted: the old snapshot is still referenced.
        assert deleted_ids == []
        # Indexing is dispatched against the staged attachment.
        assert scheduled["attachment_id_override"] == 2222
        assert scheduled["replace_active"] is True

    def test_update_replaces_stale_staged_attachment(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_live_document(test_db, test_user)
        document.external_pending_attachment_id = 999
        document.update_external_source_config(pending_file_size=50)
        test_db.commit()

        attachment = SimpleNamespace(id=2222)
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )
        monkeypatch.setattr(
            knowledge_orchestrator,
            "_schedule_indexing_celery",
            lambda **kwargs: {"scheduled": True},
        )

        knowledge_orchestrator.attach_external_document_content(
            db=test_db,
            document=document,
            user=test_user,
            content=ExternalDocumentContent(
                name="Live Doc v2",
                file_extension="md",
                content=b"# fresh",
                metadata={},
            ),
            generation=3,
        )

        test_db.refresh(document)
        # The superseded attempt's staged attachment is cleaned up.
        assert deleted_ids == [
            {"db": test_db, "context_id": 999, "user_id": test_user.id}
        ]
        assert document.external_pending_attachment_id == 2222
        assert document.attachment_id == 1111

    def test_lost_write_still_stands_down_for_updates(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.external_document_providers import (
            ExternalImportLostWriteError,
        )
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_live_document(test_db, test_user)
        attachment = SimpleNamespace(id=2222)
        deleted_ids: list[int] = []
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(attachment, None)),
        )
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )

        # A newer attempt superseded this run's generation.
        document.index_generation = 4
        test_db.commit()

        with pytest.raises(ExternalImportLostWriteError):
            knowledge_orchestrator.attach_external_document_content(
                db=test_db,
                document=document,
                user=test_user,
                content=ExternalDocumentContent(
                    name="Live Doc v2",
                    file_extension="md",
                    content=b"# stale",
                    metadata={},
                ),
                generation=3,
            )

        test_db.refresh(document)
        assert document.attachment_id == 1111
        assert document.external_pending_attachment_id is None
        assert deleted_ids == [
            {"db": test_db, "context_id": 2222, "user_id": test_user.id}
        ]


class TestExternalSourceUnavailable:
    def _create_live_document(
        self, test_db: Session, test_user: User
    ) -> KnowledgeDocument:
        kb_id = _create_kb(test_db, test_user.id, "source-unavailable-kb")
        document = KnowledgeDocument(
            kind_id=kb_id,
            attachment_id=555,
            name="Snapshot Doc",
            file_extension="md",
            file_size=100,
            user_id=test_user.id,
            source_type=DocumentSourceType.EXTERNAL.value,
            source_config={"external": {"provider": "dingtalk", "title": "Old"}},
            external_provider="dingtalk",
            external_resource_id="v" * 32,
            index_status=DocumentIndexStatus.QUEUED,
            index_generation=1,
            is_active=True,
            status="enabled",
        )
        test_db.add(document)
        test_db.commit()
        test_db.refresh(document)
        return document

    def test_unavailable_source_keeps_snapshot_and_marks_inaccessible(
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
        # The document and its snapshot survive; the source is marked.
        assert document.index_status == DocumentIndexStatus.FAILED
        assert document.attachment_id == 555
        assert document.is_active is True
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

    def test_import_recovers_from_concurrent_placeholder_creation(
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
            index_status=DocumentIndexStatus.SUCCESS,
            is_active=True,
        )
        test_db.add(loser)
        test_db.commit()

        def raise_integrity_error(**kwargs):
            raise IntegrityError("dup", None, Exception())

        monkeypatch.setattr(
            KnowledgeService,
            "create_external_document",
            staticmethod(raise_integrity_error),
        )

        # The concurrent winner created the row; this request updates it
        # instead of failing or creating a duplicate.
        result = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert result.id == loser.id
        assert dispatch_calls == [{"document_id": loser.id, "update": True}]

    def test_concurrent_settle_is_reported_as_skipped(
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

        def reject_update(db, user, document):
            raise ExternalDocumentImportError("still processing", status_code=409)

        monkeypatch.setattr(
            external_document_import_service,
            "_redispatch_existing_import",
            reject_update,
        )

        result = external_document_import_service.import_documents(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_ids=[settled_node.dingtalk_node_id],
        )

        assert result.imported == []
        assert result.updated_existing == []
        assert [(item.resource_id, item.name) for item in result.skipped_existing] == [
            (settled_node.dingtalk_node_id, "Settled Doc")
        ]
