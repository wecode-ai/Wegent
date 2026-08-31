# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Service tests for single external document import."""

from datetime import datetime, timedelta, timezone
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
    KnowledgeDocumentExternalSource,
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
        content_type="ALIDOC" if node_type == "doc" else "",
        raw_metadata={"extension": "adoc" if node_type == "doc" else ""},
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
    """Capture background import task dispatch kwargs."""
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
    def test_same_source_creates_independent_copies_in_different_kbs(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        first_kb_id = _create_kb(test_db, test_user.id, "external-copy-kb-a")
        second_kb_id = _create_kb(test_db, test_user.id, "external-copy-kb-b")
        node = _create_synced_node(
            test_db, test_user.id, "cross-kb-external-doc", name="Shared Source"
        )

        first = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=first_kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )
        second = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=second_kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert first.id != second.id
        assert (first.kind_id, second.kind_id) == (first_kb_id, second_kb_id)
        assert first.external_resource_id == second.external_resource_id
        assert dispatched == [first.id, second.id]

    def test_dispatch_failure_marks_placeholder_retryable(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        node = _create_synced_node(test_db, test_user.id, "dispatch-failure")
        kb_id = _create_kb(test_db, test_user.id)

        def fail_dispatch(**kwargs):
            raise RuntimeError("broker unavailable")

        monkeypatch.setattr(
            knowledge_tasks_module,
            "import_external_document_task",
            SimpleNamespace(delay=fail_dispatch),
        )

        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_import_dispatch_failed"
        assert error["retryable"] is True

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

        # Only external copies own an identity row.
        assert regular.external_source is None
        assert external.external_source.document_id == external.id
        assert external.external_source.kind_id == kb_id
        assert regular.external_provider is None
        assert regular.external_resource_id is None
        assert external.external_provider == "dingtalk"
        assert external.external_resource_id == node.dingtalk_node_id

    @pytest.mark.parametrize(
        ("provider", "resource_id"),
        [
            (None, "doc-1"),
            ("dingtalk", None),
            (None, None),
            ("", "doc-1"),
            ("dingtalk", ""),
        ],
    )
    def test_create_external_document_rejects_missing_identity(
        self,
        test_db: Session,
        test_user: User,
        provider: str | None,
        resource_id: str | None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)

        with pytest.raises(
            ValueError, match="External provider and resource ID are required"
        ):
            KnowledgeService.create_external_document(
                db=test_db,
                knowledge_base_id=kb_id,
                user_id=test_user.id,
                name="Invalid external document",
                external_provider=provider,
                external_resource_id=resource_id,
                folder_id=0,
                external_meta={},
            )

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

    def test_reimport_of_successful_document_refreshes_same_record(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
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

        refreshed = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert test_db.query(KnowledgeDocument).count() == 1
        test_db.refresh(first)
        assert refreshed.id == first.id
        assert first.name == "My Renamed Doc"
        assert first.folder_id == folder.id
        assert first.is_active is False
        assert first.index_status == DocumentIndexStatus.QUEUED
        assert dispatched == [first.id, first.id]

    def test_reimport_while_in_progress_reuses_current_attempt(
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

        existing = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert existing.id == document.id
        assert existing.index_status == DocumentIndexStatus.QUEUED
        # Only the initial dispatch happened; no second task was queued.
        assert dispatch_calls == [
            {"document_id": document.id, "expected_generation": 0}
        ]

    def test_reimport_reuses_stale_active_attempt_without_resolving_source(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(
            test_db, test_user.id, "stale-active-source", name="Stale Active"
        )
        document = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )
        document.updated_at = datetime.now(timezone.utc).replace(
            tzinfo=None
        ) - timedelta(days=1)
        node.is_active = False
        test_db.commit()

        reused = external_document_import_service.import_document(
            db=test_db,
            user=test_user,
            knowledge_base_id=kb_id,
            provider_id="dingtalk",
            external_resource_id=node.dingtalk_node_id,
        )

        assert reused.id == document.id
        assert reused.index_status == DocumentIndexStatus.QUEUED
        assert dispatch_calls == [
            {"document_id": document.id, "expected_generation": 0}
        ]

    @pytest.mark.parametrize("batch", [False, True])
    def test_reimport_after_delete_creates_new_document(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatch_calls: list[dict],
        monkeypatch: pytest.MonkeyPatch,
        batch: bool,
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
        if batch:
            result = KnowledgeService.batch_delete_documents(
                db=test_db, document_ids=[document.id], user_id=test_user.id
            )
            assert result.result.success_count == 1
        else:
            assert KnowledgeService.delete_document(
                db=test_db, document_id=document.id, user_id=test_user.id
            ).success
        assert test_db.get(KnowledgeDocumentExternalSource, document.id) is None

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
    def test_validates_all_settled_updates_before_dispatching_any(
        self,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        first_node = _create_synced_node(
            test_db, test_user.id, "batch-validate-first", name="First"
        )
        second_node = _create_synced_node(
            test_db, test_user.id, "batch-validate-second", name="Second"
        )
        first = external_document_import_service.import_document(
            test_db, test_user, kb_id, "dingtalk", first_node.dingtalk_node_id
        )
        second = external_document_import_service.import_document(
            test_db, test_user, kb_id, "dingtalk", second_node.dingtalk_node_id
        )
        first.index_status = DocumentIndexStatus.SUCCESS
        second.index_status = DocumentIndexStatus.SUCCESS
        first.is_active = True
        second.is_active = True
        second_node.is_active = False
        test_db.commit()

        with pytest.raises(ExternalDocumentImportError):
            external_document_import_service.import_documents(
                db=test_db,
                user=test_user,
                knowledge_base_id=kb_id,
                provider_id="dingtalk",
                external_resource_ids=[
                    first_node.dingtalk_node_id,
                    second_node.dingtalk_node_id,
                ],
            )

        test_db.refresh(first)
        assert first.index_status == DocumentIndexStatus.SUCCESS
        assert dispatched == [first.id, second.id]

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
        assert [document.name for document in result.created] == ["Batch A", "Batch B"]
        assert result.updated == []
        assert result.processing == []
        assert sorted(dispatched) == sorted(document.id for document in result.created)
        for document in result.created:
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
        assert len(result.created) == 1
        assert result.updated == []
        assert result.processing == []
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
        # A settled document refreshes in place while a new source creates a copy.
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
        assert [document.name for document in result.created] == ["New Doc"]
        assert [document.id for document in result.updated] == [existing.id]
        assert result.processing == []
        assert dispatched == [existing.id, existing.id, result.created[0].id]

    def test_reports_documents_still_being_processed(
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

        assert result.created == []
        assert result.updated == []
        assert [document.id for document in result.processing] == [busy.id]
        assert dispatch_calls == [{"document_id": busy.id, "expected_generation": 0}]

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
            external_source=KnowledgeDocumentExternalSource(
                kind_id=kb_id,
                external_provider="dingtalk",
                external_resource_id="k" * 32,
            ),
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

    def test_missing_retrieval_config_marks_import_retryable(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(SimpleNamespace(id=4321), None)),
        )

        result = knowledge_orchestrator.attach_external_document_content(
            db=test_db,
            document=document,
            user=test_user,
            content=ExternalDocumentContent(
                name="Attach Doc",
                file_extension="md",
                content=b"# Attach Doc",
                metadata={},
            ),
            generation=0,
        )

        assert result == {
            "scheduled": False,
            "reason": "missing_retrieval_config",
        }
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.FAILED
        error = document.processing_error_payload
        assert error is not None
        assert error["code"] == "external_import_index_not_scheduled"
        assert error["retryable"] is True

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
        document.update_external_source_config(
            status="inaccessible", last_error="Newer source failure"
        )
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
        assert document.external_source_config["status"] == "inaccessible"
        assert document.external_source_config["last_error"] == "Newer source failure"
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

    def test_failed_previous_success_refetches_and_replaces_attachment(
        self,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        from app.services.knowledge.orchestrator import knowledge_orchestrator

        document = self._create_placeholder(test_db, test_user)
        document.index_generation = 1
        document.index_status = DocumentIndexStatus.FAILED
        document.attachment_id = 1111
        document.is_active = True
        document.status = DocumentStatus.ENABLED
        test_db.commit()

        fresh_content = ExternalDocumentContent(
            name="Attach Doc",
            file_extension="md",
            content=b"# provider fresh body",
            metadata={},
        )
        provider = SimpleNamespace(fetch_content=AsyncMock(return_value=fresh_content))
        monkeypatch.setattr(
            "app.services.knowledge.external_document_import."
            "get_external_document_provider",
            lambda provider_id: provider,
        )
        monkeypatch.setattr(
            "app.services.context.context_service.upload_attachment",
            MagicMock(return_value=(SimpleNamespace(id=2222), None)),
        )
        deleted_ids: list[dict] = []
        monkeypatch.setattr(
            "app.services.context.context_service.delete_context",
            MagicMock(side_effect=lambda **kwargs: deleted_ids.append(kwargs)),
        )
        monkeypatch.setattr(
            knowledge_orchestrator,
            "_schedule_indexing_celery",
            lambda **kwargs: {"scheduled": True},
        )

        run_external_document_import(
            db=test_db,
            document=document,
            user=test_user,
            generation=1,
        )

        provider.fetch_content.assert_awaited_once_with(
            test_db, test_user, document.external_resource_id
        )
        test_db.refresh(document)
        assert document.attachment_id == 2222
        assert document.file_size == len(fresh_content.content)
        assert deleted_ids == [
            {"db": test_db, "context_id": 1111, "user_id": test_user.id}
        ]
