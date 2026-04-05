# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from knowledge_runtime.main import create_app
from knowledge_runtime.services.content_fetcher import fetch_content
from shared.models.knowledge_runtime_protocol import (
    BackendAttachmentStreamContentRef,
    PresignedUrlContentRef,
)


def _auth_headers() -> dict[str, str]:
    return {"Authorization": "Bearer knowledge-runtime-token"}


@pytest.mark.asyncio
async def test_fetch_content_uses_backend_stream_auth_header(mocker) -> None:
    response = Mock()
    response.content = b"release plan"
    response.raise_for_status = Mock()
    get_mock = mocker.patch("httpx.AsyncClient.get", return_value=response)

    content = await fetch_content(
        BackendAttachmentStreamContentRef(
            kind="backend_attachment_stream",
            url="http://backend/api/internal/rag/content/12",
            auth_token="download-token",
        )
    )

    assert content == b"release plan"
    get_mock.assert_awaited_once_with(
        "http://backend/api/internal/rag/content/12",
        headers={"Authorization": "Bearer download-token"},
    )


@pytest.mark.asyncio
async def test_fetch_content_uses_presigned_url_without_auth_header(mocker) -> None:
    response = Mock()
    response.content = b"knowledge file"
    response.raise_for_status = Mock()
    get_mock = mocker.patch("httpx.AsyncClient.get", return_value=response)

    content = await fetch_content(
        PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/object",
        )
    )

    assert content == b"knowledge file"
    get_mock.assert_awaited_once_with(
        "https://storage.example.com/object",
        headers={},
    )


def test_index_route_fetches_content_and_returns_execution_metadata(mocker) -> None:
    client = TestClient(create_app())
    fetch_mock = mocker.patch(
        "knowledge_runtime.services.handlers.content_fetcher.fetch_content",
        return_value=b"indexed text",
    )

    response = client.post(
        "/internal/rag/index",
        headers=_auth_headers(),
        json={
            "knowledge_base_id": 101,
            "document_id": 202,
            "index_owner_user_id": 303,
            "retriever_config": {"name": "default-retriever"},
            "embedding_model_config": {"model_name": "text-embedding-3-small"},
            "content_ref": {
                "kind": "presigned_url",
                "url": "https://storage.example.com/release-notes.md",
            },
            "index_families": ["chunk_vector", "summary_vector_index"],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "accepted",
        "knowledge_id": "101",
        "document_id": 202,
        "content_bytes": len(b"indexed text"),
        "content_ref_kind": "presigned_url",
        "index_families": ["chunk_vector", "summary_vector_index"],
    }
    fetch_mock.assert_awaited_once()


def test_delete_route_returns_enabled_index_families() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/internal/rag/delete-document-index",
        headers=_auth_headers(),
        json={
            "knowledge_base_id": 101,
            "document_ref": "202",
            "retriever_config": {
                "name": "default-retriever",
                "namespace": "default",
                "storage_config": {"type": "qdrant"},
            },
            "enabled_index_families": [
                "chunk_vector",
                "summary_vector_index",
            ],
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "status": "accepted",
        "knowledge_id": "101",
        "doc_ref": "202",
        "enabled_index_families": [
            "chunk_vector",
            "summary_vector_index",
        ],
    }


def test_query_route_rejects_invalid_auth_token() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/internal/rag/query",
        headers={"Authorization": "Bearer invalid-token"},
        json={"knowledge_base_ids": [1], "query": "release checklist"},
    )

    assert response.status_code == 401


def test_index_route_validates_content_ref_shape() -> None:
    client = TestClient(create_app())

    response = client.post(
        "/internal/rag/index",
        headers=_auth_headers(),
        json={
            "knowledge_base_id": 101,
            "index_owner_user_id": 303,
            "retriever_config": {"name": "default-retriever"},
            "embedding_model_config": {"model_name": "text-embedding-3-small"},
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend/api/internal/rag/content/12",
            },
        },
    )

    assert response.status_code == 422
