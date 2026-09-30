# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

"""A second caller consumes the public operations without product services."""

from unittest.mock import AsyncMock, MagicMock

import pytest


@pytest.mark.asyncio
async def test_empty_authorized_scope_never_queries_storage():
    from shared.knowledge_module import QueryTarget, query_documents

    engine = AsyncMock()
    result = await query_documents(
        [QueryTarget(engine, "space", {})],
        query="secret",
        document_ids=[],
    )
    assert result == {"records": [], "total": 0, "total_estimated_tokens": 0}
    engine.execute.assert_not_called()


@pytest.mark.asyncio
async def test_scoped_query_keeps_reference_and_scope():
    from shared.knowledge_module import QueryTarget, query_documents

    engine = AsyncMock()
    engine.execute.return_value = {
        "records": [{"content": "hit", "metadata": {"doc_ref": "doc_7"}}]
    }
    result = await query_documents(
        [QueryTarget(engine, "space", {})],
        query="needle",
        document_ids=[7],
    )
    assert result["records"][0]["document_id"] == 7
    assert engine.execute.call_args.kwargs["scope"].document_ids == [7]


@pytest.mark.asyncio
async def test_management_lists_then_clears_and_drops_one_space():
    from shared.knowledge_module import manage_index

    store = MagicMock()
    store.get_all_chunks.return_value = [{"content": "body", "doc_ref": "7"}]
    store.extract_chunk_text.side_effect = lambda value: value
    store.delete_knowledge.return_value = {"deleted_chunks": 1}
    store.drop_knowledge_index.return_value = {"status": "dropped"}
    listed = await manage_index(
        store, operation="list_chunks", knowledge_id="space", user_id=42
    )
    assert listed == {
        "chunks": [
            {
                "content": "body",
                "title": "",
                "chunk_id": None,
                "doc_ref": "7",
                "metadata": None,
            }
        ],
        "total": 1,
    }
    assert await manage_index(
        store, operation="purge", knowledge_id="space", user_id=42
    ) == {"deleted_chunks": 1}
    assert await manage_index(
        store, operation="drop", knowledge_id="space", user_id=42
    ) == {"status": "dropped"}
    store.delete_knowledge.assert_called_once_with(knowledge_id="space", user_id=42)


@pytest.mark.asyncio
async def test_multi_space_query_ranks_globally_and_preserves_total():
    from shared.knowledge_module import QueryTarget, query_documents

    first, second = AsyncMock(), AsyncMock()
    first.execute.return_value = {"records": [{"content": "low", "score": 0.2}]}
    second.execute.return_value = {"records": [{"content": "high-hit", "score": 0.9}]}
    result = await query_documents(
        [QueryTarget(first, "one", {}), QueryTarget(second, "two", {})],
        query="needle",
        max_results=1,
    )
    assert result["records"] == [
        {
            "content": "high-hit",
            "score": 0.9,
            "knowledge_id": "two",
            "document_id": None,
        }
    ]
    assert result["total"] == 2
    assert result["total_estimated_tokens"] == 2
