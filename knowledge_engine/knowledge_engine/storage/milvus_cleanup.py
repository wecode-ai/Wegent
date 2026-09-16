# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Removing published Milvus data: documents, knowledge bases and indexes.

This module owns one concern: taking published data away again and proving it
is gone. It shares the index contract with the write path, so it never drops a
collection whose contract it cannot confirm, and it keeps the parent sidecar
out of the retrieval contract.
"""

from __future__ import annotations

from typing import Any, Callable, Dict

from pymilvus import MilvusClient

from knowledge_engine.storage.errors import StorageBackendError
from knowledge_engine.storage.milvus_native import (
    INDEX_BINDING_COLLECTION,
    MilvusDocumentStore,
    build_scope_filter,
    sanitize_filter_value,
)


class MilvusCleanup:
    """Deletes Milvus rows and physically drops dedicated collections."""

    def __init__(
        self,
        *,
        store_for: Callable[[], MilvusDocumentStore],
        collection_name_for: Callable[..., str],
        parent_collection_name_for: Callable[..., str],
        parent_delete: Callable[..., Any],
        ensure_can_drop_physical_index: Callable[[], None],
    ) -> None:
        self._store_for = store_for
        self._collection_name_for = collection_name_for
        self._parent_collection_name_for = parent_collection_name_for
        self._parent_delete = parent_delete
        self._ensure_can_drop_physical_index = ensure_can_drop_physical_index

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Delete one document; a missing document is an idempotent no-op."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
            published=False,
        )
        deleted_chunks = self._delete_verified(collection_name, filter_expr)
        self._parent_delete(knowledge_id, doc_ref, **kwargs)
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "status": "deleted",
        }

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete every chunk and parent node of one knowledge base."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        parent_collection_name = self._parent_collection_name_for(
            knowledge_id, **kwargs
        )
        scope_filter = build_scope_filter(knowledge_id=knowledge_id, published=False)
        deleted_chunks = self._delete_verified(collection_name, scope_filter)
        deleted_parent_nodes = self._delete_verified(
            parent_collection_name, scope_filter, require_bound=False
        )
        return {
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "deleted_parent_nodes": deleted_parent_nodes,
            "status": "deleted",
        }

    def drop_knowledge_index(self, knowledge_id: str, **kwargs) -> Dict:
        """Physically drop the backing collection for a dedicated KB strategy."""
        self._ensure_can_drop_physical_index()
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        parent_collection_name = self._parent_collection_name_for(
            knowledge_id, **kwargs
        )
        dropped_parent_collection = False
        store = self._store_for()

        with store.client() as client:
            collection_exists = store.has_collection(client, collection_name)
            if collection_exists:
                store.require_bound(client, collection_name)
            parent_exists = store.has_collection(client, parent_collection_name)
            if collection_exists:
                client.drop_collection(collection_name=collection_name)
            if parent_exists:
                client.drop_collection(collection_name=parent_collection_name)
                dropped_parent_collection = True
            self._drop_binding(client, collection_name)

        return {
            "knowledge_id": knowledge_id,
            "collection_name": collection_name,
            "dropped_parent_collection": dropped_parent_collection,
            "status": "dropped",
        }

    def _delete_verified(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        require_bound: bool = True,
    ) -> int:
        store = self._store_for()
        with store.client() as client:
            if not store.has_collection(client, collection_name):
                return 0
            if require_bound:
                # The parent sidecar is not part of the retrieval contract.
                store.require_bound(client, collection_name)
            deleted = store.count_rows(client, collection_name, filter_expr)
            store.delete_rows(client, collection_name, filter_expr)
        with store.client() as reader:
            remaining = store.count_rows(reader, collection_name, filter_expr)
        if remaining:
            raise StorageBackendError(
                f"Milvus delete verification failed: {remaining} rows remain.",
                details={"collection_name": collection_name, "remaining": remaining},
            )
        return deleted

    @staticmethod
    def _drop_binding(client: MilvusClient, collection_name: str) -> None:
        if not client.has_collection(INDEX_BINDING_COLLECTION):
            return
        client.delete(
            collection_name=INDEX_BINDING_COLLECTION,
            filter=(f'collection_name == "{sanitize_filter_value(collection_name)}"'),
        )
        client.flush(INDEX_BINDING_COLLECTION)
