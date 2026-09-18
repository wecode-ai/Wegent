# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Removing stored Milvus data: documents, knowledge bases and indexes.

This module owns one concern: taking stored data away again and proving it
is gone. It shares the index contract with the write path, so it never drops a
collection whose contract it cannot confirm, and it keeps the parent sidecar
out of the retrieval contract.
"""

from __future__ import annotations

from typing import Any, Callable, Dict

from knowledge_engine.storage.errors import IndexMissingError, StorageBackendError
from knowledge_engine.storage.milvus_native import build_scope_filter
from knowledge_engine.storage.milvus_store import MilvusDocumentStore


class MilvusCleanup:
    """Deletes Milvus rows and physically drops dedicated collections."""

    def __init__(
        self,
        *,
        store_for: Callable[[], MilvusDocumentStore],
        collection_name_for: Callable[..., str],
        parent_collection_name_for: Callable[..., str],
        parent_scope_filter: Callable[[str], str],
        parent_delete: Callable[..., Any],
        ensure_can_drop_physical_index: Callable[[], None],
    ) -> None:
        self._store_for = store_for
        self._collection_name_for = collection_name_for
        self._parent_collection_name_for = parent_collection_name_for
        self._parent_scope_filter = parent_scope_filter
        self._parent_delete = parent_delete
        self._ensure_can_drop_physical_index = ensure_can_drop_physical_index

    def delete_document(self, knowledge_id: str, doc_ref: str, **kwargs) -> Dict:
        """Delete one document; a missing document is an idempotent no-op."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        deleted_chunks = self.clear_document_rows(
            collection_name, knowledge_id, doc_ref
        )
        self._parent_delete(knowledge_id, doc_ref, **kwargs)
        return {
            "doc_ref": doc_ref,
            "knowledge_id": knowledge_id,
            "deleted_chunks": deleted_chunks,
            "status": "deleted",
        }

    def clear_document_rows(
        self,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
        *,
        require_bound: bool = True,
        flush: bool = True,
    ) -> int:
        """Remove every stored row of one document and prove it is gone.

        This is the write path's own replacement step: a rewrite calls it once
        before it writes the new version, and the write path is the only owner
        of that removal. Rows are keyed by knowledge base, document and chunk
        index, so without this the previous version of a document that got
        shorter stays readable next to the new one. The scope is one knowledge
        base and one document, so a shared physical collection keeps every other
        document.

        Every row of the document is removed, not only the ones this write
        knows about: two writers of the same document are not coordinated, so a
        writer still in flight when a rewrite starts loses the rows it already
        wrote and the last writer wins. The parity spec accepts that window and
        promises the normal ordered flow only.

        A removal that cannot prove itself raises, and the caller's write stops
        there: nothing compensates a failed write afterwards, so the retry of
        the same document is what clears rows a previous attempt left behind.

        ``require_bound`` is False for the write path, which confirmed the
        index contract of this collection earlier in the same write.
        ``flush`` is False there too: the write path proves the removal with a
        Strong consistency read and must not seal the segment on every
        rewrite, while the delete entry point keeps flushing.
        """
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
        )
        return self._delete_verified(
            collection_name,
            filter_expr,
            require_bound=require_bound,
            flush=flush,
        )

    def delete_knowledge(self, knowledge_id: str, **kwargs) -> Dict:
        """Delete every chunk and parent node of one knowledge base.

        The two collections carry the knowledge base in different places - the
        index in its metadata JSON column, the sidecar in its own top-level
        field - so each one is addressed with the scope shape it stores.
        """
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        parent_collection_name = self._parent_collection_name_for(
            knowledge_id, **kwargs
        )
        scope_filter = build_scope_filter(knowledge_id=knowledge_id)
        deleted_chunks = self._delete_verified(collection_name, scope_filter)
        deleted_parent_nodes = self._delete_verified(
            parent_collection_name,
            self._parent_scope_filter(knowledge_id),
            require_bound=False,
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
            parent_exists = store.has_collection(client, parent_collection_name)
            if collection_exists:
                # A physical drop goes through the contract the collection
                # declares about itself, exactly as the write path confirms it.
                store.read_contract(client, collection_name)
            elif parent_exists:
                # The knowledge base still holds parents but its index
                # collection is gone, so nothing confirms that these names were
                # ours: refuse instead of dropping data through a name that no
                # contract accounts for.
                raise IndexMissingError(
                    collection_name,
                    "the index collection is gone, so the parent sidecar of "
                    "this knowledge base cannot be identified as its own",
                )
            if collection_exists:
                client.drop_collection(
                    collection_name=collection_name, timeout=store.rpc_timeout
                )
            if parent_exists:
                client.drop_collection(
                    collection_name=parent_collection_name, timeout=store.rpc_timeout
                )
                dropped_parent_collection = True

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
        flush: bool = True,
    ) -> int:
        store = self._store_for()
        with store.client() as client:
            if not store.has_collection(client, collection_name):
                return 0
            if require_bound:
                # A collection is only mutated through the contract it declares
                # about itself; the parent sidecar declares none and is exempt.
                store.read_contract(client, collection_name)
            deleted = store.count_rows(client, collection_name, filter_expr)
            if not deleted:
                return 0
            store.delete_rows(client, collection_name, filter_expr, flush=flush)
        with store.client() as reader:
            remaining = store.count_rows(reader, collection_name, filter_expr)
        if remaining:
            raise StorageBackendError(
                f"Milvus delete verification failed: {remaining} rows remain.",
                details={"collection_name": collection_name, "remaining": remaining},
            )
        return deleted
