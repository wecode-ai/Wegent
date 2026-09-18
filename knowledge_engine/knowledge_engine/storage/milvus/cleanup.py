# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Removing stored Milvus data: documents, knowledge bases and indexes.

This module owns one concern: taking stored data away again. It shares the
index contract with the write path, so it never deletes from a collection
whose contract it cannot confirm, and it keeps the parent sidecar out of the
retrieval contract. A delete is proven by its own RPC: the count it reports is
the one the server returned, and no read-back or extra client re-verifies it.
"""

from __future__ import annotations

from typing import Any, Callable, Dict

from knowledge_engine.storage.errors import IndexMissingError
from knowledge_engine.storage.milvus.native import build_scope_filter
from knowledge_engine.storage.milvus.store import MilvusDocumentStore


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
    ) -> int:
        """Remove every stored row of one document.

        This is the delete entry point's removal: rows are keyed by knowledge
        base, document and chunk index, so without this the previous version of
        a document that got shorter stays readable next to the new one. The
        scope is one knowledge base and one document, so a shared physical
        collection keeps every other document.

        Every row of the document is removed, not only the ones this code knows
        about: two writers of the same document are not coordinated, so a
        writer still in flight when a delete starts loses the rows it already
        wrote and the last writer wins. That window is accepted here, and only
        the normal ordered flow is promised.

        A removal whose RPC fails raises, and the count reported is the one the
        delete RPC returned: nothing counts the rows first and nothing reads
        them back to prove the delete afterwards.
        """
        filter_expr = build_scope_filter(
            knowledge_id=knowledge_id,
            doc_refs=[doc_ref],
        )
        return self._delete_rows(collection_name, filter_expr)

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
        deleted_chunks = self._delete_rows(collection_name, scope_filter)
        deleted_parent_nodes = self._delete_rows(
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
            # The contract read answers both the existence and the ownership of
            # the index collection in one lookup, exactly as the write path
            # confirms it.
            index_exists = store.read_contract(client, collection_name) is not None
            parent_exists = store.has_collection(client, parent_collection_name)
            if index_exists:
                client.drop_collection(
                    collection_name=collection_name, timeout=store.rpc_timeout
                )
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

    def _delete_rows(
        self,
        collection_name: str,
        filter_expr: str,
        *,
        require_bound: bool = True,
    ) -> int:
        """Delete the matching rows on one client and report the RPC's count.

        A bound collection is only mutated through the contract it declares
        about itself; the parent sidecar declares none, so it is only checked
        for existence. An absent collection is an idempotent no-op.
        """
        store = self._store_for()
        with store.client() as client:
            if require_bound:
                if store.read_contract(client, collection_name) is None:
                    return 0
            elif not store.has_collection(client, collection_name):
                return 0
            return store.delete_rows(client, collection_name, filter_expr)
