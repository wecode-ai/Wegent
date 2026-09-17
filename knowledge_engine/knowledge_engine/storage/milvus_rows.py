# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reading and shaping stored Milvus rows.

This module owns one concern: turning stored rows back into the document,
chunk and metadata shapes the callers of the storage backend expect. It never
writes and never creates a collection; the index-contract decision stays with
the backend and is injected here so the reader cannot adopt a collection the
contract does not describe.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, List, Optional, Sequence

from pymilvus import MilvusClient

from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus_filters import compile_metadata_conditions
from knowledge_engine.storage.milvus_native import (
    CHUNK_FIELDS_FOR_FILTERING,
    CHUNK_INDEX_FIELD,
    CREATED_AT_FIELD,
    DISPLAY_TEXT_FIELD,
    DOC_REF_FIELD,
    ID_FIELD,
    METADATA_FIELD,
    RETRIEVAL_TEXT_FIELD,
    SOURCE_FILE_FIELD,
    build_scope_filter,
)
from knowledge_engine.storage.milvus_store import MilvusDocumentStore

MAX_READ_LIMIT = 10000
# Milvus answers one unordered page per request, so a complete read walks
# bounded pages instead of asking for every row in one call.
READ_PAGE_SIZE = 1000
DEFAULT_LIST_PAGE_SIZE = 20


def row_metadata(hit: Dict[str, Any]) -> Dict[str, Any]:
    """Combine a row's JSON metadata with its physical scalar columns."""
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
    for field in CHUNK_FIELDS_FOR_FILTERING:
        if field in hit:
            metadata.setdefault(field, hit[field])
    if RETRIEVAL_TEXT_FIELD in hit:
        metadata.setdefault(RETRIEVAL_TEXT_FIELD, hit[RETRIEVAL_TEXT_FIELD])
    if DISPLAY_TEXT_FIELD in hit:
        metadata.setdefault(DISPLAY_TEXT_FIELD, hit[DISPLAY_TEXT_FIELD])
    return metadata


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
        rows = self._read_all_rows(collection_name, filter_expr)

        if not rows:
            raise ValueError(f"Document {doc_ref} not found")

        # Chunk index first, then the row's own id, so a stored row set keeps
        # one order however the server returns it.
        ordered_rows = sorted(
            rows,
            key=lambda row: (
                int(row.get(CHUNK_INDEX_FIELD) or 0),
                str(row.get(ID_FIELD) or ""),
            ),
        )
        chunks = [
            {
                "chunk_index": int(row.get(CHUNK_INDEX_FIELD) or 0),
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "metadata": row_metadata(row),
            }
            for row in ordered_rows
        ]
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": ordered_rows[0].get(SOURCE_FILE_FIELD),
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
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
        rows = self._read_all_rows(
            collection_name,
            filter_expr,
            output_fields=[
                DOC_REF_FIELD,
                SOURCE_FILE_FIELD,
                CREATED_AT_FIELD,
                CHUNK_INDEX_FIELD,
            ],
        )

        documents: Dict[str, Dict[str, Any]] = {}
        for row in rows:
            doc_ref = row.get(DOC_REF_FIELD)
            if not doc_ref:
                continue
            document = documents.setdefault(
                doc_ref,
                {
                    "doc_ref": doc_ref,
                    "source_file": row.get(SOURCE_FILE_FIELD),
                    "chunk_count": 0,
                    "created_at": row.get(CREATED_AT_FIELD),
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

        ``max_chunks`` is a partial-result request: the caller asked for at most
        that many rows, so the read stops there. The metadata condition is
        compiled into the database filter, which means the cap counts matches
        instead of counting rows the adapter later drops. The reading path owns
        no separate document scope, so a ``doc_ref`` condition may narrow this
        read; it still cannot leave the knowledge base.
        """
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            extra_conditions=compile_metadata_conditions(
                metadata_condition,
                allow_document_scope=True,
            ),
        )
        rows = self._read_rows(collection_name, filter_expr, limit=max_chunks)

        chunks = [
            {
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "title": row.get(SOURCE_FILE_FIELD) or "",
                "chunk_id": int(row.get(CHUNK_INDEX_FIELD) or 0),
                "doc_ref": row.get(DOC_REF_FIELD) or "",
                "metadata": row_metadata(row),
            }
            for row in rows
        ]
        chunks.sort(key=lambda chunk: (chunk["doc_ref"], chunk["chunk_id"]))
        return chunks

    def _read_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        limit: int,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read at most ``limit`` stored rows."""
        store = self._store_for()
        with store.client() as client:
            return self._query_page(
                store,
                client,
                collection_name,
                filter_expr,
                limit=limit,
                output_fields=output_fields,
            )

    def _read_all_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read every matching row, or fail when they exceed the read budget.

        A caller that needs the whole picture - a document, or a total - cannot
        be answered from a truncated page, so one row past the budget is enough
        to fail instead of returning a smaller truth.
        """
        store = self._store_for()
        rows: List[Dict[str, Any]] = []
        with store.client() as client:
            while True:
                requested = min(READ_PAGE_SIZE, MAX_READ_LIMIT + 1 - len(rows))
                page = self._query_page(
                    store,
                    client,
                    collection_name,
                    filter_expr,
                    limit=requested,
                    offset=len(rows),
                    output_fields=output_fields,
                )
                rows.extend(page)
                if len(rows) > MAX_READ_LIMIT:
                    raise StorageBackendError(
                        "Milvus read exceeded the budget; the complete result "
                        "cannot be returned.",
                        details={
                            "collection_name": collection_name,
                            "budget": MAX_READ_LIMIT,
                        },
                    )
                if len(page) < requested:
                    return rows

    def _query_page(
        self,
        store: MilvusDocumentStore,
        client: MilvusClient,
        collection_name: str,
        filter_expr: str,
        *,
        limit: int,
        offset: int = 0,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read one page without ever creating or adopting a collection."""
        if self._missing_index_for(client, collection_name):
            return []
        return store.query_rows(
            client,
            collection_name,
            filter_expr,
            output_fields=output_fields,
            limit=limit,
            offset=offset,
        )
