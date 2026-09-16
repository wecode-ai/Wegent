# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import Request

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError
from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
    StorageUnavailableError,
    UnsupportedStorageCapabilityError,
)
from knowledge_runtime.main import (
    embedding_dimension_mismatch_handler,
    storage_error_handler,
)


def _request(path: str = "/internal/rag/query") -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": [],
            "query_string": b"",
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


@pytest.mark.asyncio
async def test_embedding_dimension_mismatch_returns_stable_nonretryable_error() -> None:
    request = _request("/internal/rag/index")
    error = EmbeddingDimensionMismatchError(
        model="Qwen/Qwen3-Embedding-8B",
        expected=1024,
        actual=4096,
    )

    response = await embedding_dimension_mismatch_handler(request, error)

    assert response.status_code == 422
    assert json.loads(response.body) == {
        "code": "embedding_dimension_mismatch",
        "message": (
            "Embedding model 'Qwen/Qwen3-Embedding-8B' returned 4096 "
            "dimensions; expected 1024."
        ),
        "retryable": False,
        "details": {
            "model": "Qwen/Qwen3-Embedding-8B",
            "expected_dimensions": 1024,
            "actual_dimensions": 4096,
        },
    }


@pytest.mark.asyncio
async def test_index_contract_failure_keeps_its_code_and_is_not_retryable() -> None:
    """A contract mismatch must not collapse into internal_error."""
    error = IndexContractIncompatibleError(
        "wegent_kb_1",
        "analyzer mismatch",
        details={"bound": "chinese", "requested": ""},
    )

    response = await storage_error_handler(_request("/internal/rag/index"), error)
    body = json.loads(response.body)

    assert response.status_code == 409
    assert body["code"] == "index_contract_incompatible"
    assert body["retryable"] is False
    assert body["details"]["collection_name"] == "wegent_kb_1"
    assert "Milvus index 'wegent_kb_1' is not compatible" in body["message"]


@pytest.mark.asyncio
async def test_missing_index_keeps_its_code() -> None:
    error = IndexMissingError("wegent_kb_1", "the bound collection is gone")

    response = await storage_error_handler(_request("/internal/rag/query"), error)
    body = json.loads(response.body)

    assert response.status_code == 409
    assert body["code"] == "index_missing"
    assert body["retryable"] is False


@pytest.mark.asyncio
async def test_unsupported_capability_keeps_its_code() -> None:
    error = UnsupportedStorageCapabilityError("hybrid", backend="milvus")

    response = await storage_error_handler(_request("/internal/rag/query"), error)
    body = json.loads(response.body)

    assert response.status_code == 409
    assert body["code"] == "storage_capability_unsupported"
    assert body["retryable"] is False
    assert body["details"] == {"capability": "hybrid", "backend": "milvus"}


@pytest.mark.asyncio
async def test_a_transient_service_failure_is_reported_as_retryable() -> None:
    error = StorageUnavailableError(
        "milvus",
        details={"sdk_code": "14", "sdk_error": "ConnectError"},
    )

    response = await storage_error_handler(_request("/internal/rag/query"), error)
    body = json.loads(response.body)

    assert response.status_code == 503
    assert body["code"] == "storage_unavailable"
    assert body["retryable"] is True
    assert "cancelled" in body["message"]


@pytest.mark.asyncio
async def test_a_generic_storage_failure_keeps_its_class_code() -> None:
    error = StorageBackendError("Milvus row count exceeded the verification budget")

    response = await storage_error_handler(_request("/internal/rag/query"), error)
    body = json.loads(response.body)

    assert response.status_code == 500
    assert body["code"] == "storage_backend_error"
    assert body["retryable"] is False
    assert body["details"] == {}


@pytest.mark.asyncio
async def test_http_query_returns_the_storage_code_not_internal_error(
    monkeypatch,
) -> None:
    """The wired app returns the storage code to the Backend caller."""
    from fastapi.testclient import TestClient

    from knowledge_runtime import config
    from knowledge_runtime.api.endpoints import query as query_endpoint
    from knowledge_runtime.main import app
    from knowledge_runtime.middleware import auth

    monkeypatch.setenv("INTERNAL_SERVICE_TOKEN", "test-token")
    monkeypatch.setenv("DATABASE_URL", "")
    original_settings = config._settings
    config._settings = None

    async def _fail(self, request):
        raise StorageUnavailableError(
            "milvus",
            details={"sdk_code": "14", "sdk_error": "ConnectError"},
        )

    monkeypatch.setattr(
        query_endpoint.QueryExecutor,
        "execute",
        _fail,
    )
    app.dependency_overrides[auth.verify_internal_token] = lambda: None
    try:
        with TestClient(app) as client:
            response = client.post(
                "/internal/rag/query",
                json={"knowledge_base_ids": [1], "user_id": 1, "query": "q"},
                headers={"Authorization": "Bearer test-token"},
            )
    finally:
        app.dependency_overrides.pop(auth.verify_internal_token, None)
        config._settings = original_settings

    body = response.json()
    assert response.status_code == 503
    assert body["code"] == "storage_unavailable"
    assert body["retryable"] is True
    assert "internal_error" not in body["code"]
