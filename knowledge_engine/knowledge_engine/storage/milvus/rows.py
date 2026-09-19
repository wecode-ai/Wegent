# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reading and shaping stored Milvus rows.

This module owns one concern: turning stored rows back into the document,
chunk and metadata shapes the callers of the storage backend expect. It never
writes and never creates a collection; the index-contract decision stays with
the backend and is injected here so the reader cannot adopt a collection the
contract does not describe. A complete read walks one bounded server iterator
instead of re-applying an offset to an unordered result, so a document or a
total is only ever answered from rows that were really there.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, Sequence

from knowledge_engine.storage.base import MAX_READ_LIMIT
from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus.filters import compile_metadata_conditions
from knowledge_engine.storage.milvus.native import (
    CHUNK_INDEX_KEY,
    CREATED_AT_KEY,
    DISPLAY_TEXT_FIELD,
    DOC_REF_KEY,
    ID_FIELD,
    METADATA_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SOURCE_FILE_KEY,
    build_scope_filter,
)
from knowledge_engine.storage.milvus.store import MilvusDocumentStore

logger = logging.getLogger(__name__)

# Rows one iterator RPC asks for. A complete read walks the server's own primary
# key cursor in batches of this size instead of re-applying an offset to an
# unordered result.
ITERATOR_BATCH_SIZE = 1000


def row_metadata(hit: Dict[str, Any]) -> Dict[str, Any]:
    """The metadata one stored row carries, taken from its own JSON column.

    The row layout keeps a chunk's scope and document fields inside that
    column, so this is the single place a reader looks for them.
    """
    raw = hit.get(METADATA_FIELD)
    if raw is None:
        metadata: Dict[str, Any] = {}
    elif isinstance(raw, dict):
        metadata = dict(raw)
    else:
        raise StorageBackendError(
            "Stored Milvus metadata is not a JSON object.",
            details={"row_id": hit.get(ID_FIELD)},
        )
    if RETRIEVAL_TEXT_FIELD in hit:
        metadata.setdefault(RETRIEVAL_TEXT_FIELD, hit[RETRIEVAL_TEXT_FIELD])
    if DISPLAY_TEXT_FIELD in hit:
        metadata.setdefault(DISPLAY_TEXT_FIELD, hit[DISPLAY_TEXT_FIELD])
    return metadata


def row_chunk_index(hit: Dict[str, Any]) -> int:
    """The chunk position a stored row declares in its metadata."""
    return int(row_metadata(hit).get(CHUNK_INDEX_KEY) or 0)


def close_row_iterator(iterator: Any) -> None:
    """Release an opened row iterator, whatever the read did.

    A read that already produced an answer or an error keeps it: a release that
    fails is recorded and never replaces the result it interrupted.
    """
    try:
        iterator.close()
    except Exception:
        logger.debug("[Milvus] Failed to close the row iterator", exc_info=True)


