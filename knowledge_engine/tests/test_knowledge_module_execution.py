# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Minimal second caller: resolve config, convert and index with the module.

This caller supplies its own authorized resource records, its own conversion
engine and an in-memory storage backend. It never loads a Wegent product table,
a database session or a task worker, and proves the module public interface is
reusable for converting a document, indexing its content, and for a
scope-limited query that returns its reference.
"""

from __future__ import annotations

from typing import Any

import pytest
from pydantic import ValidationError

from shared.knowledge_contracts import RetrievalScope
from shared.knowledge_module import (
    AuthorizedRetrievalResources,
    ConversionEngineResult,
    ConversionRequest,
    DocumentIndexRequest,
    QueryTarget,
    RetrievalResource,
    build_document_delete_request,
    convert_content,
    delete_document,
    index_document,
    manage_index,
    query_documents,
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

    def delete_document(self, *, knowledge_id: str, doc_ref: str, **kwargs) -> dict:
        """Drop every chunk this caller indexed under one document reference."""
        kept = [
            chunk
            for chunk in self.chunks
            if not (
                chunk["metadata"].get("knowledge_id") == knowledge_id
                and chunk["metadata"].get("doc_ref") == doc_ref
            )
        ]
        deleted = len(self.chunks) - len(kept)
        self.chunks = kept
        return {
            "knowledge_id": knowledge_id,
            "doc_ref": doc_ref,
            "deleted_chunks": deleted,
            "status": "deleted",
        }

    def get_all_chunks(self, *, knowledge_id, **kwargs):
        return [
            {
                "content": chunk["content"],
                "metadata": chunk["metadata"],
                "doc_ref": chunk["metadata"]["doc_ref"],
            }
            for chunk in self.chunks
            if chunk["metadata"].get("knowledge_id") == knowledge_id
        ]

    def extract_chunk_text(self, content):
        return content

    def delete_knowledge(self, *, knowledge_id, **kwargs):
        before = len(self.chunks)
        self.chunks = [
            chunk
            for chunk in self.chunks
            if chunk["metadata"].get("knowledge_id") != knowledge_id
        ]
        return {"deleted_chunks": before - len(self.chunks)}

    def drop_knowledge_index(self, *, knowledge_id, **kwargs):
        self.delete_knowledge(knowledge_id=knowledge_id)
        return {"status": "dropped"}

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
_CONVERTED_DOCUMENT = b"# Converted report\n\nChecklist marker: converted body."


class _EngineDocumentIndexAdapter:
    """Second-service adapter: the module identity, this side's index engine."""

    def __init__(self, storage: "_InMemoryStorage") -> None:
        from knowledge_engine.services.document_service import DocumentService

        self._service = DocumentService(storage_backend=storage)

    async def index_chunks(self, *, metadata, request: DocumentIndexRequest):
        return await self._service.index_with_metadata(
            metadata=metadata,
            binary_data=request.binary_data,
            file_extension=request.file_extension,
            embed_model=object(),
            user_id=request.user_id,
            splitter_config=request.splitter_config,
        )

    async def delete_document(self, *, request):
        return await self._service.delete_document(
            knowledge_id=request.knowledge_id,
            doc_ref=request.doc_ref,
            user_id=request.user_id,
        )


class _MarkdownConversionAdapter:
    """Second-service adapter: supplies the conversion engine and its formats."""

    supported = ("pdf", "docx")

    def supports_conversion(self, extension: str) -> bool:
        return extension in self.supported

    def convert(self, *, binary_data: bytes, extension: str, storage_prefix: str):
        assert binary_data
        assert storage_prefix.startswith("doc-converter/")
        return ConversionEngineResult(markdown_bytes=_CONVERTED_DOCUMENT)


async def _index_plain_document(
    storage: _InMemoryStorage,
    *,
    document_id: int,
) -> dict[str, Any]:
    """Index plain markdown content through the module public interface."""
    return await index_document(
        _EngineDocumentIndexAdapter(storage),
        DocumentIndexRequest(
            knowledge_id=_KNOWLEDGE_ID,
            binary_data=_PLAIN_DOCUMENT,
            source_file="release-notes.md",
            file_extension=".md",
            user_id=7,
            document_id=document_id,
        ),
    )


