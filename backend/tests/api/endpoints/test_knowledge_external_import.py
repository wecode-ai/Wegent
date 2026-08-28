# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""API tests for the single external document import endpoint."""

from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.api.dependencies import get_db
from app.api.endpoints.knowledge import document_router, router
from app.core import security
from app.models.dingtalk_doc import DingtalkSyncedNode
from app.models.knowledge import (
    DocumentIndexStatus,
    KnowledgeDocument,
    KnowledgeDocumentExternalSource,
)
from app.models.user import User
from app.schemas.knowledge import KnowledgeBaseCreate, KnowledgeFolderCreate
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService


@pytest.fixture
def import_client(test_db: Session, test_user: User) -> TestClient:
    """Create a focused test client for the knowledge import endpoint."""

    app = FastAPI()
    app.include_router(router, prefix="/knowledge-bases")
    app.include_router(document_router, prefix="/knowledge-documents")

    def override_get_db():
        yield test_db

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[security.get_current_user] = lambda: test_user

    return TestClient(app)


@pytest.fixture
def configured_dingtalk(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(
        "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
        lambda user: True,
    )


@pytest.fixture
def dispatched(monkeypatch: pytest.MonkeyPatch) -> list[int]:
    """Capture background import task dispatches instead of hitting Celery."""
    import app.tasks.knowledge_tasks as knowledge_tasks_module

    document_ids: list[int] = []
    monkeypatch.setattr(
        knowledge_tasks_module,
        "import_external_document_task",
        SimpleNamespace(delay=lambda **kw: document_ids.append(kw["document_id"])),
    )
    return document_ids


def _create_kb(test_db: Session, user_id: int, name: str = "api-import-kb") -> int:
    return KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name=name),
    )


def _create_synced_node(
    test_db: Session,
    user_id: int,
    dingtalk_node_id: str,
    name: str = "API Doc",
    node_type: str = "doc",
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
        is_active=True,
        last_synced_at=datetime.now(timezone.utc),
    )
    test_db.add(node)
    test_db.commit()
    return node


def _import_payload(node_id: str, folder_id: int = 0) -> dict:
    return {
        "provider": "dingtalk",
        "external_resource_id": node_id,
        "folder_id": folder_id,
    }


def _batch_import_payload(node_ids: list[str], folder_id: int = 0) -> dict:
    return {
        "provider": "dingtalk",
        "external_resource_ids": node_ids,
        "folder_id": folder_id,
    }


class TestImportExternalDocument:
    def test_creates_placeholder_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "a" * 32, name="API Doc")

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["name"] == "API Doc"
        assert data["source_type"] == "external"
        assert data["external_provider"] == "dingtalk"
        assert data["external_resource_id"] == node.dingtalk_node_id
        assert data["index_status"] == "queued"
        assert data["is_active"] is False
        assert data["status"] == "disabled"
        assert dispatched == [data["id"]]

    def test_places_document_in_target_folder(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        folder = KnowledgeFolderService.create_folder(
            test_db,
            kb_id,
            test_user.id,
            KnowledgeFolderCreate(name="Target folder"),
        )
        node = _create_synced_node(test_db, test_user.id, "b" * 32)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id, folder_id=folder.id),
        )

        assert response.status_code == 201
        assert response.json()["folder_id"] == folder.id

    def test_rejects_folder_of_other_knowledge_base(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "api-import-kb-a")
        other_kb_id = _create_kb(test_db, test_user.id, "api-import-kb-b")
        folder = KnowledgeFolderService.create_folder(
            test_db,
            other_kb_id,
            test_user.id,
            KnowledgeFolderCreate(name="Foreign folder"),
        )
        node = _create_synced_node(test_db, test_user.id, "c" * 32)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id, folder_id=folder.id),
        )

        assert response.status_code == 400

    def test_rejects_unconfigured_provider(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        monkeypatch.setattr(
            "app.services.dingtalk_doc_service.DingTalkDocService.is_configured",
            lambda user: False,
        )
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "d" * 32)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )

        assert response.status_code == 400

    def test_rejects_unknown_external_node(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload("e" * 32),
        )

        assert response.status_code == 404

    def test_reimport_of_successful_document_updates_same_record(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "f" * 32, name="Once Doc")

        first = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )
        assert first.status_code == 201
        document_id = first.json()["id"]

        # Simulate the background import completing successfully.
        document = (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        document.index_status = DocumentIndexStatus.SUCCESS
        document.is_active = True
        test_db.commit()

        second = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )

        assert second.status_code == 201
        assert second.json()["id"] == document_id
        assert test_db.query(KnowledgeDocument).count() == 1
        assert dispatched == [document_id, document_id]

    def test_reimport_while_processing_reuses_same_record(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "hh" * 16, name="Busy Doc")

        first = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )
        assert first.status_code == 201

        second = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )

        assert second.status_code == 201
        assert second.json()["id"] == first.json()["id"]
        assert dispatched == [first.json()["id"]]

    def test_rejects_importer_without_manage_permission(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "g" * 32)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(node.dingtalk_node_id),
        )

        assert response.status_code == 403


