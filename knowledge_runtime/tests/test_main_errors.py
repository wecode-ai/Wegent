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
from knowledge_runtime.main import embedding_dimension_mismatch_handler


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
