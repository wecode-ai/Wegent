# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.rag.local_gateway import LocalRagGateway
from app.services.rag.runtime_specs import (
    IndexRuntimeSpec,
    IndexSource,
    QueryRuntimeSpec,
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

    result = await gateway.delete_document_index(
        knowledge_base_id=1,
        document_ref="9",
        db=db,
    )

    assert result == {"deleted": True}
    gateway._delete_executor.assert_awaited_once_with(
        knowledge_base_id=1,
        document_ref="9",
        db=db,
        index_owner_user_id=None,
    )


@pytest.mark.asyncio
async def test_local_gateway_query_requires_db():
    gateway = LocalRagGateway()

    with pytest.raises(ValueError, match="db is required"):
        await gateway.query(QueryRuntimeSpec(knowledge_base_ids=[1], query="q"))


@pytest.mark.asyncio
async def test_local_gateway_index_document_requires_db():
    gateway = LocalRagGateway()

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

    with pytest.raises(ValueError, match="db is required"):
        await gateway.index_document(spec)
