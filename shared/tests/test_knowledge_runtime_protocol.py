# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

import pytest
from pydantic import ValidationError

import shared.models as shared_models


def _require_model(name: str):
    model = getattr(shared_models, name, None)
    if model is None:
        pytest.fail(f"shared.models must export {name}")
    return model


def test_shared_models_exports_knowledge_runtime_protocol_types() -> None:
    exported_names = [
        "BackendAttachmentStreamContentRef",
        "PresignedUrlContentRef",
        "RuntimeEmbeddingModelConfig",
        "RuntimeRetrievalConfig",
        "RuntimeRetrieverConfig",
        "RemoteKnowledgeBaseQueryConfig",
        "RemoteDeleteDocumentIndexRequest",
        "RemoteIndexRequest",
        "RemoteListChunksRequest",
        "RemoteListChunksResponse",
        "RemoteListChunkRecord",
        "RemoteQueryRequest",
        "RemoteQueryRecord",
        "RemoteQueryResponse",
        "RemoteTestConnectionRequest",
        # Reference types
        "KnowledgeBaseReference",
        "RetrieverReference",
        "EmbeddingModelReference",
    ]

    for name in exported_names:
        assert getattr(shared_models, name, None) is not None


def test_remote_index_request_accepts_reference_mode() -> None:
    """Test RemoteIndexRequest accepts reference mode."""
    remote_index_request = _require_model("RemoteIndexRequest")
    KnowledgeBaseReference = _require_model("KnowledgeBaseReference")

    request = remote_index_request.model_validate(
        {
            "knowledge_base_id": 11,
            "document_id": 22,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/22",
                "auth_token": "test-token",
            },
            "knowledge_base_reference": {
                "knowledge_base_id": 11,
                "user_id": 33,
            },
            "index_families": ["chunk_vector"],
        }
    )

    assert request.content_ref.kind == "backend_attachment_stream"
    assert request.content_ref.auth_token == "test-token"
    assert request.knowledge_base_reference.knowledge_base_id == 11
    assert request.knowledge_base_reference.user_id == 33


def test_remote_index_request_rejects_unknown_content_ref_kind() -> None:
    """Test RemoteIndexRequest rejects unknown content_ref kind."""
    remote_index_request = _require_model("RemoteIndexRequest")

    with pytest.raises(ValidationError):
        remote_index_request.model_validate(
            {
                "knowledge_base_id": 11,
                "document_id": 22,
                "content_ref": {
                    "kind": "unsupported_kind",
                    "url": "http://backend:8000/api/internal/rag/content/22",
                },
                "knowledge_base_reference": {
                    "knowledge_base_id": 11,
                    "user_id": 33,
                },
            }
        )


def test_remote_query_response_preserves_index_family_per_record() -> None:
    """Test RemoteQueryResponse preserves index_family per record."""
    remote_query_response = _require_model("RemoteQueryResponse")

    response = remote_query_response.model_validate(
        {
            "records": [
                {
                    "content": "Chunk A",
                    "title": "Doc A",
                    "score": 0.91,
                    "knowledge_base_id": 1001,
                    "index_family": "chunk_vector",
                },
                {
                    "content": "Summary B",
                    "title": "Doc B",
                    "score": 0.88,
                    "knowledge_base_id": 1002,
                    "index_family": "summary_vector",
                },
            ],
            "total": 2,
        }
    )

    assert [record.index_family for record in response.records] == [
        "chunk_vector",
        "summary_vector",
    ]


def test_remote_list_chunks_request_accepts_reference_mode() -> None:
    """Test RemoteListChunksRequest accepts reference mode."""
    remote_list_chunks_request = _require_model("RemoteListChunksRequest")

    request = remote_list_chunks_request.model_validate(
        {
            "knowledge_base_id": 1001,
            "knowledge_base_reference": {
                "knowledge_base_id": 1001,
                "user_id": 42,
            },
            "max_chunks": 1000,
            "query": "list_index_chunks",
            "metadata_condition": {
                "operator": "and",
                "conditions": [
                    {"key": "lang", "operator": "==", "value": "zh"},
                ],
            },
        }
    )

    assert request.knowledge_base_id == 1001
    assert request.knowledge_base_reference.user_id == 42
    assert request.metadata_condition == {
        "operator": "and",
        "conditions": [
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }


def test_remote_query_request_accepts_reference_mode() -> None:
    """Test RemoteQueryRequest accepts reference mode with knowledge_base_references."""
    remote_query_request = _require_model("RemoteQueryRequest")

    request = remote_query_request.model_validate(
        {
            "knowledge_base_ids": [1001],
            "query": "release checklist",
            "max_results": 6,
            "metadata_condition": {
                "operator": "or",
                "conditions": [
                    {"key": "source", "operator": "==", "value": "kb"},
                    {"key": "lang", "operator": "==", "value": "zh"},
                ],
            },
            "knowledge_base_references": [
                {
                    "knowledge_base_id": 1001,
                    "user_id": 42,
                }
            ],
            "user_id": 1,
            "enabled_index_families": ["chunk_vector", "summary_vector_index"],
            "retrieval_policy": "summary_then_chunk_expand",
        }
    )

    assert request.knowledge_base_references[0].knowledge_base_id == 1001
    assert request.knowledge_base_references[0].user_id == 42
    assert request.metadata_condition == {
        "operator": "or",
        "conditions": [
            {"key": "source", "operator": "==", "value": "kb"},
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }
    assert request.enabled_index_families == [
        "chunk_vector",
        "summary_vector_index",
    ]


def test_remote_query_request_rejects_empty_knowledge_base_references() -> None:
    """Test RemoteQueryRequest rejects empty knowledge_base_references."""
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001],
                "query": "release checklist",
                "knowledge_base_references": [],
                "user_id": 1,
            }
        )


