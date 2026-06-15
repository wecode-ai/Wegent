# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session

from app.schemas.knowledge import (
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
