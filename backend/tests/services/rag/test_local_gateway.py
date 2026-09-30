# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.core.config import settings
from app.services.rag.local_gateway import (
    LocalDataPlaneDisabledError,
    LocalRagGateway,
)
from app.services.rag.runtime_specs import (
    ConnectionTestRuntimeSpec,
    DeleteRuntimeSpec,
    DropKnowledgeIndexRuntimeSpec,
    IndexRuntimeSpec,
    IndexSource,
    ListChunksRuntimeSpec,
    PurgeKnowledgeRuntimeSpec,
    QueryRuntimeSpec,
)
from shared.models import RuntimeRetrieverConfig


def _index_spec() -> IndexRuntimeSpec:
    return IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="r",
        retriever_namespace="default",
        embedding_model_name="e",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
    )


def _delete_spec() -> DeleteRuntimeSpec:
    return DeleteRuntimeSpec(
        knowledge_base_id=1,
        document_ref="9",
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
    )


@pytest.mark.asyncio
async def test_local_gateway_query_delegates_to_local_retrieval_executor():
    gateway = LocalRagGateway()
    gateway._retrieval_executor = AsyncMock(
        return_value={"mode": "rag_retrieval", "records": [], "total": 0}
    )
    db = MagicMock()

    spec = QueryRuntimeSpec(knowledge_base_ids=[1], query="q")
    result = await gateway.query(spec, db=db)

    assert result["mode"] == "rag_retrieval"
    gateway._retrieval_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_index_document_delegates_to_local_indexing_executor():
    gateway = LocalRagGateway()
    gateway._index_executor = AsyncMock(
        return_value={"status": "success", "knowledge_id": "1"}
    )
    db = MagicMock()

    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="r",
        retriever_namespace="default",
        embedding_model_name="e",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
    )
    result = await gateway.index_document(spec, db=db)

    assert result["status"] == "success"
    gateway._index_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_delete_document_index_delegates_to_delete_executor():
    gateway = LocalRagGateway()
    gateway._delete_executor = AsyncMock(return_value={"deleted": True})
    db = MagicMock()
    spec = DeleteRuntimeSpec(
        knowledge_base_id=1,
        document_ref="9",
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
    )

    result = await gateway.delete_document_index(spec, db=db)

    assert result == {"deleted": True}
    gateway._delete_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_purge_knowledge_index_delegates_to_purge_executor():
    gateway = LocalRagGateway()
    gateway._purge_executor = AsyncMock(return_value={"status": "deleted", "total": 5})
    db = MagicMock()
    spec = PurgeKnowledgeRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
    )

    result = await gateway.purge_knowledge_index(spec, db=db)

    assert result == {"status": "deleted", "total": 5}
    gateway._purge_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_drop_knowledge_index_delegates_to_drop_executor():
    gateway = LocalRagGateway()
    gateway._drop_executor = AsyncMock(return_value={"status": "dropped"})
    db = MagicMock()
    spec = DropKnowledgeIndexRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
    )

    result = await gateway.drop_knowledge_index(spec, db=db)

    assert result == {"status": "dropped"}
    gateway._drop_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_test_connection_delegates_to_connection_executor():
    gateway = LocalRagGateway()
    gateway._connection_test_executor = AsyncMock(
        return_value={"success": True, "message": "Connection successful"}
    )
    db = MagicMock()
    spec = ConnectionTestRuntimeSpec(
        retriever_config=RuntimeRetrieverConfig(
            name="test-retriever",
            namespace="default",
            storage_config={"type": "qdrant", "url": "http://localhost:6333"},
        )
    )

    result = await gateway.test_connection(spec, db=db)

    assert result == {"success": True, "message": "Connection successful"}
    gateway._connection_test_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_list_chunks_delegates_to_chunk_listing_executor():
    gateway = LocalRagGateway()
    gateway._list_chunks_executor = AsyncMock(
        return_value={"chunks": [{"content": "chunk", "title": "Doc"}], "total": 1}
    )
    db = MagicMock()
    spec = ListChunksRuntimeSpec(
        knowledge_base_id=1,
        index_owner_user_id=7,
        retriever_config=RuntimeRetrieverConfig(
            name="retriever-a",
            namespace="default",
            storage_config={"type": "qdrant"},
        ),
        max_chunks=1000,
    )

    result = await gateway.list_chunks(spec, db=db)

    assert result == {"chunks": [{"content": "chunk", "title": "Doc"}], "total": 1}
    gateway._list_chunks_executor.assert_awaited_once_with(spec, db=db)


