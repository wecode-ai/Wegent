# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from shared.models import RuntimeRetrievalConfig


@pytest.mark.asyncio
async def test_query_executor_delegates_to_storage_backend_with_normalized_config() -> (
    None
):
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {
        "records": [
            {
                "content": "Release checklist",
                "score": 0.91,
                "title": "Checklist",
                "metadata": {"doc_ref": "12"},
            }
        ]
    }
    embed_model = object()
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=embed_model)

    result = await executor.execute(
        knowledge_id="1",
        query="release checklist",
        retrieval_config=RuntimeRetrievalConfig(
            top_k=8,
            score_threshold=0.45,
            retrieval_mode="hybrid",
            vector_weight=0.8,
            keyword_weight=0.2,
        ),
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "doc_ref", "operator": "in", "value": ["12"]}],
        },
        user_id=7,
    )

    assert result == {
        "records": [
            {
                "content": "Release checklist",
                "score": 0.91,
                "title": "Checklist",
                "metadata": {"doc_ref": "12"},
            }
        ]
    }
    storage_backend.retrieve.assert_called_once_with(
        knowledge_id="1",
        query="release checklist",
        embed_model=embed_model,
        retrieval_setting={
            "top_k": 8,
            "score_threshold": 0.45,
            "retrieval_mode": "hybrid",
            "vector_weight": 0.8,
            "keyword_weight": 0.2,
        },
        metadata_condition={
            "operator": "and",
            "conditions": [{"key": "doc_ref", "operator": "in", "value": ["12"]}],
        },
        user_id=7,
    )


@pytest.mark.asyncio
async def test_query_executor_normalizes_explicit_none_values_to_defaults() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="release checklist",
        retrieval_config={
            "top_k": None,
            "score_threshold": None,
            "retrieval_mode": None,
        },
    )

    storage_backend.retrieve.assert_called_once_with(
        knowledge_id="1",
        query="release checklist",
        embed_model=executor.embed_model,
        retrieval_setting={
            "top_k": 20,
            "score_threshold": 0.7,
            "retrieval_mode": "vector",
        },
        metadata_condition=None,
    )


@pytest.mark.asyncio
async def test_query_executor_merges_hierarchical_child_hits_into_parent_content() -> (
    None
):
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {
        "records": [
            {
                "content": "child chunk",
                "score": 0.92,
                "title": "Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "parent_node_id": "parent-1",
                    "doc_ref": "doc_1",
                },
            }
        ]
    }
    storage_backend.get_parent_nodes.return_value = {
        "parent-1": {
            "content": "parent context",
            "title": "Doc",
            "metadata": {
                "chunk_strategy": "hierarchical",
                "doc_ref": "doc_1",
            },
        }
    }
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    result = await executor.execute(
        knowledge_id="1",
        query="parent question",
        retrieval_config={"top_k": 5, "retrieval_mode": "vector"},
    )

    assert result == {
        "records": [
            {
                "content": "parent context",
                "score": 0.92,
                "title": "Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "doc_ref": "doc_1",
                    "parent_node_id": "parent-1",
                },
            }
        ]
    }
    storage_backend.get_parent_nodes.assert_called_once_with(
        knowledge_id="1",
        parent_node_ids=["parent-1"],
    )


@pytest.mark.asyncio
async def test_query_executor_only_merges_hierarchical_hits_and_preserves_record_order() -> (
    None
):
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {
        "records": [
            {
                "content": "parent candidate",
                "score": 0.95,
                "title": "Hierarchical Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "parent_node_id": "parent-1",
                    "doc_ref": "doc_1",
                },
            },
            {
                "content": "plain chunk",
                "score": 0.81,
                "title": "Flat Doc",
                "metadata": {
                    "chunk_strategy": "flat",
                    "doc_ref": "doc_2",
                },
            },
        ]
    }
    storage_backend.get_parent_nodes.return_value = {
        "parent-1": {
            "content": "resolved parent",
            "title": "Hierarchical Doc",
            "metadata": {
                "chunk_strategy": "hierarchical",
                "doc_ref": "doc_1",
            },
        }
    }
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    result = await executor.execute(
        knowledge_id="1",
        query="mixed question",
        retrieval_config={"top_k": 5, "retrieval_mode": "vector"},
        user_id=11,
    )

    assert result == {
        "records": [
            {
                "content": "resolved parent",
                "score": 0.95,
                "title": "Hierarchical Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "doc_ref": "doc_1",
                    "parent_node_id": "parent-1",
                },
            },
            {
                "content": "plain chunk",
                "score": 0.81,
                "title": "Flat Doc",
                "metadata": {
                    "chunk_strategy": "flat",
                    "doc_ref": "doc_2",
                },
            },
        ]
    }
    storage_backend.get_parent_nodes.assert_called_once_with(
        knowledge_id="1",
        parent_node_ids=["parent-1"],
        user_id=11,
    )


@pytest.mark.asyncio
async def test_query_executor_deduplicates_child_hits_that_resolve_to_same_parent() -> (
    None
):
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {
        "records": [
            {
                "content": "child chunk a",
                "score": 0.83,
                "title": "Hierarchical Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "parent_node_id": "parent-1",
                    "doc_ref": "doc_1",
                },
            },
            {
                "content": "plain chunk",
                "score": 0.81,
                "title": "Flat Doc",
                "metadata": {
                    "chunk_strategy": "flat",
                    "doc_ref": "doc_2",
                },
            },
            {
                "content": "child chunk b",
                "score": 0.91,
                "title": "Hierarchical Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "parent_node_id": "parent-1",
                    "doc_ref": "doc_1",
                },
            },
        ]
    }
    storage_backend.get_parent_nodes.return_value = {
        "parent-1": {
            "content": "resolved parent",
            "title": "Hierarchical Doc",
            "metadata": {
                "chunk_strategy": "hierarchical",
                "doc_ref": "doc_1",
            },
        }
    }
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    result = await executor.execute(
        knowledge_id="1",
        query="mixed question",
        retrieval_config={"top_k": 5, "retrieval_mode": "vector"},
    )

    assert result == {
        "records": [
            {
                "content": "resolved parent",
                "score": 0.91,
                "title": "Hierarchical Doc",
                "metadata": {
                    "chunk_strategy": "hierarchical",
                    "doc_ref": "doc_1",
                    "parent_node_id": "parent-1",
                },
            },
            {
                "content": "plain chunk",
                "score": 0.81,
                "title": "Flat Doc",
                "metadata": {
                    "chunk_strategy": "flat",
                    "doc_ref": "doc_2",
                },
            },
        ]
    }
