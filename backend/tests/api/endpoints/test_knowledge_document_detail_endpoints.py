# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from app.models.knowledge import KnowledgeDocument


def _auth_header(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def test_standalone_detail_uses_orchestrator(
    test_client: TestClient,
    test_token: str,
):
    payload = {
        "document_id": 9,
        "content": "abcd",
        "content_length": 10,
        "truncated": True,
        "summary": {"summary": "hello"},
    }

    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        return_value=payload,
    ) as mock_detail:
        response = test_client.get(
            "/api/knowledge-documents/9/detail",
            params={
                "include_content": "true",
                "include_summary": "false",
            },
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "document_id": 9,
        "content": "abcd",
        "content_length": 10,
        "truncated": True,
    }
    mock_detail.assert_awaited_once()
    assert mock_detail.await_args.kwargs["document_id"] == 9
    assert mock_detail.await_args.kwargs["include_content"] is True
    assert mock_detail.await_args.kwargs["include_summary"] is False
    assert mock_detail.await_args.kwargs["offset"] == 0
    assert mock_detail.await_args.kwargs["limit"] == 100000


def test_kb_scoped_detail_uses_orchestrator(
    test_client: TestClient,
    test_db,
    test_token: str,
    test_user,
):
    payload = {
        "document_id": 9,
        "content": "abcd",
        "content_length": 10,
        "truncated": False,
        "summary": {"summary": "hello"},
    }
    document = KnowledgeDocument(
        id=9,
        kind_id=77,
        attachment_id=0,
        name="kb-doc",
        file_extension=".txt",
        file_size=0,
        user_id=test_user.id,
    )
    test_db.add(document)
    test_db.commit()

    with (
        patch(
            "app.api.endpoints.knowledge.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
        patch(
            "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
            new_callable=AsyncMock,
            return_value=payload,
        ) as mock_detail,
    ):
        response = test_client.get(
            "/api/knowledge-bases/77/documents/9/detail",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == payload
    mock_detail.assert_awaited_once()
    assert mock_detail.await_args.kwargs["document_id"] == 9
    assert mock_detail.await_args.kwargs["include_content"] is True
    assert mock_detail.await_args.kwargs["include_summary"] is True
    assert mock_detail.await_args.kwargs["offset"] == 0
    assert mock_detail.await_args.kwargs["limit"] == 100000


def test_standalone_detail_maps_not_found_error_to_404(
    test_client: TestClient,
    test_token: str,
):
    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        side_effect=ValueError("Document not found"),
    ):
        response = test_client.get(
            "/api/knowledge-documents/404/detail",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Document not found"


def test_standalone_detail_omits_unrequested_fields(
    test_client: TestClient,
    test_token: str,
):
    payload = {
        "document_id": 9,
        "content": None,
        "content_length": None,
        "truncated": None,
        "summary": {"summary": "hello"},
    }

    with patch(
        "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
        new_callable=AsyncMock,
        return_value=payload,
    ) as mock_detail:
        response = test_client.get(
            "/api/knowledge-documents/9/detail",
            params={"include_content": "false", "include_summary": "true"},
            headers=_auth_header(test_token),
        )

    assert response.status_code == 200
    assert response.json() == {
        "document_id": 9,
        "summary": {"summary": "hello"},
    }
    mock_detail.assert_awaited_once()
    assert mock_detail.await_args.kwargs["document_id"] == 9
    assert mock_detail.await_args.kwargs["include_content"] is False
    assert mock_detail.await_args.kwargs["include_summary"] is True
    assert mock_detail.await_args.kwargs["offset"] == 0
    assert mock_detail.await_args.kwargs["limit"] == 100000


def test_kb_scoped_detail_rejects_document_outside_requested_kb(
    test_client: TestClient,
    test_db,
    test_token: str,
    test_user,
):
    document = KnowledgeDocument(
        kind_id=88,
        attachment_id=0,
        name="other-kb-doc",
        file_extension=".txt",
        file_size=0,
        user_id=test_user.id,
    )
    test_db.add(document)
    test_db.commit()
    test_db.refresh(document)

    with (
        patch(
            "app.api.endpoints.knowledge.KnowledgeService.get_knowledge_base",
            return_value=(object(), True),
        ),
        patch(
            "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
            new_callable=AsyncMock,
        ) as mock_detail,
    ):
        response = test_client.get(
            f"/api/knowledge-bases/77/documents/{document.id}/detail",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 404
    assert (
        response.json()["detail"]
        == "Document not found in the specified knowledge base"
    )
    mock_detail.assert_not_awaited()


def test_kb_scoped_detail_maps_missing_kb_before_document_lookup(
    test_client: TestClient,
    test_token: str,
):
    with (
        patch(
            "app.api.endpoints.knowledge.KnowledgeService.get_knowledge_base",
            return_value=(None, False),
        ),
        patch(
            "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
            new_callable=AsyncMock,
        ) as mock_detail,
    ):
        response = test_client.get(
            "/api/knowledge-bases/77/documents/9/detail",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 404
    assert response.json()["detail"] == "Knowledge base not found"
    mock_detail.assert_not_awaited()


def test_kb_scoped_detail_maps_kb_access_denied_before_document_lookup(
    test_client: TestClient,
    test_token: str,
):
    with (
        patch(
            "app.api.endpoints.knowledge.KnowledgeService.get_knowledge_base",
            return_value=(object(), False),
        ),
        patch(
            "app.api.endpoints.knowledge.knowledge_orchestrator.get_document_detail",
            new_callable=AsyncMock,
        ) as mock_detail,
    ):
        response = test_client.get(
            "/api/knowledge-bases/77/documents/9/detail",
            headers=_auth_header(test_token),
        )

    assert response.status_code == 403
    assert response.json()["detail"] == "Access denied to this knowledge base"
    mock_detail.assert_not_awaited()
