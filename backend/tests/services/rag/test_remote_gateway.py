# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest

from app.core.config import settings
from app.services.rag.gateway_factory import (
    get_delete_gateway,
    get_index_gateway,
    get_query_gateway,
)
from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.remote_gateway import RemoteRagGateway, RemoteRagGatewayError
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    IndexSource,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryKnowledgeBaseRuntimeConfig,
    QueryRuntimeSpec,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.models import PresignedUrlContentRef


def _build_response(
    *,
    url: str,
    status_code: int,
    json_body: dict,
) -> httpx.Response:
    request = httpx.Request("POST", url)
    return httpx.Response(status_code, json=json_body, request=request)


@pytest.mark.asyncio
async def test_remote_gateway_index_document_posts_runtime_request(mocker) -> None:
    db = MagicMock()
    mocker.patch(
        "app.services.rag.remote_gateway.build_content_ref_for_attachment",
        return_value=PresignedUrlContentRef(
            kind="presigned_url",
            url="https://storage.example.com/release-notes.md",
        ),
    )
    mocker.patch(
        "app.services.rag.remote_gateway._get_attachment_source_metadata",
        return_value=("release-notes.md", ".md"),
        create=True,
    )
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/index",
            status_code=200,
            json_body={"status": "accepted", "knowledge_id": "1"},
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="retriever-a",
        retriever_namespace="default",
        embedding_model_name="embedding-a",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={
                "type": "qdrant",
                "url": "http://qdrant:6333",
                "indexStrategy": {"mode": "per_dataset"},
            },
        ),
        embedding_model_config=RuntimeEmbeddingModelConfig(
            model_name="embedding-a",
            model_namespace="default",
            resolved_config={
                "protocol": "openai",
                "model_id": "text-embedding-3-small",
                "base_url": "https://api.openai.com/v1",
            },
        ),
        splitter_config={"type": "sentence"},
        index_families=["chunk_vector", "summary_vector_index"],
        user_name="alice",
    )

    result = await gateway.index_document(spec, db=db)

    assert result == {"status": "accepted", "knowledge_id": "1"}
    post_mock.assert_awaited_once()
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/index"
    assert kwargs["headers"] == {"Authorization": "Bearer runtime-token"}
    assert kwargs["json"] == {
        "knowledge_base_id": 1,
        "document_id": 2,
        "index_owner_user_id": 3,
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
            "model_name": "embedding-a",
            "model_namespace": "default",
            "resolved_config": {
                "protocol": "openai",
                "model_id": "text-embedding-3-small",
                "base_url": "https://api.openai.com/v1",
            },
        },
        "splitter_config": {
            "chunk_strategy": "flat",
            "format_enhancement": "none",
            "flat_config": {
                "chunk_size": 1024,
                "chunk_overlap": 200,
                "separator": "\n\n",
            },
            "markdown_enhancement": {"enabled": False},
            "legacy_type": "sentence",
        },
        "index_families": ["chunk_vector", "summary_vector_index"],
        "content_ref": {
            "kind": "presigned_url",
            "url": "https://storage.example.com/release-notes.md",
        },
        "source_file": "release-notes.md",
        "file_extension": ".md",
        "user_name": "alice",
    }


@pytest.mark.asyncio
async def test_remote_gateway_query_omits_backend_only_route_fields(mocker) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/query",
            status_code=200,
            json_body={
                "records": [
                    {
                        "content": "Release checklist",
                        "title": "Checklist",
                        "knowledge_base_id": 1,
                        "index_family": "chunk_vector",
                    }
                ],
                "total": 1,
                "total_estimated_tokens": 12,
            },
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[1],
        query="release checklist",
        route_mode="direct_injection",
        restricted_mode=True,
        user_id=8,
        knowledge_base_configs=[
            QueryKnowledgeBaseRuntimeConfig(
                knowledge_base_id=1,
                index_owner_user_id=8,
                retriever_config=RuntimeRetrieverConfig(
                    name="retriever-a",
                    namespace="default",
                    storage_config={
                        "type": "qdrant",
                        "url": "http://qdrant:6333",
                    },
                ),
                embedding_model_config=RuntimeEmbeddingModelConfig(
                    model_name="embedding-a",
                    model_namespace="default",
                    resolved_config={
                        "protocol": "openai",
                        "model_id": "text-embedding-3-small",
                    },
                ),
                retrieval_config=RuntimeRetrievalConfig(
                    top_k=20,
                    score_threshold=0.7,
                    retrieval_mode="vector",
                ),
            )
        ],
        enabled_index_families=["chunk_vector", "summary_vector_index"],
        retrieval_policy="summary_then_chunk_expand",
    )

    result = await gateway.query(spec)

    assert result == {
        "mode": "rag_retrieval",
        "records": [
            {
                "content": "Release checklist",
                "title": "Checklist",
                "score": None,
                "metadata": None,
                "knowledge_base_id": 1,
                "document_id": None,
                "index_family": "chunk_vector",
            }
        ],
        "total": 1,
        "total_estimated_tokens": 12,
    }
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/query"
    assert kwargs["json"] == {
        "knowledge_base_ids": [1],
        "query": "release checklist",
        "max_results": 5,
        "knowledge_base_configs": [
            {
                "knowledge_base_id": 1,
                "index_owner_user_id": 8,
                "retriever_config": {
                    "name": "retriever-a",
                    "namespace": "default",
                    "storage_config": {
                        "type": "qdrant",
                        "url": "http://qdrant:6333",
                    },
                },
                "embedding_model_config": {
                    "model_name": "embedding-a",
                    "model_namespace": "default",
                    "resolved_config": {
                        "protocol": "openai",
                        "model_id": "text-embedding-3-small",
                    },
                },
                "retrieval_config": {
                    "top_k": 20,
                    "score_threshold": 0.7,
                    "retrieval_mode": "vector",
                },
            }
        ],
        "enabled_index_families": ["chunk_vector", "summary_vector_index"],
        "retrieval_policy": "summary_then_chunk_expand",
    }


