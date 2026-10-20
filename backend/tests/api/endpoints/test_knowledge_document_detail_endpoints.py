# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient


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
