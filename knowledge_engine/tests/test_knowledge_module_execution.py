# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Minimal second caller: resolve config with the module, then index and query.

This caller supplies its own authorized resource records and an in-memory
storage backend. It never loads a Wegent product table, a database session or a
task worker, and proves the module public interface is reusable for indexing a
plain document and for a scope-limited query that returns its reference.
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


class _InMemoryStorage:
    """In-memory storage: keeps indexed chunks and returns them on query."""

    supports_retrieval_scope = True

    def __init__(self) -> None:
        self.chunks: list[dict[str, Any]] = []

    def save_parent_nodes(
        self, *, knowledge_id: str, parent_nodes: Any, **kwargs
    ) -> None:
        return None

    def index_with_metadata(
        self, *, nodes: Any, chunk_metadata: Any, embed_model: Any, **kwargs
    ) -> dict[str, Any]:
        for node in nodes:
            self.chunks.append(
                {"content": node.get_content(), "metadata": dict(node.metadata or {})}
            )
        return {
            "indexed_count": len(nodes),
            "index_name": f"kb_{chunk_metadata.knowledge_id}",
            "status": "success",
        }

    def get_supported_retrieval_methods(self) -> list[str]:
        return ["vector"]

    def retrieve(
        self,
        *,
        knowledge_id: str,
        query: str,
        embed_model: Any,
        retrieval_setting: dict[str, Any],
        scope: RetrievalScope | None = None,
        metadata_condition: Any = None,
        **kwargs,
    ) -> dict[str, Any]:
        records: list[dict[str, Any]] = []
        for chunk in self.chunks:
            metadata = chunk["metadata"]
            if metadata.get("knowledge_id") != knowledge_id:
                continue
            if scope is not None and scope.document_ids:
                if int(metadata["doc_ref"]) not in scope.document_ids:
                    continue
            records.append(
                {
                    "content": chunk["content"],
                    "score": 1.0,
                    "title": metadata.get("source_file", ""),
                    "metadata": metadata,
                }
            )
        return {"records": records}


_STORED_CONFIG = {
    "retriever_name": "retriever-a",
    "retriever_namespace": "default",
    "embedding_config": {"model_name": "embed-a", "model_namespace": "default"},
}

_KNOWLEDGE_ID = "7"
_PLAIN_DOCUMENT = b"# Release notes\n\nVerify the release checklist before shipping."


async def _index_plain_document(
    storage: _InMemoryStorage,
    *,
    document_id: int,
) -> dict[str, Any]:
    """Index plain markdown content through the shared execution kernel."""
    from knowledge_engine.services.document_service import DocumentService

    service = DocumentService(storage_backend=storage)
    return await service.index_document_from_binary(
        knowledge_id=_KNOWLEDGE_ID,
        binary_data=_PLAIN_DOCUMENT,
        source_file="release-notes.md",
        file_extension=".md",
        embed_model=object(),
        user_id=7,
        splitter_config=None,
        document_id=document_id,
    )


async def _query_plain_document(
    storage: _InMemoryStorage,
    config: Any,
    scope: RetrievalScope | None = None,
) -> list[dict[str, Any]]:
    from knowledge_engine.query import QueryExecutor

    executor = QueryExecutor(storage_backend=storage, embed_model=object())
    result = await executor.execute(
        knowledge_id=_KNOWLEDGE_ID,
        query="release checklist",
        retrieval_config=config.retrieval_config,
        scope=scope,
        user_id=7,
    )
    return result["records"]


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


@pytest.mark.asyncio
async def test_plain_document_index_then_query_returns_its_reference() -> None:
    """The module public interface indexes plain content and queries it back."""
    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _InMemoryStorage()

    indexed = await _index_plain_document(storage, document_id=42)

    assert indexed["doc_ref"] == "42"
    assert indexed["knowledge_id"] == _KNOWLEDGE_ID
    assert indexed["chunk_count"] >= 1

    records = await _query_plain_document(storage, config)

    assert records
    assert {record["metadata"]["knowledge_id"] for record in records} == {_KNOWLEDGE_ID}
    assert {record["metadata"]["doc_ref"] for record in records} == {"42"}


@pytest.mark.asyncio
async def test_scoped_query_returns_only_the_requested_document() -> None:
    """A document scope keeps the query on the authorized document reference."""
    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _InMemoryStorage()
    await _index_plain_document(storage, document_id=42)
    await _index_plain_document(storage, document_id=43)

    records = await _query_plain_document(
        storage, config, RetrievalScope(document_ids=[43])
    )

    assert records
    assert {record["metadata"]["doc_ref"] for record in records} == {"43"}
    assert {record["metadata"]["knowledge_id"] for record in records} == {_KNOWLEDGE_ID}