@pytest.mark.asyncio
async def test_remote_gateway_translates_structured_remote_errors(mocker) -> None:
    mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/query",
            status_code=503,
            json_body={
                "code": "runtime_unavailable",
                "message": "knowledge runtime unavailable",
                "retryable": True,
            },
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )

    with pytest.raises(
        RemoteRagGatewayError, match="knowledge runtime unavailable"
    ) as exc:
        await gateway.query(
            QueryRuntimeSpec(
                knowledge_base_ids=[1],
                query="release",
                knowledge_base_configs=[
                    QueryKnowledgeBaseRuntimeConfig(
                        knowledge_base_id=1,
                        index_owner_user_id=8,
                        retriever_config=RuntimeRetrieverConfig(
                            name="retriever-a",
                            namespace="default",
                            storage_config={
                                "type": "qdrant",
                                "url": "http://qdrant:6333",
                            },
                        ),
                        embedding_model_config=RuntimeEmbeddingModelConfig(
                            model_name="embedding-a",
                            model_namespace="default",
                            resolved_config={
                                "protocol": "openai",
                                "model_id": "text-embedding-3-small",
                            },
                        ),
                        retrieval_config=RuntimeRetrievalConfig(
                            top_k=20,
                            score_threshold=0.7,
                            retrieval_mode="vector",
                        ),
                    )
                ],
            )
        )

    assert exc.value.code == "runtime_unavailable"
    assert exc.value.retryable is True
    assert exc.value.status_code == 503


@pytest.mark.asyncio
async def test_remote_gateway_wraps_transport_errors(mocker) -> None:
    mocker.patch(
        "httpx.AsyncClient.post",
        side_effect=httpx.ConnectError(
            "connection refused",
            request=httpx.Request(
                "POST", "http://knowledge-runtime/internal/rag/query"
            ),
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )

    with pytest.raises(RemoteRagGatewayError, match="transport error") as exc:
        await gateway.query(
            QueryRuntimeSpec(
                knowledge_base_ids=[1],
                query="release",
                knowledge_base_configs=[
                    QueryKnowledgeBaseRuntimeConfig(
                        knowledge_base_id=1,
                        index_owner_user_id=8,
                        retriever_config=RuntimeRetrieverConfig(
                            name="retriever-a",
                            namespace="default",
                            storage_config={
                                "type": "qdrant",
                                "url": "http://qdrant:6333",
                            },
                        ),
                        embedding_model_config=RuntimeEmbeddingModelConfig(
                            model_name="embedding-a",
                            model_namespace="default",
                            resolved_config={
                                "protocol": "openai",
                                "model_id": "text-embedding-3-small",
                            },
                        ),
                        retrieval_config=RuntimeRetrievalConfig(
                            top_k=20,
                            score_threshold=0.7,
                            retrieval_mode="vector",
                        ),
                    )
                ],
            )
        )

    assert exc.value.code == "remote_transport_error"
    assert exc.value.retryable is True
    assert exc.value.status_code is None


@pytest.mark.asyncio
async def test_remote_gateway_delete_posts_resolved_retriever_config(mocker) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/delete-document-index",
            status_code=200,
            json_body={"status": "accepted", "knowledge_id": "1"},
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = DeleteRuntimeSpec(
        knowledge_base_id=1,
        document_ref="9",
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_user"},
            },
        ),
    )

    result = await gateway.delete_document_index(spec, db=MagicMock())

    assert result == {"status": "accepted", "knowledge_id": "1"}
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/delete-document-index"
    assert kwargs["json"] == {
        "knowledge_base_id": 1,
        "document_ref": "9",
        "index_owner_user_id": 7,
        "retriever_config": {
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_user"},
            },
        },
        "enabled_index_families": ["chunk_vector"],
    }