@pytest.mark.asyncio
async def test_local_gateway_query_requires_db():
    gateway = LocalRagGateway()

    with pytest.raises(ValueError, match="db is required"):
        await gateway.query(QueryRuntimeSpec(knowledge_base_ids=[1], query="q"))


@pytest.mark.asyncio
async def test_local_gateway_index_document_allows_gateway_owned_session():
    gateway = LocalRagGateway()
    gateway._index_executor = AsyncMock(return_value={"status": "success"})

    spec = IndexRuntimeSpec(
        knowledge_base_id=1,
        document_id=2,
        index_owner_user_id=3,
        retriever_name="r",
        retriever_namespace="default",
        embedding_model_name="e",
        embedding_model_namespace="default",
        source=IndexSource(source_type="attachment", attachment_id=9),
    )

    result = await gateway.index_document(spec)

    assert result == {"status": "success"}
    gateway._index_executor.assert_awaited_once_with(spec, db=None)


@pytest.mark.asyncio
async def test_local_gateway_index_document_refuses_remote_configured_operation(
    monkeypatch,
):
    """A remote-configured index must fail before any local storage work."""

    monkeypatch.setattr(
        settings, "RAG_RUNTIME_MODE", {"default": "local", "index": "remote"}
    )
    gateway = LocalRagGateway()
    gateway._index_executor = AsyncMock(
        side_effect=AssertionError("local indexing must not run")
    )

    with pytest.raises(LocalDataPlaneDisabledError, match="index"):
        await gateway.index_document(_index_spec(), db=None)

    gateway._index_executor.assert_not_called()


@pytest.mark.asyncio
async def test_local_gateway_delete_document_index_refuses_remote_configured_operation(
    monkeypatch,
):
    """A remote-configured delete must fail before any local storage work."""

    monkeypatch.setattr(
        settings, "RAG_RUNTIME_MODE", {"default": "local", "delete": "remote"}
    )
    gateway = LocalRagGateway()
    gateway._delete_executor = AsyncMock(
        side_effect=AssertionError("local delete must not run")
    )

    with pytest.raises(LocalDataPlaneDisabledError, match="delete"):
        await gateway.delete_document_index(_delete_spec(), db=None)

    gateway._delete_executor.assert_not_called()


@pytest.mark.asyncio
async def test_local_gateway_query_refuses_remote_configured_rag_retrieval(
    monkeypatch,
):
    """A remote-configured retrieval query must fail before local storage work."""

    monkeypatch.setattr(
        settings, "RAG_RUNTIME_MODE", {"default": "local", "query": "remote"}
    )
    gateway = LocalRagGateway()
    gateway._retrieval_executor = AsyncMock(
        side_effect=AssertionError("local retrieval must not run")
    )
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[1], query="q", route_mode="rag_retrieval"
    )

    with pytest.raises(LocalDataPlaneDisabledError, match="query"):
        await gateway.query(spec, db=MagicMock())

    gateway._retrieval_executor.assert_not_called()


@pytest.mark.asyncio
async def test_local_gateway_query_still_serves_non_retrieval_routes(monkeypatch):
    """direct_injection and auto routing keep executing on the local plane."""

    monkeypatch.setattr(
        settings, "RAG_RUNTIME_MODE", {"default": "local", "query": "remote"}
    )
    gateway = LocalRagGateway()
    gateway._retrieval_executor = AsyncMock(
        return_value={"mode": "direct_injection", "records": [], "total": 0}
    )
    db = MagicMock()
    spec = QueryRuntimeSpec(
        knowledge_base_ids=[1], query="q", route_mode="direct_injection"
    )

    result = await gateway.query(spec, db=db)

    assert result["mode"] == "direct_injection"
    gateway._retrieval_executor.assert_awaited_once_with(spec, db=db)
