# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Reading and shaping published Milvus rows.

This module owns one concern: turning stored rows back into the document,
chunk and metadata shapes the callers of the storage backend expect. It never
writes and never creates a collection; the index-contract decision stays with
the backend and is injected here so the reader cannot adopt a collection the
contract does not describe.
"""

from __future__ import annotations

import logging
from typing import Any, Callable, Dict, List, Optional, Sequence

from knowledge_engine.retrieval.filters import filter_chunk_records
from knowledge_engine.storage.errors import StorageBackendError
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
    MilvusDocumentStore,
    build_scope_filter,
)

logger = logging.getLogger(__name__)

MAX_READ_LIMIT = 10000
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
    """Reads published chunks and documents out of one Milvus collection."""

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
        """Read the published chunks of one document in stable order."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
        )
        rows = self._read_rows(collection_name, filter_expr, limit=MAX_READ_LIMIT)

        if not rows:
            raise ValueError(f"Document {doc_ref} not found")

        chunks = [
            {
                "chunk_index": int(row.get(CHUNK_INDEX_FIELD) or 0),
                "content": row.get(DISPLAY_TEXT_FIELD) or "",
                "metadata": row_metadata(row),
            }
            for row in rows
        ]
        chunks.sort(key=lambda chunk: chunk["chunk_index"])
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "source_file": rows[0].get(SOURCE_FILE_FIELD),
            "chunk_count": len(chunks),
            "chunks": chunks,
        }

    def list_documents(
        self, knowledge_id: str, page: int = 1, page_size: int = 20, **kwargs
    ) -> Dict:
        """Aggregate published chunks into a page of documents."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
        rows = self._read_rows(
            collection_name,
            filter_expr,
            output_fields=[
                DOC_REF_FIELD,
                SOURCE_FILE_FIELD,
                CREATED_AT_FIELD,
                CHUNK_INDEX_FIELD,
            ],
            limit=MAX_READ_LIMIT,
        )

        if len(rows) >= MAX_READ_LIMIT:
            logger.warning(
                "[Milvus] Knowledge base %s has >= %d chunks; document listing "
                "may be incomplete.",
                knowledge_id,
                MAX_READ_LIMIT,
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

        ordered = sorted(
            documents.values(),
            key=lambda document: document.get("created_at") or "",
            reverse=True,
        )
        start = (page - 1) * page_size
        return {
            "documents": ordered[start : start + page_size],
            "total": len(ordered),
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
        """Read published chunks for direct injection in stable order."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(knowledge_id=knowledge_id)
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
        filtered = filter_chunk_records(chunks, metadata_condition)
        return filtered[:max_chunks]

    def _read_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        limit: int,
        output_fields: Optional[Sequence[str]] = None,
    ) -> List[Dict[str, Any]]:
        """Read published rows without ever creating or adopting a collection."""
        store = self._store_for()
        with store.client() as client:
            if self._missing_index_for(client, collection_name):
                return []
            return store.query_rows(
                client,
                collection_name,
                filter_expr,
                output_fields=output_fields,
                limit=limit,
            )
