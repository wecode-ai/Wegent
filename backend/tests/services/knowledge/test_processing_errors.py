# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from app.schemas.knowledge import DocumentProcessingStage
from app.services.knowledge.processing_errors import map_indexing_exception
from app.services.rag.remote_gateway import RemoteRagGatewayError


def test_map_indexing_dimension_mismatch_is_stable_and_nonretryable() -> None:
    error = RemoteRagGatewayError(
        "Embedding model returned an unexpected vector dimension.",
        code="embedding_dimension_mismatch",
        retryable=False,
        status_code=422,
        details={
            "model": "Qwen/Qwen3-Embedding-8B",
            "expected_dimensions": 1024,
            "actual_dimensions": 4096,
        },
    )

    result = map_indexing_exception(error, generation=3)

    assert result.stage == DocumentProcessingStage.INDEXING
    assert result.code == "embedding_dimension_mismatch"
    assert result.message == (
        "The embedding model returned an unexpected vector dimension. "
        "Check the model configuration and rebuild the document index."
    )
    assert result.retryable is False
    assert result.generation == 3
    assert result.model == "Qwen/Qwen3-Embedding-8B"
