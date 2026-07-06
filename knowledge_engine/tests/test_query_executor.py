# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

import pytest

from shared.models import RetrievalScope, RuntimeRetrievalConfig, SearchHints


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
        scope=RetrievalScope(document_ids=[12]),
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
        scope=RetrievalScope(document_ids=[12]),
        metadata_condition=None,
        user_id=7,
    )


@pytest.mark.asyncio
async def test_query_executor_rejects_scope_when_storage_backend_does_not_support_it():
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.supports_retrieval_scope = False
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    with pytest.raises(ValueError, match="Retrieval scope is not supported"):
        await executor.execute(
            knowledge_id="1",
            query="release checklist",
            retrieval_config=RuntimeRetrievalConfig(
                top_k=8,
                score_threshold=0.45,
                retrieval_mode="vector",
            ),
            scope=RetrievalScope(document_ids=[12]),
        )

    storage_backend.retrieve.assert_not_called()


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
        scope=None,
        metadata_condition=None,
    )


@pytest.mark.asyncio
async def test_query_executor_carries_search_hints_into_retrieval_setting() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="release checklist",
        search_hints=SearchHints(
            semantic_query="How to verify the release checklist?",
            keywords=["release", "checklist"],
            phrases=["release checklist"],
        ),
        retrieval_config={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
        },
    )

    storage_backend.retrieve.assert_called_once_with(
        knowledge_id="1",
        query="release checklist",
        embed_model=executor.embed_model,
        retrieval_setting={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
            "search_hints": {
                "semantic_query": "How to verify the release checklist?",
                "keywords": ["release", "checklist"],
                "phrases": ["release checklist"],
            },
        },
        scope=None,
        metadata_condition=None,
    )


@pytest.mark.asyncio
async def test_query_executor_prefers_explicit_query_plan_over_search_hints() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="原始 query",
        query_plan={
            "dense_query": "dense rewrite",
            "sparse_query": "phrase one keyword",
            "keywords": ["keyword"],
            "phrases": ["phrase one"],
            "hint_source": "explicit_hints",
        },
        search_hints=SearchHints(
            semantic_query="ignored semantic",
            keywords=["ignored"],
            phrases=["ignored phrase"],
        ),
        retrieval_config={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
        },
    )

    storage_backend.retrieve.assert_called_once_with(
        knowledge_id="1",
        query="原始 query",
        embed_model=executor.embed_model,
        retrieval_setting={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
            "dense_query": "dense rewrite",
            "sparse_query": "phrase one keyword",
            "keywords": ["keyword"],
            "phrases": ["phrase one"],
            "hint_source": "explicit_hints",
            "search_hints": {
                "semantic_query": "ignored semantic",
                "keywords": ["ignored"],
                "phrases": ["ignored phrase"],
            },
        },
        scope=None,
        metadata_condition=None,
    )


@pytest.mark.asyncio
async def test_query_executor_uses_original_query_as_partial_plan_fallback() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="原始 query",
        query_plan={
            "keywords": ["keyword"],
            "phrases": ["phrase one"],
            "hint_source": "explicit_hints",
        },
        retrieval_config={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
        },
    )

    storage_backend.retrieve.assert_called_once_with(
        knowledge_id="1",
        query="原始 query",
        embed_model=executor.embed_model,
        retrieval_setting={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
            "keywords": ["keyword"],
            "phrases": ["phrase one"],
            "hint_source": "explicit_hints",
        },
        scope=None,
        metadata_condition=None,
    )


@pytest.mark.asyncio
async def test_query_executor_applies_qa_pair_hybrid_policy_for_vector_mode() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.get_supported_retrieval_methods.return_value = [
        "vector",
        "keyword",
        "hybrid",
    ]
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="微博 大广场模式 2025 有什么优势",
        query_plan={"retrieval_profile": "qa_pair", "qa_pair_count": 26},
        retrieval_config={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "vector",
        },
    )

    retrieval_setting = storage_backend.retrieve.call_args.kwargs["retrieval_setting"]
    assert retrieval_setting["retrieval_mode"] == "hybrid"
    assert retrieval_setting["vector_weight"] == 0.6
    assert retrieval_setting["keyword_weight"] == 0.4
    assert retrieval_setting["effective_retrieval_policy"] == "qa_pair_hybrid"
    assert retrieval_setting["retrieval_profile"] == "qa_pair"
    assert retrieval_setting["qa_pair_count"] == 26
    assert "2025" in retrieval_setting["keywords"]
    assert "大广场模式" in retrieval_setting["phrases"]


@pytest.mark.asyncio
async def test_query_executor_keeps_vector_when_qa_pair_hybrid_is_not_supported() -> (
    None
):
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.get_supported_retrieval_methods.return_value = ["vector"]
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="微博 大广场模式",
        query_plan={"retrieval_profile": "qa_pair", "qa_pair_count": 26},
        retrieval_config={
            "top_k": 4,
            "score_threshold": 0.5,
            "retrieval_mode": "vector",
        },
    )

    retrieval_setting = storage_backend.retrieve.call_args.kwargs["retrieval_setting"]
    assert retrieval_setting["retrieval_mode"] == "vector"
    assert (
        retrieval_setting["effective_retrieval_policy"] == "qa_pair_hybrid_unsupported"
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
