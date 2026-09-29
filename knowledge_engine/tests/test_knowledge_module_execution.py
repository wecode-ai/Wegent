# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Minimal second caller: resolve config with the module, then query by scope.

This caller supplies its own authorized resource records and an in-memory
storage backend. It never loads a Wegent product table, a database session or a
task worker, and proves the module public interface is reusable for a
scope-limited query.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from shared.knowledge_contracts import RetrievalScope
from shared.knowledge_module import (
    AuthorizedRetrievalResources,
    RetrievalResource,
    resolve_execution_config,
)


class _FakeAdapter:
    """Second-service adapter: only the records it authorizes for this call."""

    def __init__(self) -> None:
        self.retriever = RetrievalResource(
            name="retriever-a", kind="Retriever", namespace="default"
        )
        self.embedding_model = RetrievalResource(
            name="embed-a",
            kind="Model",
            category="embedding",
            namespace="default",
        )

    def authorized(self) -> AuthorizedRetrievalResources:
        return AuthorizedRetrievalResources(
            retriever=self.retriever, embedding_model=self.embedding_model
        )


class _RecordingStorage:
    """In-memory storage backend that records the scope it received."""

    supports_retrieval_scope = True

    def __init__(self) -> None:
        self.calls: list[dict[str, Any]] = []

    def retrieve(self, **kwargs: Any) -> dict[str, Any]:
        self.calls.append(kwargs)
        return {"records": [{"content": "hit", "title": "Doc", "score": 0.9}]}


_STORED_CONFIG = {
    "retriever_name": "retriever-a",
    "retriever_namespace": "default",
    "embedding_config": {"model_name": "embed-a", "model_namespace": "default"},
}


async def _run_query(scope: RetrievalScope | None) -> _RecordingStorage:
    from knowledge_engine.query import QueryExecutor

    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _RecordingStorage()
    executor = QueryExecutor(storage_backend=storage, embed_model=object())
    await executor.execute(
        knowledge_id="1",
        query="policy",
        retrieval_config=config.retrieval_config,
        scope=scope,
        user_id=7,
    )
    return storage


@pytest.mark.asyncio
async def test_whole_knowledge_base_query_has_no_document_filter() -> None:
    storage = await _run_query(None)

    assert storage.calls[0]["scope"] is None
    assert storage.calls[0]["retrieval_setting"]["top_k"] == 20
    assert storage.calls[0]["retrieval_setting"]["score_threshold"] == 0.7


@pytest.mark.asyncio
async def test_document_set_query_is_filtered_to_that_set() -> None:
    storage = await _run_query(RetrievalScope(document_ids=[11, 12]))

    assert storage.calls[0]["scope"] == RetrievalScope(document_ids=[11, 12])


def test_empty_document_set_cannot_become_an_unfiltered_query() -> None:
    with pytest.raises(ValidationError):
        RetrievalScope(document_ids=[])