class MilvusRowReader:
    """Reads stored chunks and documents out of one Milvus collection."""

    def __init__(
        self,
        *,
        store_for: Callable[[], MilvusDocumentStore],
        collection_name_for: Callable[..., str],
        missing_index_for: Callable[..., bool],
    ) -> None:
        self._store_for = store_for
        self._collection_name_for = collection_name_for
        self._missing_index_for = missing_index_for

    def get_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Read the stored chunks of one document in stable order.

        The document is a complete answer, so it is read within the budget or
        the read fails: returning the rows that happened to fit would report a
        smaller chunk count as the document's own.
        """
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
        )
        rows = self._read_bounded_rows(
            collection_name,
            filter_expr,
            budget=MAX_READ_LIMIT,
            what="a complete document",
        )

        if not rows:
            raise ValueError(f"Document {doc_ref} not found")

        # Chunk index first, then the row's own id, so a stored row set keeps
        # one order however the server returns it. Both the chunk index and the
        # document's display fields live in the row's own metadata.
        ordered_rows = sorted(
            rows,
            key=lambda row: (
                row_chunk_index(row),
                str(row.get(ID_FIELD) or ""),
            ),
        )
        chunks = [
            {
                "chunk_index": row_chunk_index(row),
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "metadata": row_metadata(row),
            }
            for row in ordered_rows
        ]
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": row_metadata(ordered_rows[0]).get(SOURCE_FILE_KEY),
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """Aggregate every stored chunk into a page of documents.

        The page is cut from a complete view: documents inside the read budget
        are counted and ordered in full, and a knowledge base whose rows exceed
        the budget fails explicitly instead of reporting the truncated scan as
        its total.
        """
        # Pagination is one-based, so anything below the first page is a caller
        # error: slicing the ordered documents with it would answer a negative
        # page with an arbitrary tail instead of failing.
        if page < 1:
            raise ValueError("page must be at least 1")
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
        rows = self._read_bounded_rows(
            collection_name,
            filter_expr,
            budget=MAX_READ_LIMIT,
            what="a complete document list",
            output_fields=[METADATA_FIELD],
        )

        documents: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            metadata = row_metadata(row)
            doc_ref = metadata.get(DOC_REF_KEY)
            if not doc_ref:
                continue
            document = documents.setdefault(
                doc_ref,
                {
                    "doc_ref": doc_ref,
                    "source_file": metadata.get(SOURCE_FILE_KEY),
                    "chunk_count": 0,
                    "created_at": metadata.get(CREATED_AT_KEY),
                },
            )
            document["chunk_count"] += 1

        # Newest first, with the doc_ref breaking ties so two documents created
        # in the same instant keep one fixed position across pages.
        ordered_documents = sorted(
            documents.values(), key=lambda document: document["doc_ref"]
        )
        ordered_documents.sort(
            key=lambda document: document.get("created_at") or "", reverse=True
        )
        start = (page - 1) * page_size
        return {
            "documents": ordered_documents[start : start + page_size],
            "total": len(ordered_documents),
            "page": page,
            "page_size": page_size,
            "knowledge_id": knowledge_id,
        }

    def get_all_chunks(
        self,
        knowledge_id: str,
        max_chunks: int = MAX_READ_LIMIT,
        metadata_condition: Optional[Dict[str, Any]] = None,
        **kwargs,
    ) -> List[Dict[str, Any]]:
        """Read stored chunks for direct injection in stable order.

        ``max_chunks`` is a ceiling, not a truncation point: a match set that
        exceeds it fails instead of returning the rows that happened to fit, so
        the caller never mistakes a partial listing for the whole one. The
        metadata condition is compiled into the database filter, which means
        the ceiling counts matches instead of counting rows the adapter later
        drops. The reading path owns no separate document scope, so a
        ``doc_ref`` condition may narrow this read; it still cannot leave the
        knowledge base.
        """
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            extra_conditions=compile_metadata_conditions(
                metadata_condition,
                allow_document_scope=True,
            ),
        )
        rows = self._read_bounded_rows(
            collection_name,
            filter_expr,
            budget=min(max_chunks, MAX_READ_LIMIT),
            what="the chunk listing",
        )

        chunks = []
        for row in rows:
            metadata = row_metadata(row)
            chunks.append(
                {
                    "content": row.get(DISPLAY_TEXT_FIELD) or "",
                    "title": metadata.get(SOURCE_FILE_KEY) or "",
                    "chunk_id": row_chunk_index(row),
                    "doc_ref": metadata.get(DOC_REF_KEY) or "",
                    "metadata": metadata,
                }
            )
        chunks.sort(key=lambda chunk: (chunk["doc_ref"], chunk["chunk_id"]))
        return chunks

    def _read_bounded_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        budget: int,
        what: str,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read every matching row through one bounded server iterator.

        A caller that needs the whole picture - a document, or a total - cannot
        be answered from a truncated read, so the iterator is bounded one row
        past the budget and a read that reaches that row fails: the rows that
        fit would report a smaller chunk count or total as the true one. The
        read never creates or adopts a collection.
        """
        store = self._store_for()
        rows: List[Dict[str, Any]] = []
        with store.client() as client:
            if self._missing_index_for(client, collection_name):
                return []
            iterator = store.open_row_iterator(
                client,
                collection_name,
                filter_expr,
                batch_size=ITERATOR_BATCH_SIZE,
                limit=max(budget, 0) + 1,
                output_fields=output_fields,
            )
            try:
                while True:
                    batch = iterator.next()
                    if not batch:
                        return rows
                    rows.extend(batch)
                    if len(rows) > budget:
                        raise StorageBackendError(
                            f"Milvus read exceeded its budget while reading {what}; "
                            "the complete result cannot be returned.",
                            details={
                                "collection_name": collection_name,
                                "budget": budget,
                            },
                        )
            finally:
                close_row_iterator(iterator)