@pytest.mark.parametrize("batch", [False, True])
@pytest.mark.parametrize(
    "index_status", [DocumentIndexStatus.QUEUED, DocumentIndexStatus.SUCCESS]
)
def test_existing_copy_still_requires_a_valid_target_folder(
    import_client: TestClient,
    test_db: Session,
    test_user: User,
    configured_dingtalk: None,
    dispatched: list[int],
    batch: bool,
    index_status: DocumentIndexStatus,
) -> None:
    kb_id = _create_kb(test_db, test_user.id)
    node = _create_synced_node(test_db, test_user.id, "existing-copy-folder-check")
    created = import_client.post(
        f"/knowledge-bases/{kb_id}/documents/external-import",
        json=_import_payload(node.dingtalk_node_id),
    )
    assert created.status_code == 201
    document = test_db.get(KnowledgeDocument, created.json()["id"])
    document.index_status = index_status
    test_db.commit()

    suffix = "external-import-batch" if batch else "external-import"
    payload = (
        _batch_import_payload([node.dingtalk_node_id], folder_id=999999)
        if batch
        else _import_payload(node.dingtalk_node_id, folder_id=999999)
    )
    response = import_client.post(
        f"/knowledge-bases/{kb_id}/documents/{suffix}", json=payload
    )

    assert response.status_code == 400
    assert dispatched == [document.id]
    test_db.refresh(document)
    assert document.index_status == index_status


