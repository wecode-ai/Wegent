# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""The indexing layer writes one document once and deletes nothing itself.

Precondition: the business indexing and rebuild entries hold the document lock
(``knowledge:index_document:{document_id}``) around one write per document, so
the same document is replaced by one task at a time. MilvusBackend owns the
removal of the document's previous rows inside that write; this layer neither
deletes them before the call nor compensates a failed write afterwards.

The tests drive the seam the business entries use - ``DocumentIndexer`` into
``BaseStorageBackend.index_with_metadata`` - with the storage backend faked, so
the calls this layer makes around one document are what they observe.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.errors import StorageBackendError

SPLITTER_CONFIG = {
    "chunk_strategy": "flat",
    "format_enhancement": "file_aware",
    "flat_config": {
        "chunk_size": 1024,
        "chunk_overlap": 50,
        "separator": "\n\n",
    },
}


class FakeStorageBackend:
    """Records the storage calls one indexed document makes."""

    def __init__(self, *results, parent_result=None) -> None:
        self.results = list(results)
        self.parent_result = parent_result
        self.calls: list[str] = []

    def index_with_metadata(self, **kwargs):
        self.calls.append("index_with_metadata")
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result

    def save_parent_nodes(self, **kwargs):
        self.calls.append("save_parent_nodes")
        if isinstance(self.parent_result, Exception):
            raise self.parent_result
        return {"stored_count": len(kwargs["parent_nodes"])}


def _indexer(storage_backend: FakeStorageBackend) -> DocumentIndexer:
    return DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=object(),
        splitter_config=SPLITTER_CONFIG,
        file_extension=".txt",
    )


def _index_one_document(indexer: DocumentIndexer) -> dict:
    return indexer.index_from_binary(
        binary_data=b"first paragraph\n\nsecond paragraph",
        file_extension=".txt",
        chunk_metadata=ChunkMetadata(
            knowledge_id="1",
            doc_ref="42",
            source_file="doc.txt",
            created_at="2026-01-01T00:00:00Z",
        ),
        user_id=7,
    )


def test_one_document_is_written_with_a_single_call_and_no_delete():
    """The indexing layer replaces a document by writing it once.

    The replacement of the previous version is the storage backend's own step,
    so a layer that deleted the document's rows here would delete them twice -
    and a retry after a failed write would have nothing left to replace.
    """
    storage_backend = FakeStorageBackend(
        {"indexed_count": 2, "index_name": "wegent_kb_1", "status": "success"}
    )

    result = _index_one_document(_indexer(storage_backend))

    assert result["indexed_count"] == 2
    assert storage_backend.calls == ["index_with_metadata"]


def test_a_retry_repeats_the_same_single_write():
    """A failed task is retried by writing the same document again.

    The write removes the previous rows itself, so the retry needs no delete of
    its own - including for rows a failed attempt may have left behind.
    """
    storage_backend = FakeStorageBackend(
        StorageBackendError("simulated write failure"),
        {"indexed_count": 2, "index_name": "wegent_kb_1", "status": "success"},
    )
    indexer = _indexer(storage_backend)

    with pytest.raises(StorageBackendError):
        _index_one_document(indexer)

    assert _index_one_document(indexer)["indexed_count"] == 2
    assert storage_backend.calls == ["index_with_metadata", "index_with_metadata"]


def _use_hierarchical_ingestion(monkeypatch) -> None:
    """Replace the splitter with one parent and one child node."""
    import knowledge_engine.index.indexer as indexer_module

    monkeypatch.setattr(
        indexer_module,
        "build_ingestion_result",
        lambda **kwargs: SimpleNamespace(
            parser_subtype="text",
            parent_nodes=[TextNode(text="parent body")],
            index_nodes=[TextNode(text="child body")],
        ),
    )


def test_parent_nodes_are_saved_after_the_child_rows(monkeypatch):
    """The parent sidecar only serves the child rows, so it is written second."""
    _use_hierarchical_ingestion(monkeypatch)
    storage_backend = FakeStorageBackend(
        {"indexed_count": 1, "index_name": "wegent_kb_1", "status": "success"}
    )

    _index_one_document(_indexer(storage_backend))

    assert storage_backend.calls == ["index_with_metadata", "save_parent_nodes"]


def test_a_failed_parent_write_fails_the_task_after_the_child_rows(monkeypatch):
    """A parent failure has no compensating delete; the retry owns recovery."""
    _use_hierarchical_ingestion(monkeypatch)
    storage_backend = FakeStorageBackend(
        {"indexed_count": 1, "index_name": "wegent_kb_1", "status": "success"},
        parent_result=StorageBackendError("simulated parent write failure"),
    )

    with pytest.raises(StorageBackendError):
        _index_one_document(_indexer(storage_backend))

    assert storage_backend.calls == ["index_with_metadata", "save_parent_nodes"]
