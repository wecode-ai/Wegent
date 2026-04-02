# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock

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

    spec = QueryRuntimeSpec(knowledge_base_ids=[1], query="q")
    result = await gateway.query(spec)

    assert result["mode"] == "rag_retrieval"
    gateway._retrieval_executor.assert_awaited_once_with(spec)


@pytest.mark.asyncio
async def test_local_gateway_index_document_delegates_to_local_indexing_executor():
    gateway = LocalRagGateway()
    gateway._index_executor = AsyncMock(
        return_value={"status": "success", "knowledge_id": "1"}
    )

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

    assert result["status"] == "success"
    gateway._index_executor.assert_awaited_once_with(spec)


@pytest.mark.asyncio
async def test_local_gateway_delete_document_index_delegates_to_delete_executor():
    gateway = LocalRagGateway()
    gateway._delete_executor = AsyncMock(return_value={"deleted": True})

    result = await gateway.delete_document_index(
        knowledge_base_id=1,
        document_ref="9",
        db=object(),
    )

    assert result == {"deleted": True}
    gateway._delete_executor.assert_awaited_once()
