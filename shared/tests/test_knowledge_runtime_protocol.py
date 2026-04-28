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
    ]

    for name in exported_names:
        assert getattr(shared_models, name, None) is not None


def test_remote_index_request_accepts_backend_attachment_stream_content_ref() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    request = remote_index_request.model_validate(
        {
            "knowledge_base_id": 11,
            "user_id": 33,
            "document_id": 22,
            "content_ref": {
                "kind": "backend_attachment_stream",
                "url": "http://backend:8000/api/internal/rag/content/22",
                "auth_token": "test-token",
            },
        }
    )

    assert request.knowledge_base_id == 11
    assert request.user_id == 33
    assert request.content_ref.kind == "backend_attachment_stream"
    assert request.content_ref.auth_token == "test-token"


def test_remote_index_request_accepts_presigned_url_content_ref() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    request = remote_index_request.model_validate(
        {
            "knowledge_base_id": 11,
            "user_id": 33,
            "content_ref": {
                "kind": "presigned_url",
                "url": "https://storage.example.com/file.pdf",
            },
        }
    )

    assert request.content_ref.kind == "presigned_url"


def test_remote_index_request_rejects_unknown_content_ref_kind() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    with pytest.raises(ValidationError):
        remote_index_request.model_validate(
            {
                "knowledge_base_id": 11,
                "user_id": 33,
                "content_ref": {
                    "kind": "unsupported_kind",
                    "url": "http://backend:8000/api/internal/rag/content/22",
                },
            }
        )


def test_remote_index_request_rejects_missing_user_id() -> None:
    remote_index_request = _require_model("RemoteIndexRequest")

    with pytest.raises(ValidationError):
        remote_index_request.model_validate(
            {
                "knowledge_base_id": 11,
                "content_ref": {
                    "kind": "backend_attachment_stream",
                    "url": "http://backend:8000/api/internal/rag/content/22",
                    "auth_token": "test-token",
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


def test_remote_list_chunks_request_accepts_reference_mode() -> None:
    remote_list_chunks_request = _require_model("RemoteListChunksRequest")

    request = remote_list_chunks_request.model_validate(
        {
            "knowledge_base_id": 1001,
            "user_id": 42,
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
    assert request.user_id == 42
    assert request.metadata_condition == {
        "operator": "and",
        "conditions": [
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }


def test_remote_query_request_accepts_reference_mode() -> None:
    remote_query_request = _require_model("RemoteQueryRequest")

    request = remote_query_request.model_validate(
        {
            "knowledge_base_ids": [1001],
            "user_id": 42,
            "query": "release checklist",
            "max_results": 6,
            "metadata_condition": {
                "operator": "or",
                "conditions": [
                    {"key": "source", "operator": "==", "value": "kb"},
                    {"key": "lang", "operator": "==", "value": "zh"},
                ],
            },
        }
    )

    assert request.knowledge_base_ids == [1001]
    assert request.user_id == 42
    assert request.query == "release checklist"
    assert request.max_results == 6
    assert request.metadata_condition == {
        "operator": "or",
        "conditions": [
            {"key": "source", "operator": "==", "value": "kb"},
            {"key": "lang", "operator": "==", "value": "zh"},
        ],
    }


def test_remote_query_request_rejects_missing_user_id() -> None:
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001],
                "query": "release checklist",
            }
        )


def test_remote_query_request_rejects_extra_fields() -> None:
    """Reference mode rejects legacy value-mode fields."""
    remote_query_request = _require_model("RemoteQueryRequest")

    with pytest.raises(ValidationError):
        remote_query_request.model_validate(
            {
                "knowledge_base_ids": [1001],
                "user_id": 42,
                "query": "release checklist",
                "knowledge_base_configs": [],
            }
        )


def test_remote_delete_request_accepts_reference_mode() -> None:
    remote_delete_request = _require_model("RemoteDeleteDocumentIndexRequest")

    request = remote_delete_request.model_validate(
        {
            "knowledge_base_id": 101,
            "user_id": 303,
            "document_ref": "202",
        }
    )

    assert request.knowledge_base_id == 101
    assert request.user_id == 303
    assert request.document_ref == "202"


def test_remote_purge_knowledge_index_request_accepts_reference_mode() -> None:
    remote_purge_request = _require_model("RemotePurgeKnowledgeIndexRequest")

    request = remote_purge_request.model_validate(
        {
            "knowledge_base_id": 101,
            "user_id": 42,
        }
    )

    assert request.knowledge_base_id == 101
    assert request.user_id == 42


def test_remote_drop_knowledge_index_request_accepts_reference_mode() -> None:
    remote_drop_request = _require_model("RemoteDropKnowledgeIndexRequest")

    request = remote_drop_request.model_validate(
        {
            "knowledge_base_id": 101,
            "user_id": 42,
        }
    )

    assert request.knowledge_base_id == 101
    assert request.user_id == 42


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
                "user_id": 42,
                "query": "release",
                "max_results": 0,
            },
        ),
        (
            "RemoteListChunksRequest",
            {
                "knowledge_base_id": 1001,
                "user_id": 42,
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
