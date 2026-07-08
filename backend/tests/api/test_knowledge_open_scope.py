# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.schemas.knowledge import (
    BatchOperationResult,
    DocumentSourceType,
    KnowledgeBaseCreate,
    KnowledgeDocumentCreate,
    KnowledgeFolderCreate,
)
from app.services.knowledge.folder_service import KnowledgeFolderService
from app.services.knowledge.knowledge_service import KnowledgeService


def _api_key_headers(raw_key: str) -> dict[str, str]:
    return {"X-API-Key": raw_key}


def _create_kb(test_db: Session, user_id: int, name: str = "open-scope-kb") -> int:
    return KnowledgeService.create_knowledge_base(
        test_db,
        user_id,
        KnowledgeBaseCreate(name=name),
    )


def _create_folder(
    test_db: Session,
    kb_id: int,
    user_id: int,
    name: str,
    parent_id: int = 0,
):
    return KnowledgeFolderService.create_folder(
        test_db,
        kb_id,
        user_id,
        KnowledgeFolderCreate(name=name, parent_id=parent_id),
    )


def _create_document(
    test_db: Session,
    kb_id: int,
    user_id: int,
    name: str,
    folder_id: int = 0,
):
    return KnowledgeService.create_document(
        test_db,
        kb_id,
        user_id,
        KnowledgeDocumentCreate(
            name=name,
            file_extension="md",
            file_size=100,
            source_type=DocumentSourceType.TEXT,
            folder_id=folder_id,
        ),
    )


def test_open_search_folder_ids_zero_resolves_root_documents_only(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id)
    folder = _create_folder(test_db, kb_id, test_user.id, "folder")
    root_doc = _create_document(test_db, kb_id, test_user.id, "root.md", folder_id=0)
    _create_document(test_db, kb_id, test_user.id, "nested.md", folder_id=folder.id)
    captured: dict = {}

    async def fake_retrieve_knowledge(**kwargs):
        captured.update(kwargs)
        return {"records": [{"content": "root", "score": 0.9, "title": "root.md"}]}

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.retrieve_knowledge",
        fake_retrieve_knowledge,
    )

    response = test_client.post(
        "/api/knowledge/search",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "knowledge_base_id": kb_id,
            "query": "root",
            "folder_ids": [0],
            "include_subfolders": True,
        },
    )

    assert response.status_code == 200
    assert response.json()["records"][0]["title"] == "root.md"
    assert captured["document_ids"] == [root_doc.id]


def test_open_search_empty_folder_scope_does_not_call_rag(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-empty-folder-kb")
    empty_folder = _create_folder(test_db, kb_id, test_user.id, "empty")

    async def fail_retrieve_knowledge(**kwargs):
        raise AssertionError("RAG retrieval should not run for an empty scope")

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.retrieve_knowledge",
        fail_retrieve_knowledge,
    )

    response = test_client.post(
        "/api/knowledge/search",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "knowledge_base_id": kb_id,
            "query": "anything",
            "folder_ids": [empty_folder.id],
        },
    )

    assert response.status_code == 200
    assert response.json() == {"records": []}


def test_open_search_rejects_empty_folder_ids(
    test_client: TestClient,
    test_api_key,
) -> None:
    response = test_client.post(
        "/api/knowledge/search",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "knowledge_base_id": 1,
            "query": "anything",
            "folder_ids": [],
        },
    )

    assert response.status_code == 422


def test_open_folder_create_move_and_list_documents(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-folder-crud-kb")
    document = _create_document(test_db, kb_id, test_user.id, "move-me.md")

    create_response = test_client.post(
        "/api/knowledge/folders",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "knowledge_base_id": kb_id,
            "name": "API Folder",
            "parent_id": 0,
        },
    )

    assert create_response.status_code == 201
    folder_id = create_response.json()["id"]

    move_response = test_client.put(
        f"/api/knowledge/documents/{document.id}/move",
        headers=_api_key_headers(test_api_key[0]),
        json={"folder_id": folder_id},
    )

    assert move_response.status_code == 200
    assert move_response.json()["folder_id"] == folder_id

    folder_docs_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id, "folder_id": folder_id},
    )
    root_docs_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id, "folder_id": 0},
    )
    tree_response = test_client.get(
        "/api/knowledge/folders",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id},
    )

    assert folder_docs_response.status_code == 200
    folder_doc_ids = {item["id"] for item in folder_docs_response.json()["items"]}
    assert folder_doc_ids == {document.id}
    assert root_docs_response.status_code == 200
    assert root_docs_response.json()["items"] == []
    assert tree_response.status_code == 200
    tree_folder_ids = {item["id"] for item in tree_response.json()}
    assert folder_id in tree_folder_ids


