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
    ]

    for name in exported_names:
        assert getattr(shared_models, name, None) is not None


def test_remote_index_request_accepts_backend_attachment_stream_content_ref() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    request = remote_index_request.model_validate(
        {
            "knowledge_base_id": 11,
            "document_id": 22,
            "index_owner_user_id": 33,
            "retriever_config": {
                "name": "retriever-a",
                "namespace": "default",
                "storage_config": {
                    "type": "milvus",
                    "url": "http://milvus:19530",
                },
            },
            "embedding_model_config": {
                "model_name": "text-embedding-3-large",
                "model_namespace": "default",
                "resolved_config": {"protocol": "openai"},
            },
            "index_families": ["chunk_vector"],
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/22",
                "auth_token": "test-token",
            },
        }
    )

    assert request.content_ref.kind == "backend_attachment_stream"
    assert request.content_ref.auth_token == "test-token"


def test_remote_index_request_rejects_unknown_content_ref_kind() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    with pytest.raises(ValidationError):
        remote_index_request.model_validate(
            {
                "knowledge_base_id": 11,
                "document_id": 22,
                "index_owner_user_id": 33,
                "retriever_config": {
                    "name": "retriever-a",
                    "namespace": "default",
                    "storage_config": {
                        "type": "milvus",
                        "url": "http://milvus:19530",
                    },
                },
                "embedding_model_config": {
                    "model_name": "text-embedding-3-large",
                    "model_namespace": "default",
                    "resolved_config": {"protocol": "openai"},
                },
                "index_families": ["chunk_vector"],
                "content_ref": {
                    "kind": "unsupported_kind",
                    "url": "http://backend:8000/api/internal/rag/content/22",
                },
            }
        )


def test_remote_query_response_preserves_index_family_per_record() -> None:
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


def test_remote_list_chunks_request_accepts_resolved_retriever_config() -> None:
    remote_list_chunks_request = _require_model("RemoteListChunksRequest")

    request = remote_list_chunks_request.model_validate(
        {
            "knowledge_base_id": 1001,
            "index_owner_user_id": 42,
            "retriever_config": {
                "name": "retriever-a",
                "namespace": "default",
                "storage_config": {
                    "type": "qdrant",
                    "url": "http://qdrant:6333",
                },
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
    assert request.retriever_config.storage_config["type"] == "qdrant"
    assert request.metadata_condition == {
        "operator": "and",
        "conditions": [
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }


def test_remote_query_request_accepts_explicit_execution_configs() -> None:
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
            "knowledge_base_configs": [
                {
                    "knowledge_base_id": 1001,
                    "index_owner_user_id": 42,
                    "retriever_config": {
                        "name": "retriever-a",
                        "namespace": "default",
                        "storage_config": {
                            "type": "qdrant",
                            "url": "http://qdrant:6333",
                            "indexStrategy": {"mode": "per_dataset"},
                        },
                    },
                    "embedding_model_config": {
                        "model_name": "embed-a",
                        "model_namespace": "default",
                        "resolved_config": {
                            "protocol": "openai",
                            "model_id": "text-embedding-3-small",
                            "base_url": "https://api.openai.com/v1",
                        },
                    },
                    "retrieval_config": {
                        "top_k": 8,
                        "score_threshold": 0.55,
                        "retrieval_mode": "hybrid",
                        "vector_weight": 0.8,
                        "keyword_weight": 0.2,
                    },
                }
            ],
            "enabled_index_families": ["chunk_vector", "summary_vector_index"],
            "retrieval_policy": "summary_then_chunk_expand",
        }
    )

    assert (
        request.knowledge_base_configs[0].retriever_config.storage_config["type"]
        == "qdrant"
    )
    assert request.metadata_condition == {
        "operator": "or",
        "conditions": [
            {"key": "source", "operator": "==", "value": "kb"},
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }
    assert request.knowledge_base_configs[0].retrieval_config.top_k == 8
    assert request.enabled_index_families == [
        "chunk_vector",
        "summary_vector_index",
    ]


def test_remote_query_request_rejects_empty_knowledge_base_configs() -> None:
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001],
                "query": "release checklist",
                "knowledge_base_configs": [],
            }
        )


