# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Each layer keeps its own default for an unconfigured score threshold.

A threshold is a rule about a score scale, and the scale belongs to the
engine, so the layers intentionally disagree: the shared runtime config and
the engine fallbacks use ``0.7`` while the knowledge base schemas and the
frontend prefill use ``0.5``. These tests pin the engine-side half of that
decision and prove an explicitly passed threshold, including ``0``, still
reaches the engine unchanged.
"""

from unittest.mock import MagicMock, patch

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.storage.milvus_backend import MilvusBackend
from shared.models import RuntimeRetrievalConfig


def test_public_model_keeps_the_engine_default() -> None:
    assert RuntimeRetrievalConfig(top_k=20).score_threshold == 0.7
    assert RuntimeRetrievalConfig(top_k=20, score_threshold=0.5).score_threshold == 0.5


def test_shared_models_do_not_export_a_cross_layer_default() -> None:
    import shared.models as shared_models

    assert not hasattr(shared_models, "DEFAULT_SCORE_THRESHOLD")


def test_milvus_engine_fallback_keeps_its_own_default() -> None:
    assert MilvusBackend._resolve_score_threshold({}) == 0.7
    assert MilvusBackend._resolve_score_threshold({"score_threshold": 0.5}) == 0.5
    assert MilvusBackend._resolve_score_threshold({"score_threshold": 0}) == 0.0


@pytest.mark.asyncio
async def test_executor_resolves_an_absent_threshold_to_its_own_default() -> None:
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
    assert retrieval_setting["score_threshold"] == 0.7


@pytest.mark.asyncio
@pytest.mark.parametrize("threshold", [0.0, 0.5, 0.7])
async def test_executor_keeps_an_explicit_threshold_untouched(threshold: float) -> None:
    from knowledge_engine.query import QueryExecutor

    storage_backend = MagicMock()
    storage_backend.retrieve.return_value = {"records": []}
    executor = QueryExecutor(storage_backend=storage_backend, embed_model=object())

    await executor.execute(
        knowledge_id="1",
        query="release checklist",
        retrieval_config={"top_k": 20, "score_threshold": threshold},
    )

    retrieval_setting = storage_backend.retrieve.call_args.kwargs["retrieval_setting"]
    assert retrieval_setting["score_threshold"] == threshold


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


def test_qdrant_engine_fallback_cuts_with_its_own_default() -> None:
    result = _retrieve_from_qdrant({"top_k": 20, "retrieval_mode": "vector"})

    assert result["records"] == []


def test_qdrant_engine_keeps_a_low_score_when_zero_is_explicit() -> None:
    result = _retrieve_from_qdrant(
        {"top_k": 20, "score_threshold": 0, "retrieval_mode": "vector"}
    )

    assert [record["score"] for record in result["records"]] == [0.2]