class TestImportExternalDocumentBatch:
    @pytest.mark.parametrize("node_id", ["", "x" * 256])
    def test_rejects_invalid_resource_id_items(
        self,
        import_client: TestClient,
        node_id: str,
    ) -> None:
        response = import_client.post(
            "/knowledge-bases/1/documents/external-import-batch",
            json=_batch_import_payload([node_id]),
        )

        assert response.status_code == 422

    def test_creates_one_placeholder_per_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        first = _create_synced_node(test_db, test_user.id, "aa" * 16, name="Batch One")
        second = _create_synced_node(test_db, test_user.id, "bb" * 16, name="Batch Two")

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload(
                [first.dingtalk_node_id, second.dingtalk_node_id]
            ),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["requested_count"] == 2
        assert len(data["created"]) == 2
        assert data["updated"] == []
        assert data["processing"] == []
        imported_ids = {item["id"] for item in data["created"]}
        assert imported_ids == set(dispatched)
        names = {item["name"] for item in data["created"]}
        assert names == {"Batch One", "Batch Two"}
        for item in data["created"]:
            assert item["source_type"] == "external"
            assert item["external_provider"] == "dingtalk"
            assert item["index_status"] == "queued"

    def test_deduplicates_repeated_resource_ids(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "cc" * 16, name="Dup Doc")

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload([node.dingtalk_node_id, node.dingtalk_node_id]),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["requested_count"] == 1
        assert len(data["created"]) == 1
        assert data["updated"] == []
        assert data["processing"] == []
        assert len(dispatched) == 1

    def test_rejects_batch_over_fifty_documents(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node_ids = []
        for index in range(51):
            node = _create_synced_node(
                test_db, test_user.id, f"{index:03d}" + "n" * 29, name=f"Doc {index}"
            )
            node_ids.append(node.dingtalk_node_id)
        test_db.commit()

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload(node_ids),
        )

        assert response.status_code == 400
        assert "50" in response.json()["detail"]
        assert dispatched == []
        documents = test_db.query(KnowledgeDocument).count()
        assert documents == 0

    def test_reports_documents_still_being_processed(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        existing_node = _create_synced_node(
            test_db, test_user.id, "dd" * 16, name="Existing Doc"
        )
        new_node = _create_synced_node(test_db, test_user.id, "ee" * 16, name="New Doc")
        first = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(existing_node.dingtalk_node_id),
        )
        assert first.status_code == 201
        # The placeholder is still QUEUED: the batch reports it as processing
        # instead of queueing a second concurrent import.
        assert len(dispatched) == 1

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload(
                [existing_node.dingtalk_node_id, new_node.dingtalk_node_id]
            ),
        )

        assert response.status_code == 201
        data = response.json()
        assert data["requested_count"] == 2
        assert len(data["created"]) == 1
        assert data["created"][0]["name"] == "New Doc"
        assert data["updated"] == []
        assert [item["id"] for item in data["processing"]] == [first.json()["id"]]
        # Only the new placeholder was dispatched beyond the original import.
        assert len(dispatched) == 2

    def test_updates_settled_documents_in_batch(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        existing_node = _create_synced_node(
            test_db, test_user.id, "ii" * 16, name="Settled Doc"
        )
        new_node = _create_synced_node(test_db, test_user.id, "jj" * 16, name="New Doc")
        first = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import",
            json=_import_payload(existing_node.dingtalk_node_id),
        )
        assert first.status_code == 201
        document_id = first.json()["id"]
        # Simulate the background import completing successfully.
        document = (
            test_db.query(KnowledgeDocument)
            .filter(KnowledgeDocument.id == document_id)
            .first()
        )
        document.index_status = DocumentIndexStatus.SUCCESS
        document.is_active = True
        test_db.commit()

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload(
                [existing_node.dingtalk_node_id, new_node.dingtalk_node_id]
            ),
        )

        assert response.status_code == 201
        data = response.json()
        assert [item["name"] for item in data["created"]] == ["New Doc"]
        assert [item["id"] for item in data["updated"]] == [document_id]
        assert data["processing"] == []
        test_db.refresh(document)
        assert document.index_status == DocumentIndexStatus.QUEUED
        assert document.is_active is False
        assert dispatched.count(document_id) == 2

    def test_places_batch_in_target_folder(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        folder = KnowledgeFolderService.create_folder(
            test_db,
            kb_id,
            test_user.id,
            KnowledgeFolderCreate(name="Batch folder"),
        )
        node = _create_synced_node(test_db, test_user.id, "ff" * 16)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload([node.dingtalk_node_id], folder_id=folder.id),
        )

        assert response.status_code == 201
        assert response.json()["created"][0]["folder_id"] == folder.id

    def test_rejects_folder_of_other_knowledge_base(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "batch-kb-a")
        other_kb_id = _create_kb(test_db, test_user.id, "batch-kb-b")
        folder = KnowledgeFolderService.create_folder(
            test_db,
            other_kb_id,
            test_user.id,
            KnowledgeFolderCreate(name="Foreign batch folder"),
        )
        node = _create_synced_node(test_db, test_user.id, "gg" * 16)

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload([node.dingtalk_node_id], folder_id=folder.id),
        )

        assert response.status_code == 400
        assert dispatched == []

    def test_rejects_batch_importer_without_manage_permission(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        node = _create_synced_node(test_db, test_user.id, "hh" * 16)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload([node.dingtalk_node_id]),
        )

        assert response.status_code == 403

    @pytest.mark.parametrize("unconfigured_sheet", [False, True])
    def test_rejects_invalid_or_unconfigured_node_without_partial_import(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        configured_dingtalk: None,
        dispatched: list[int],
        unconfigured_sheet: bool,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        doc_node = _create_synced_node(
            test_db, test_user.id, "ii" * 16, name="Good Doc"
        )
        file_node = _create_synced_node(
            test_db, test_user.id, "jj" * 16, name="Bin File", node_type="file"
        )
        if unconfigured_sheet:
            file_node.content_type = "ALIDOC"
            file_node.raw_metadata = {"extension": "axls"}
            test_db.commit()

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-batch",
            json=_batch_import_payload(
                [doc_node.dingtalk_node_id, file_node.dingtalk_node_id]
            ),
        )

        assert response.status_code == 400
        if unconfigured_sheet:
            assert "DingTalk Table MCP is not configured" in response.json()["detail"]
        assert dispatched == []
        documents = test_db.query(KnowledgeDocument).count()
        assert documents == 0


def _create_failed_external_document(
    test_db: Session,
    user_id: int,
    knowledge_base_id: int,
    *,
    index_status: str = "failed",
    external: bool = True,
) -> KnowledgeDocument:
    from datetime import datetime, timezone

    document = KnowledgeDocument(
        kind_id=knowledge_base_id,
        attachment_id=0,
        name="Failed Import",
        file_extension="md",
        file_size=0,
        user_id=user_id,
        source_type="external" if external else "file",
        external_source=(
            KnowledgeDocumentExternalSource(
                kind_id=knowledge_base_id,
                external_provider="dingtalk",
                external_resource_id="z" * 32,
            )
            if external
            else None
        ),
        index_status=index_status,
        index_generation=0,
    )
    document.set_processing_error_payload(
        {
            "stage": "system",
            "code": "external_import_failed",
            "message": "The external document could not be imported. Please retry later.",
            "retryable": True,
            "generation": 0,
            "occurred_at": datetime.now(timezone.utc).isoformat(),
        }
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)
    return document


