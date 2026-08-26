# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json

import pytest
from fastapi import Request

from knowledge_engine.embedding.errors import EmbeddingDimensionMismatchError
from knowledge_runtime.main import embedding_dimension_mismatch_handler


@pytest.mark.asyncio
async def test_embedding_dimension_mismatch_returns_stable_nonretryable_error() -> None:
    request = Request(
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
