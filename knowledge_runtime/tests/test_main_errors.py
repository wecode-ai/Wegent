# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import Request

from knowledge_engine.embedding.errors import (
    CollectionDimensionMismatchError,
    EmbeddingDimensionMismatchError,
)
from knowledge_engine.storage.milvus_batching import MilvusRowTooLargeError
from knowledge_runtime.main import (
    embedding_dimension_mismatch_handler,
    value_error_handler,
)
from knowledge_runtime.services.config_resolver import ConfigResolutionError


def _index_request() -> Request:
    return Request(
        {
            "type": "http",
            "method": "POST",
            "path": "/internal/rag/index",
            "headers": [],
            "query_string": b"",
            "server": ("testserver", 80),
            "scheme": "http",
        }
    )


@pytest.mark.parametrize(
    ("error", "expected_code", "expected_message"),
    [
        (
            EmbeddingDimensionMismatchError(
                model="Qwen/Qwen3-Embedding-8B",
                expected=1024,
                actual=4096,
            ),
            "embedding_dimension_mismatch",
            "Embedding model 'Qwen/Qwen3-Embedding-8B' returned 4096 "
            "dimensions; expected 1024.",
        ),
        (
            CollectionDimensionMismatchError(
                model="Qwen/Qwen3-Embedding-8B",
                expected=1024,
                actual=4096,
            ),
            "collection_dimension_mismatch",
            "Embedding model 'Qwen/Qwen3-Embedding-8B' declares 1024 dimensions, "
            "but the existing collection stores 4096 dimensions; rebuild the "
            "index to match.",
        ),
    ],
)
@pytest.mark.asyncio
async def test_embedding_dimension_mismatch_returns_stable_nonretryable_error(
    error: EmbeddingDimensionMismatchError,
    expected_code: str,
    expected_message: str,
) -> None:
    response = await embedding_dimension_mismatch_handler(_index_request(), error)
    payload = json.loads(response.body)

    assert response.status_code == 422
    assert payload == {
        "code": expected_code,
        "message": expected_message,
        "retryable": False,
        "details": {
            "model": "Qwen/Qwen3-Embedding-8B",
            "expected_dimensions": 1024,
            "actual_dimensions": 4096,
        },
    }
    for leaked in ("milvus", "localhost", "http", "0.5"):
        assert leaked not in json.dumps(payload).lower()


@pytest.mark.asyncio
async def test_value_error_handler_maps_request_errors_to_invalid_request() -> None:
    """A rejected query request returns a stable non-retryable 400 payload."""
    request = _index_request()
    error = ValueError("query requires authorized retrieval resources for bases [7]")

    response = await value_error_handler(request, error)
    payload = json.loads(response.body)

    assert response.status_code == 400
    assert payload == {
        "code": "invalid_request",
        "message": "query requires authorized retrieval resources for bases [7]",
        "retryable": False,
        "details": None,
    }


@pytest.mark.asyncio
async def test_oversized_milvus_row_is_explicit_and_nonretryable() -> None:
    error = MilvusRowTooLargeError(
        {"id": "node-1", "text": "private body"}, 12000, 8000
    )
    response = await value_error_handler(_index_request(), error)
    payload = json.loads(response.body)
    assert response.status_code == 400
    assert payload["code"] == "milvus_row_too_large"
    assert payload["retryable"] is False
    assert payload["details"]["serialized_bytes"] == 12000
    assert "private body" not in json.dumps(payload)
