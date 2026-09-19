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


def test_map_indexing_preserves_a_missing_index_code() -> None:
    """The remote path keeps the storage code instead of a generic failure."""
    error = RemoteRagGatewayError(
        "Milvus index 'wegent_kb_1' is missing: the bound collection is gone. "
        "A knowledge base with a confirmed index must not degrade into an "
        "empty result; this needs an operational decision.",
        code="index_missing",
        retryable=False,
        status_code=409,
        details={"collection_name": "wegent_kb_1", "reason": "collection is gone"},
    )

    result = map_indexing_exception(error, generation=7)

    assert result.stage == DocumentProcessingStage.INDEXING
    assert result.code == "index_missing"
    assert result.retryable is False
    assert result.message == (
        "The vector index for this knowledge base is missing. "
        "An operator must rebuild it before retrying."
    )


def test_map_indexing_preserves_a_contract_conflict() -> None:
    error = RemoteRagGatewayError(
        "Milvus index 'wegent_kb_1' is not compatible: embedding_space mismatch.",
        code="index_contract_incompatible",
        retryable=False,
        status_code=409,
    )

    result = map_indexing_exception(error, generation=7)

    assert result.code == "index_contract_incompatible"
    assert result.retryable is False
    assert result.message == (
        "This knowledge base is bound to an incompatible vector index. "
        "An operator must decide how to rebuild or reclaim it."
    )


def test_map_indexing_marks_a_transient_service_failure_retryable() -> None:
    error = RemoteRagGatewayError(
        "knowledge_runtime transport error",
        code="storage_unavailable",
        retryable=True,
        status_code=503,
        details={"sdk_code": "14"},
    )

    result = map_indexing_exception(error, generation=7)

    assert result.code == "storage_unavailable"
    assert result.retryable is True
    assert result.message == (
        "The vector store did not answer within its bound. The remote result "
        "is unknown, so please retry the whole operation."
    )


def test_map_indexing_preserves_an_unsupported_capability() -> None:
    error = RemoteRagGatewayError(
        "Storage backend 'milvus' does not support 'hybrid' yet.",
        code="storage_capability_unsupported",
        retryable=False,
        status_code=409,
    )

    result = map_indexing_exception(error, generation=7)

    assert result.code == "storage_capability_unsupported"
    assert result.retryable is False
    assert result.message == (
        "The vector store does not support the requested capability. "
        "Choose a supported retrieval mode."
    )


def test_a_known_storage_code_wins_over_the_raw_message() -> None:
    """A stored code is authoritative even when the message says timeout."""
    error = RemoteRagGatewayError(
        "timeout while deleting the previous index",
        code="index_missing",
        retryable=False,
        status_code=409,
    )

    result = map_indexing_exception(error, generation=7)

    assert result.code == "index_missing"
    assert result.retryable is False


def test_a_storage_backend_error_is_mapped_from_its_code() -> None:
    """The local in-process path carries the same classes and codes."""
    from knowledge_engine.storage.milvus.errors import IndexMissingError

    result = map_indexing_exception(
        IndexMissingError("wegent_kb_1", "collection is gone"),
        generation=7,
    )

    assert result.code == "index_missing"
    assert result.retryable is False