def test_remote_query_request_rejects_misaligned_knowledge_base_references() -> None:
    """Test RemoteQueryRequest rejects misaligned knowledge_base_references."""
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001, 1002],
                "query": "release checklist",
                "knowledge_base_references": [
                    {
                        "knowledge_base_id": 1001,
                        "user_id": 42,
                    }
                ],
                "user_id": 1,
            }
        )


def test_remote_query_request_rejects_duplicate_alignment_mismatch() -> None:
    """Test RemoteQueryRequest rejects duplicate alignment mismatch."""
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001, 1001],
                "query": "release checklist",
                "knowledge_base_references": [
                    {
                        "knowledge_base_id": 1001,
                        "user_id": 42,
                    }
                ],
                "user_id": 1,
            }
        )


def test_remote_delete_request_accepts_reference_mode() -> None:
    """Test RemoteDeleteDocumentIndexRequest accepts reference mode."""
    remote_delete_request = _require_model("RemoteDeleteDocumentIndexRequest")

    request = remote_delete_request.model_validate(
        {
            "knowledge_base_id": 101,
            "document_ref": "202",
            "knowledge_base_reference": {
                "knowledge_base_id": 101,
                "user_id": 303,
            },
            "enabled_index_families": ["chunk_vector"],
        }
    )

    assert request.knowledge_base_id == 101
    assert request.document_ref == "202"
    assert request.knowledge_base_reference.user_id == 303


def test_remote_test_connection_request_accepts_reference_mode() -> None:
    """Test RemoteTestConnectionRequest accepts reference mode."""
    remote_test_connection_request = _require_model("RemoteTestConnectionRequest")

    request = remote_test_connection_request.model_validate(
        {
            "retriever_reference": {
                "name": "retriever-a",
                "namespace": "default",
                "user_id": 42,
            }
        }
    )

    assert request.retriever_reference.name == "retriever-a"
    assert request.retriever_reference.namespace == "default"
    assert request.retriever_reference.user_id == 42


@pytest.mark.parametrize(
    ("model_name", "payload"),
    [
        (
            "RuntimeRetrievalConfig",
            {
                "top_k": 0,
                "score_threshold": 0.7,
                "retrieval_mode": "vector",
            },
        ),
        (
            "RuntimeRetrievalConfig",
            {
                "top_k": 5,
                "score_threshold": 1.5,
                "retrieval_mode": "vector",
            },
        ),
        (
            "RemoteQueryRequest",
            {
                "knowledge_base_ids": [1],
                "query": "release",
                "max_results": 0,
                "knowledge_base_references": [
                    {
                        "knowledge_base_id": 1,
                        "user_id": 42,
                    }
                ],
                "user_id": 1,
            },
        ),
        (
            "RemoteListChunksRequest",
            {
                "knowledge_base_id": 1001,
                "knowledge_base_reference": {
                    "knowledge_base_id": 1001,
                    "user_id": 42,
                },
                "max_chunks": 10001,
            },
        ),
    ],
)
def test_protocol_models_reject_invalid_numeric_ranges(
    model_name: str,
    payload: dict,
) -> None:
    """Test protocol models reject invalid numeric ranges."""
    model = _require_model(model_name)

    with pytest.raises(ValidationError):
        model.model_validate(payload)


def test_knowledge_base_reference_validation() -> None:
    """Test KnowledgeBaseReference validation."""
    KnowledgeBaseReference = _require_model("KnowledgeBaseReference")

    # Valid reference
    ref = KnowledgeBaseReference(knowledge_base_id=1, user_id=1)
    assert ref.knowledge_base_id == 1
    assert ref.user_id == 1


def test_retriever_reference_validation() -> None:
    """Test RetrieverReference validation."""
    RetrieverReference = _require_model("RetrieverReference")

    # Valid reference with default namespace
    ref = RetrieverReference(name="test-retriever", user_id=1)
    assert ref.name == "test-retriever"
    assert ref.namespace == "default"
    assert ref.user_id == 1

    # Valid reference with custom namespace
    ref2 = RetrieverReference(name="test-retriever", namespace="custom", user_id=1)
    assert ref2.namespace == "custom"
