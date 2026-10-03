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
async def test_config_resolution_error_returns_bad_request_and_keeps_the_message() -> (
    None
):
    """Config failures from this service reach Backend as 400 invalid_request.

    The delete, purge, drop and list-chunks prechecks moved from the Backend to
    ``ConfigResolver``, so this mapping is what keeps their status code and text.
    """
    error = ConfigResolutionError(
        "config_incomplete",
        "Knowledge base 7 has incomplete retrieval config (missing retriever_name)",
    )

    response = await value_error_handler(_index_request(), error)
    payload = json.loads(response.body)

    assert response.status_code == 400
    assert payload == {
        "code": "invalid_request",
        "message": (
            "Knowledge base 7 has incomplete retrieval config "
            "(missing retriever_name)"
        ),
        "retryable": False,
        "details": None,
    }
