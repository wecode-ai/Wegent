# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""One source for the "未配置" score threshold: absent means "do not cut".

The threshold is a rule about a score scale and the scale belongs to the
engine, so the only default that is correct on both engines is zero. These
tests pin both halves of the decision: every layer resolves an absent
threshold to the shared constant, and an explicitly passed threshold still
reaches the engine unchanged.
"""

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.storage.milvus_backend import MilvusBackend
from shared.models import DEFAULT_SCORE_THRESHOLD, RuntimeRetrievalConfig


def test_public_model_default_is_the_shared_zero_constant() -> None:
    assert DEFAULT_SCORE_THRESHOLD == 0.0
    assert RuntimeRetrievalConfig(top_k=20).score_threshold == DEFAULT_SCORE_THRESHOLD


def test_milvus_engine_fallback_reads_the_same_constant() -> None:
    assert MilvusBackend._resolve_score_threshold({}) == DEFAULT_SCORE_THRESHOLD
    assert MilvusBackend._resolve_score_threshold({"score_threshold": 0.7}) == 0.7


@pytest.mark.asyncio
async def test_executor_resolves_an_absent_threshold_to_the_shared_constant() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="release checklist",
        retrieval_config={"top_k": 20, "retrieval_mode": "vector"},
    )

    retrieval_setting = storage_backend.retrieve.call_args.kwargs["retrieval_setting"]
    assert retrieval_setting["score_threshold"] == DEFAULT_SCORE_THRESHOLD


@pytest.mark.asyncio
async def test_executor_keeps_an_explicit_threshold_untouched() -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="release checklist",
        retrieval_config={"top_k": 20, "score_threshold": 0.7},
    )

    retrieval_setting = storage_backend.retrieve.call_args.kwargs["retrieval_setting"]
    assert retrieval_setting["score_threshold"] == 0.7


def _retrieve_from_qdrant(retrieval_setting: dict):
    from knowledge_engine.storage.qdrant_backend import QdrantBackend

    with patch("knowledge_engine.storage.qdrant_backend.QdrantClient") as client_class:
        client_class.return_value = MagicMock()
        backend = QdrantBackend({"url": "http://localhost:6333"})

    vector_store = MagicMock()
    vector_store.query.return_value = MagicMock(
        nodes=[TextNode(text="low score chunk", metadata={"source_file": "a.md"})],
        similarities=[0.2],
    )
    backend.create_vector_store = MagicMock(return_value=vector_store)

    embed_model = MagicMock()
    embed_model.get_query_embedding.return_value = [0.1, 0.2]

    return backend.retrieve(
        knowledge_id="kb_1",
        query="release checklist",
        embed_model=embed_model,
        retrieval_setting=retrieval_setting,
    )


def test_qdrant_engine_fallback_does_not_cut_a_low_score() -> None:
    result = _retrieve_from_qdrant({"top_k": 20, "retrieval_mode": "vector"})

    assert [record["score"] for record in result["records"]] == [0.2]


def test_qdrant_engine_fallback_still_cuts_with_an_explicit_threshold() -> None:
    result = _retrieve_from_qdrant(
        {"top_k": 20, "score_threshold": 0.7, "retrieval_mode": "vector"}
    )

    assert result["records"] == []