class TestExternalImportStatus:
    def test_reads_import_status_across_folders_but_only_in_current_kb(
        self, import_client: TestClient, test_db: Session, test_user: User
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id, "status-kb")
        other_id = _create_kb(test_db, test_user.id, "other-status-kb")
        folder = KnowledgeFolderService.create_folder(
            test_db, kb_id, test_user.id, KnowledgeFolderCreate(name="Nested")
        )
        current = _create_failed_external_document(
            test_db, test_user.id, kb_id, index_status="success"
        )
        current.folder_id = folder.id
        test_db.commit()
        _create_failed_external_document(
            test_db, test_user.id, other_id, index_status="failed"
        )

        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-status",
            json={"provider": "dingtalk", "external_resource_ids": ["z" * 32, "new"]},
        )

        assert response.status_code == 200, response.text
        assert response.json() == {"z" * 32: "success"}

    @pytest.mark.parametrize(
        "index_status", ["failed", "queued", "indexing", "not_indexed"]
    )
    def test_reports_existing_copy_state_without_starting_an_import(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
        index_status: str,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        _create_failed_external_document(
            test_db, test_user.id, kb_id, index_status=index_status
        )
        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-status",
            json={"provider": "dingtalk", "external_resource_ids": ["z" * 32]},
        )
        assert response.status_code == 200
        assert response.json() == {"z" * 32: index_status}
        assert dispatched == []

    def test_does_not_confuse_other_providers_or_unrequested_documents(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(test_db, test_user.id, kb_id)
        document.external_source.external_provider = "other-provider"
        test_db.commit()
        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-status",
            json={"provider": "dingtalk", "external_resource_ids": ["z" * 32]},
        )
        assert response.status_code == 200
        assert response.json() == {}

    def test_rejects_a_foreign_knowledge_base(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        other_user = User(user_name="status-outsider", password_hash="unused")
        test_db.add(other_user)
        test_db.commit()
        kb_id = _create_kb(test_db, other_user.id)
        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-status",
            json={"provider": "dingtalk", "external_resource_ids": ["z" * 32]},
        )
        assert response.status_code == 404

    def test_rejects_users_without_import_permission(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )
        response = import_client.post(
            f"/knowledge-bases/{kb_id}/documents/external-import-status",
            json={"provider": "dingtalk", "external_resource_ids": ["z" * 32]},
        )
        assert response.status_code == 403

    def test_bounds_status_lookup_requests(self, import_client: TestClient) -> None:
        response = import_client.post(
            "/knowledge-bases/1/documents/external-import-status",
            json={
                "provider": "dingtalk",
                "external_resource_ids": [str(i) for i in range(501)],
            },
        )
        assert response.status_code == 422


class TestRetryExternalDocumentImport:
    def test_requeues_failed_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(test_db, test_user.id, kb_id)

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 200
        data = response.json()
        assert data["id"] == document.id
        assert data["index_status"] == "queued"
        assert data["processing_error"] is None
        assert dispatched == [document.id]
        # Retry reuses the same record; no copy is created.
        assert test_db.query(KnowledgeDocument).count() == 1

    def test_requeues_failed_document_after_previous_success(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(test_db, test_user.id, kb_id)
        document.attachment_id = 123
        document.is_active = True
        test_db.commit()

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 200
        assert response.json()["index_status"] == "queued"
        assert response.json()["attachment_id"] == 123
        assert dispatched == [document.id]

    def test_returns_404_for_missing_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        response = import_client.post(
            "/knowledge-documents/999999/external-import/retry"
        )

        assert response.status_code == 404

    def test_returns_409_while_import_in_progress(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(
            test_db, test_user.id, kb_id, index_status="queued"
        )

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 409
        assert dispatched == []

    def test_returns_409_for_already_imported_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        dispatched: list[int],
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(
            test_db, test_user.id, kb_id, index_status="success"
        )

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 409
        assert dispatched == []

    def test_returns_400_for_non_external_document(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(
            test_db, test_user.id, kb_id, external=False
        )

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 400

    def test_returns_403_without_manage_permission(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(test_db, test_user.id, kb_id)
        monkeypatch.setattr(
            KnowledgeService,
            "can_manage_knowledge_base_documents",
            staticmethod(lambda db, kb_id, user_id: False),
        )

        response = import_client.post(
            f"/knowledge-documents/{document.id}/external-import/retry"
        )

        assert response.status_code == 403


class TestExternalImportFailureVisibility:
    def test_list_exposes_structured_failure_reason(
        self,
        import_client: TestClient,
        test_db: Session,
        test_user: User,
    ) -> None:
        kb_id = _create_kb(test_db, test_user.id)
        document = _create_failed_external_document(test_db, test_user.id, kb_id)

        response = import_client.get(f"/knowledge-bases/{kb_id}/documents")

        assert response.status_code == 200
        items = response.json()["items"]
        matching = [item for item in items if item["id"] == document.id]
        assert len(matching) == 1
        error = matching[0]["processing_error"]
        assert error is not None
        assert error["code"] == "external_import_failed"
        assert error["retryable"] is True
        assert error["stage"] == "system"