def test_remote_query_request_rejects_misaligned_knowledge_base_configs() -> None:
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001, 1002],
                "query": "release checklist",
                "knowledge_base_configs": [
                    {
                        "knowledge_base_id": 1001,
                        "index_owner_user_id": 42,
                        "retriever_config": {
                            "name": "retriever-a",
                            "namespace": "default",
                            "storage_config": {
                                "type": "qdrant",
                                "url": "http://qdrant:6333",
                            },
                        },
                        "embedding_model_config": {
                            "model_name": "embed-a",
                            "model_namespace": "default",
                            "resolved_config": {
                                "protocol": "openai",
                                "model_id": "text-embedding-3-small",
                            },
                        },
                        "retrieval_config": {
                            "top_k": 8,
                            "score_threshold": 0.55,
                            "retrieval_mode": "hybrid",
                        },
                    }
                ],
            }
        )


def test_remote_query_request_rejects_duplicate_alignment_mismatch() -> None:
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001, 1001],
                "query": "release checklist",
                "knowledge_base_configs": [
                    {
                        "knowledge_base_id": 1001,
                        "index_owner_user_id": 42,
                        "retriever_config": {
                            "name": "retriever-a",
                            "namespace": "default",
                            "storage_config": {
                                "type": "qdrant",
                                "url": "http://qdrant:6333",
                            },
                        },
                        "embedding_model_config": {
                            "model_name": "embed-a",
                            "model_namespace": "default",
                            "resolved_config": {
                                "protocol": "openai",
                                "model_id": "text-embedding-3-small",
                            },
                        },
                        "retrieval_config": {
                            "top_k": 8,
                            "score_threshold": 0.55,
                            "retrieval_mode": "vector",
                        },
                    }
                ],
            }
        )


def test_remote_delete_request_requires_resolved_retriever_config() -> None:
    remote_delete_request = _require_model("RemoteDeleteDocumentIndexRequest")

    request = remote_delete_request.model_validate(
        {
            "knowledge_base_id": 101,
            "document_ref": "202",
            "index_owner_user_id": 303,
            "retriever_config": {
                "name": "retriever-a",
                "namespace": "default",
                "storage_config": {
                    "type": "elasticsearch",
                    "url": "http://es:9200",
                    "indexStrategy": {"mode": "per_user", "prefix": "wegent"},
                },
            },
            "enabled_index_families": ["chunk_vector"],
        }
    )

    assert request.retriever_config.name == "retriever-a"
    assert request.retriever_config.storage_config["type"] == "elasticsearch"


def test_remote_test_connection_request_requires_retriever_config() -> None:
    remote_test_connection_request = _require_model("RemoteTestConnectionRequest")

    request = remote_test_connection_request.model_validate(
        {
            "retriever_config": {
                "name": "retriever-a",
                "namespace": "default",
                "storage_config": {
                    "type": "qdrant",
                    "url": "http://qdrant:6333",
                },
            }
        }
    )

    assert request.retriever_config.storage_config["type"] == "qdrant"


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
                "knowledge_base_configs": [
                    {
                        "knowledge_base_id": 1,
                        "index_owner_user_id": 42,
                        "retriever_config": {
                            "name": "retriever-a",
                            "namespace": "default",
                            "storage_config": {
                                "type": "qdrant",
                                "url": "http://qdrant:6333",
                            },
                        },
                        "embedding_model_config": {
                            "model_name": "embed-a",
                            "model_namespace": "default",
                            "resolved_config": {"protocol": "openai"},
                        },
                        "retrieval_config": {
                            "top_k": 8,
                            "score_threshold": 0.55,
                            "retrieval_mode": "vector",
                        },
                    }
                ],
            },
        ),
        (
            "RemoteListChunksRequest",
            {
                "knowledge_base_id": 1001,
                "index_owner_user_id": 42,
                "retriever_config": {
                    "name": "retriever-a",
                    "namespace": "default",
                    "storage_config": {"type": "qdrant", "url": "http://qdrant:6333"},
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
    model = _require_model(model_name)

    with pytest.raises(ValidationError):
        model.model_validate(payload)