async def _convert_and_index_document(
    storage: _InMemoryStorage,
    *,
    document_id: int,
) -> dict[str, Any]:
    """Convert a PDF source and index the converted body through the module."""
    converted = convert_content(
        _MarkdownConversionAdapter(),
        ConversionRequest(
            binary_data=b"%PDF-1.7 source",
            file_extension=".pdf",
            original_filename="converted-report.pdf",
            knowledge_base_name="Handbook",
            document_id=document_id,
        ),
    )
    assert converted.markdown_bytes == _CONVERTED_DOCUMENT

    return await index_document(
        _EngineDocumentIndexAdapter(storage),
        DocumentIndexRequest(
            knowledge_id=_KNOWLEDGE_ID,
            binary_data=converted.markdown_bytes,
            source_file=converted.converted_name,
            file_extension=".md",
            user_id=7,
            document_id=document_id,
        ),
    )


async def _query_plain_document(
    storage: _InMemoryStorage,
    config: Any,
    scope: RetrievalScope | None = None,
) -> list[dict[str, Any]]:
    from knowledge_engine.query import QueryExecutor

    executor = QueryExecutor(storage_backend=storage, embed_model=object())
    result = await query_documents(
        [
            QueryTarget(
                executor,
                _KNOWLEDGE_ID,
                config.retrieval_config,
                7,
                document_ids=scope.document_ids if scope is not None else None,
            )
        ],
        query="release checklist",
    )
    return result["records"]


async def _delete_indexed_document(
    storage: _InMemoryStorage,
    *,
    document_id: int,
) -> dict[str, Any]:
    """Remove an indexed document through the module public interface."""
    return await delete_document(
        _EngineDocumentIndexAdapter(storage),
        build_document_delete_request(
            knowledge_id=_KNOWLEDGE_ID, doc_ref=document_id, user_id=7
        ),
    )


async def _run_query(scope: RetrievalScope | None) -> _RecordingStorage:
    from knowledge_engine.query import QueryExecutor

    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _RecordingStorage()
    executor = QueryExecutor(storage_backend=storage, embed_model=object())
    await query_documents(
        [
            QueryTarget(
                executor,
                "1",
                config.retrieval_config,
                7,
                document_ids=scope.document_ids if scope is not None else None,
            )
        ],
        query="policy",
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


@pytest.mark.asyncio
async def test_deleted_document_disappears_from_the_query() -> None:
    """Deleting through the module drops only that document's references."""
    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _InMemoryStorage()
    await _index_plain_document(storage, document_id=42)
    await _index_plain_document(storage, document_id=43)

    deleted = await _delete_indexed_document(storage, document_id=42)

    assert deleted["doc_ref"] == "42"
    assert deleted["knowledge_id"] == _KNOWLEDGE_ID
    assert deleted["deleted_chunks"] >= 1
    remaining = await _query_plain_document(storage, config)
    assert {record["metadata"]["doc_ref"] for record in remaining} == {"43"}

    repeated = await _delete_indexed_document(storage, document_id=42)
    assert repeated["deleted_chunks"] == 0
    assert repeated["status"] == "deleted"


@pytest.mark.asyncio
async def test_converted_document_reuses_the_module_index_and_query_path() -> None:
    """Conversion output enters the same index and scoped query as plain text."""
    adapter = _FakeAdapter()
    config = resolve_execution_config(_STORED_CONFIG, adapter.authorized())
    storage = _InMemoryStorage()

    indexed = await _convert_and_index_document(storage, document_id=51)

    assert indexed["doc_ref"] == "51"
    assert indexed["source_file"] == "converted-report.pdf.md"
    assert indexed["knowledge_id"] == _KNOWLEDGE_ID

    records = await _query_plain_document(
        storage, config, RetrievalScope(document_ids=[51])
    )

    assert records
    assert {record["metadata"]["doc_ref"] for record in records} == {"51"}
    assert "converted body" in records[0]["content"]


@pytest.mark.asyncio
async def test_second_caller_manages_the_same_index_through_public_interface():
    storage = _InMemoryStorage()
    config = resolve_execution_config(_STORED_CONFIG, _FakeAdapter().authorized())
    await _index_plain_document(storage, document_id=701)
    listed = await manage_index(
        storage, operation="list_chunks", knowledge_id=_KNOWLEDGE_ID, user_id=7
    )
    assert listed["total"] > 0
    assert {chunk["doc_ref"] for chunk in listed["chunks"]} == {"701"}
    purged = await manage_index(
        storage, operation="purge", knowledge_id=_KNOWLEDGE_ID, user_id=7
    )
    assert purged["deleted_chunks"] == listed["total"]
    assert await _query_plain_document(storage, config, scope=None) == []
    await _index_plain_document(storage, document_id=702)
    assert await manage_index(
        storage, operation="drop", knowledge_id=_KNOWLEDGE_ID, user_id=7
    ) == {"status": "dropped"}
    assert await _query_plain_document(storage, config, scope=None) == []