def test_open_list_documents_supports_subfolders_keyword_sort_and_folder_counts(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-folder-query-kb")
    parent = _create_folder(test_db, kb_id, test_user.id, "parent")
    child = _create_folder(test_db, kb_id, test_user.id, "child", parent_id=parent.id)
    parent_doc = _create_document(
        test_db, kb_id, test_user.id, "Alpha parent.md", folder_id=parent.id
    )
    child_doc = _create_document(
        test_db, kb_id, test_user.id, "Beta child.md", folder_id=child.id
    )
    _create_document(test_db, kb_id, test_user.id, "Gamma root.md", folder_id=0)

    direct_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id, "folder_id": parent.id},
    )
    subtree_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={
            "knowledge_base_id": kb_id,
            "folder_id": parent.id,
            "include_subfolders": True,
            "sort_by": "name",
            "sort_order": "asc",
        },
    )
    keyword_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={
            "knowledge_base_id": kb_id,
            "folder_id": parent.id,
            "include_subfolders": True,
            "keyword": "child",
        },
    )
    tree_response = test_client.get(
        "/api/knowledge/folders",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id},
    )

    assert direct_response.status_code == 200
    assert [item["id"] for item in direct_response.json()["items"]] == [parent_doc.id]

    assert subtree_response.status_code == 200
    assert [item["id"] for item in subtree_response.json()["items"]] == [
        parent_doc.id,
        child_doc.id,
    ]

    assert keyword_response.status_code == 200
    assert [item["id"] for item in keyword_response.json()["items"]] == [child_doc.id]

    assert tree_response.status_code == 200
    parent_node = next(item for item in tree_response.json() if item["id"] == parent.id)
    assert parent_node["document_count"] == 1
    assert parent_node["direct_document_count"] == 1
    assert parent_node["total_document_count"] == 2
    child_node = parent_node["children"][0]
    assert child_node["direct_document_count"] == 1
    assert child_node["total_document_count"] == 1


def test_rest_list_documents_rejects_folder_from_other_knowledge_base(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_token: str,
) -> None:
    source_kb_id = _create_kb(test_db, test_user.id, "rest-source-kb")
    other_kb_id = _create_kb(test_db, test_user.id, "rest-other-kb")
    other_folder = _create_folder(test_db, other_kb_id, test_user.id, "other-folder")

    response = test_client.get(
        f"/api/knowledge-bases/{source_kb_id}/documents",
        headers={"Authorization": f"Bearer {test_token}"},
        params={"folder_id": other_folder.id},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Folder not found in this knowledge base"


def test_open_delete_document_removes_document_and_schedules_summary_update(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-delete-kb")
    document = _create_document(test_db, kb_id, test_user.id, "delete-me.md")
    scheduled: dict = {}

    def fake_schedule_summary_update(background_tasks, **kwargs):
        scheduled.update(kwargs)

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.schedule_kb_summary_updates_after_deletion",
        fake_schedule_summary_update,
    )

    response = test_client.delete(
        f"/api/knowledge/documents/{document.id}",
        headers=_api_key_headers(test_api_key[0]),
    )

    assert response.status_code == 204
    assert KnowledgeService.get_document(test_db, document.id, test_user.id) is None
    assert scheduled["kb_ids"] == [kb_id]
    assert scheduled["user_id"] == test_user.id


def test_open_delete_document_returns_404_for_missing_document(
    test_client: TestClient,
    test_api_key,
) -> None:
    response = test_client.delete(
        "/api/knowledge/documents/999999",
        headers=_api_key_headers(test_api_key[0]),
    )

    assert response.status_code == 404


def test_open_reindex_document_uses_orchestrator(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-reindex-kb")
    document = _create_document(test_db, kb_id, test_user.id, "reindex-me.md")
    captured: dict = {}

    def fake_reindex_document(**kwargs):
        captured.update(kwargs)
        return {"message": "Reindexing started", "document_id": document.id}

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.reindex_document",
        fake_reindex_document,
    )

    response = test_client.post(
        f"/api/knowledge/documents/{document.id}/reindex",
        headers=_api_key_headers(test_api_key[0]),
    )

    assert response.status_code == 200
    assert response.json()["document_id"] == document.id
    assert captured["document_id"] == document.id
    assert captured["user"].id == test_user.id
    assert captured["trigger_summary"] is False


def test_open_reindex_document_returns_403_for_permission_error(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-reindex-permission-kb")
    document = _create_document(test_db, kb_id, test_user.id, "reindex-denied.md")

    def fake_reindex_document(**kwargs):
        raise ValueError(
            "You do not have permission to manage this document in this knowledge base"
        )

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.knowledge_orchestrator.reindex_document",
        fake_reindex_document,
    )

    response = test_client.post(
        f"/api/knowledge/documents/{document.id}/reindex",
        headers=_api_key_headers(test_api_key[0]),
    )

    assert response.status_code == 403
    assert "permission" in response.json()["detail"]


def test_open_batch_delete_documents_allows_partial_success(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
    monkeypatch,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-batch-delete-kb")
    document = _create_document(test_db, kb_id, test_user.id, "batch-delete.md")
    missing_document_id = 999999
    scheduled: dict = {}

    def fake_schedule_summary_update(background_tasks, **kwargs):
        scheduled.update(kwargs)

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.schedule_kb_summary_updates_after_deletion",
        fake_schedule_summary_update,
    )

    response = test_client.post(
        "/api/knowledge/documents/batch/delete",
        headers=_api_key_headers(test_api_key[0]),
        json={"document_ids": [document.id, missing_document_id]},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["success_count"] == 1
    assert payload["failed_count"] == 1
    assert payload["failed_ids"] == [missing_document_id]
    assert KnowledgeService.get_document(test_db, document.id, test_user.id) is None
    assert scheduled["kb_ids"] == [kb_id]


def test_open_batch_delete_documents_returns_403_when_all_fail(
    test_client: TestClient,
    test_api_key,
    monkeypatch,
) -> None:
    def fake_schedule_summary_update(background_tasks, **kwargs):
        raise AssertionError("Summary update should not be scheduled")

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.schedule_kb_summary_updates_after_deletion",
        fake_schedule_summary_update,
    )

    def fake_batch_delete_documents(**kwargs):
        return SimpleNamespace(
            result=BatchOperationResult(
                success_count=0,
                failed_count=2,
                failed_ids=[999998, 999999],
                message="Only Owner or Maintainer can delete documents from this knowledge base",
            ),
            kb_ids=[],
        )

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.KnowledgeService.batch_delete_documents",
        fake_batch_delete_documents,
    )

    response = test_client.post(
        "/api/knowledge/documents/batch/delete",
        headers=_api_key_headers(test_api_key[0]),
        json={"document_ids": [999998, 999999]},
    )

    assert response.status_code == 403