@pytest.mark.asyncio
async def test_remote_gateway_purge_index_posts_runtime_request(mocker) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/purge-knowledge-index",
            status_code=200,
            json_body={"status": "deleted", "knowledge_id": "1", "deleted_chunks": 8},
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = PurgeKnowledgeRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_user"},
            },
        ),
    )

    result = await gateway.purge_knowledge_index(spec, db=MagicMock())

    assert result == {"status": "deleted", "knowledge_id": "1", "deleted_chunks": 8}
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/purge-knowledge-index"
    assert kwargs["json"] == {
        "knowledge_base_id": 1,
        "index_owner_user_id": 7,
        "retriever_config": {
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_user"},
            },
        },
    }


@pytest.mark.asyncio
async def test_remote_gateway_drop_index_posts_runtime_request(mocker) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/drop-knowledge-index",
            status_code=200,
            json_body={"status": "dropped", "knowledge_id": "1", "index_name": "kb_1"},
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = DropKnowledgeIndexRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_dataset"},
            },
        ),
    )

    result = await gateway.drop_knowledge_index(spec, db=MagicMock())

    assert result == {"status": "dropped", "knowledge_id": "1", "index_name": "kb_1"}
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/drop-knowledge-index"
    assert kwargs["json"] == {
        "knowledge_base_id": 1,
        "index_owner_user_id": 7,
        "retriever_config": {
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {
                "type": "elasticsearch",
                "url": "http://es:9200",
                "indexStrategy": {"mode": "per_dataset"},
            },
        },
    }


@pytest.mark.asyncio
async def test_remote_gateway_test_connection_posts_resolved_retriever_config(
    mocker,
) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/test-connection",
            status_code=200,
            json_body={"success": True, "message": "Connection successful"},
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = ConnectionTestRuntimeSpec(
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "elasticsearch", "url": "http://es:9200"},
        )
    )

    result = await gateway.test_connection(spec, db=MagicMock())

    assert result == {"success": True, "message": "Connection successful"}
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/test-connection"
    assert kwargs["json"] == {
        "retriever_config": {
            "name": "retriever-a",
            "namespace": "default",
            "storage_config": {
                "type": "elasticsearch",
                "url": "http://es:9200",
            },
        }
    }


@pytest.mark.asyncio
async def test_remote_gateway_list_chunks_posts_runtime_request(mocker) -> None:
    post_mock = mocker.patch(
        "httpx.AsyncClient.post",
        return_value=_build_response(
            url="http://knowledge-runtime/internal/rag/all-chunks",
            status_code=200,
            json_body={
                "chunks": [
                    {
                        "content": "Chunk A",
                        "title": "Doc A",
                        "chunk_id": 1,
                        "doc_ref": "doc-1",
                        "metadata": {"page": 1},
                    }
                ],
                "total": 1,
            },
        ),
    )
    gateway = RemoteRagGateway(
        base_url="http://knowledge-runtime",
        token="runtime-token",
    )
    spec = ListChunksRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=8,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={
                "type": "qdrant",
                "url": "http://qdrant:6333",
            },
        ),
        max_chunks=1000,
        query="list_index_chunks",
        metadata_condition={
            "operator": "and",
            "conditions": [
                {"key": "lang", "operator": "==", "value": "zh"},
            ],
        },
    )

    result = await gateway.list_chunks(spec)

    assert result == {
        "chunks": [
            {
                "content": "Chunk A",
                "title": "Doc A",
                "chunk_id": 1,
                "doc_ref": "doc-1",
                "metadata": {"page": 1},
            }
        ],
        "total": 1,
    }
    args, kwargs = post_mock.await_args
    assert args[0] == "http://knowledge-runtime/internal/rag/all-chunks"
    assert kwargs["json"] == {
        "knowledge_base_id": 1,
        "index_owner_user_id": 8,
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


def test_gateway_factory_returns_local_gateways_by_default(monkeypatch) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", "local")

    assert isinstance(get_index_gateway(), LocalRagGateway)
    assert isinstance(get_query_gateway(), LocalRagGateway)
    assert isinstance(get_delete_gateway(), LocalRagGateway)


def test_gateway_factory_returns_remote_gateways_when_enabled(monkeypatch) -> None:
    monkeypatch.setattr(settings, "RAG_RUNTIME_MODE", "remote")

    assert isinstance(get_index_gateway(), RemoteRagGateway)
    assert isinstance(get_query_gateway(), RemoteRagGateway)
    assert isinstance(get_delete_gateway(), RemoteRagGateway)


def test_gateway_factory_supports_per_operation_overrides(monkeypatch) -> None:
    monkeypatch.setattr(
        settings,
        "RAG_RUNTIME_MODE",
        {"default": "local", "query": "remote", "delete": "remote"},
    )

    assert isinstance(get_index_gateway(), LocalRagGateway)
    assert isinstance(get_query_gateway(), RemoteRagGateway)
    assert isinstance(get_delete_gateway(), RemoteRagGateway)