def test_open_batch_delete_documents_returns_404_when_all_missing(
    test_client: TestClient,
    test_api_key,
    monkeypatch,
) -> None:
    def fake_schedule_summary_update(background_tasks, **kwargs):
        raise AssertionError("Summary update should not be scheduled")

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.schedule_kb_summary_updates_after_deletion",
        fake_schedule_summary_update,
    )

    response = test_client.post(
        "/api/knowledge/documents/batch/delete",
        headers=_api_key_headers(test_api_key[0]),
        json={"document_ids": [999998, 999999]},
    )

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found"


def test_open_batch_move_documents_moves_documents_to_folder(
    test_client: TestClient,
    test_db: Session,
    test_user,
    test_api_key,
) -> None:
    kb_id = _create_kb(test_db, test_user.id, "open-batch-move-kb")
    folder = _create_folder(test_db, kb_id, test_user.id, "target")
    first_doc = _create_document(test_db, kb_id, test_user.id, "first.md")
    second_doc = _create_document(test_db, kb_id, test_user.id, "second.md")

    response = test_client.post(
        "/api/knowledge/documents/batch/move",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "document_ids": [first_doc.id, second_doc.id],
            "folder_id": folder.id,
        },
    )

    assert response.status_code == 200
    assert response.json()["success_count"] == 2

    folder_docs_response = test_client.get(
        "/api/knowledge/documents",
        headers=_api_key_headers(test_api_key[0]),
        params={"knowledge_base_id": kb_id, "folder_id": folder.id},
    )
    folder_doc_ids = {item["id"] for item in folder_docs_response.json()["items"]}
    assert folder_doc_ids == {first_doc.id, second_doc.id}


@pytest.mark.parametrize(
    ("message", "expected_status"),
    [
        ("Document not found", 404),
        ("You do not have permission to move these documents", 403),
        ("Invalid folder_id", 400),
    ],
)
def test_open_batch_move_documents_maps_zero_success_errors(
    test_client: TestClient,
    test_api_key,
    monkeypatch,
    message: str,
    expected_status: int,
) -> None:
    def fake_batch_move_documents(**kwargs):
        return BatchOperationResult(
            success_count=0,
            failed_count=1,
            failed_ids=[999999],
            message=message,
        )

    monkeypatch.setattr(
        "app.api.endpoints.knowledge_open.KnowledgeFolderService.batch_move_documents",
        fake_batch_move_documents,
    )

    response = test_client.post(
        "/api/knowledge/documents/batch/move",
        headers=_api_key_headers(test_api_key[0]),
        json={
            "document_ids": [999999],
            "folder_id": 0,
        },
    )

    assert response.status_code == expected_status
    assert response.json()["detail"] == message
