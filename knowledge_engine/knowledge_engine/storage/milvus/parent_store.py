# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Milvus sidecar storage for hierarchical parent nodes.

Parent nodes are a separate physical store from the retrieval index: they are
never embedded or searched, so they live outside the index contract and are
addressed by document reference only. Keeping them in their own module keeps
the retrieval backend focused on the write lifecycle.
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable, Dict, List

from llama_index.core.schema import BaseNode

from knowledge_engine.storage.milvus.native import sanitize_filter_value
from knowledge_engine.storage.milvus.store import MilvusDocumentStore

logger = logging.getLogger(__name__)

PARENT_STORE_VECTOR_DIM = 2
PARENT_NODE_ID_FIELD = "parent_node_id"
# The sidecar's own scope fields: it carries them as top-level fields of its
# dynamic schema, not inside the retrieval index's metadata column.
PARENT_KNOWLEDGE_ID_FIELD = "knowledge_id"
PARENT_DOC_REF_FIELD = "doc_ref"


def _reference_parts(reference: Any) -> tuple[str, str]:
    """Read one ``(doc_ref, parent_node_id)`` reference, refusing other shapes."""
    if not isinstance(reference, (tuple, list)) or len(reference) != 2:
        raise ValueError("parent_refs must contain (doc_ref, parent_node_id) pairs.")
    return str(reference[0] or ""), str(reference[1] or "")


class MilvusParentStore:
    """Stores and loads parent chunks for hierarchical retrieval."""

    def __init__(
        self,
        *,
        store: MilvusDocumentStore,
        collection_name_for: Callable[..., str],
        display_text_for: Callable[[BaseNode], str],
    ) -> None:
        self._store = store
        self._collection_name_for = collection_name_for
        self._display_text_for = display_text_for

    @staticmethod
    def scope_filter(knowledge_id: str, doc_ref: str | None = None) -> str:
        """Compile the scope of this sidecar in its own vocabulary.

        The retrieval index names its knowledge base and document inside the
        metadata JSON column; this sidecar keeps them as its own top-level
        fields and never carries that column, so it compiles its scope from
        those names instead. The deletion path of the backend shares this
        filter, which is what keeps one knowledge base's sidecar rows from
        being addressed with the index's scope shape.
        """
        conditions = [
            f'{PARENT_KNOWLEDGE_ID_FIELD} == "{sanitize_filter_value(knowledge_id)}"'
        ]
        if doc_ref is not None:
            conditions.append(
                f'{PARENT_DOC_REF_FIELD} in ["{sanitize_filter_value(doc_ref)}"]'
            )
        return " and ".join(conditions)

    def save(
        self,
        knowledge_id: str,
        parent_nodes: List[BaseNode],
        **kwargs,
    ) -> Dict[str, Any]:
        """Persist parent nodes for later expansion of child hits."""
        if not parent_nodes:
            return {"stored_count": 0}

        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        store = self._store
        with store.client() as client:
            if not client.has_collection(collection_name, timeout=store.rpc_timeout):
                client.create_collection(
                    collection_name=collection_name,
                    # Milvus requires a dimension of at least 2; this sidecar
                    # placeholder vector is never searched.
                    dimension=PARENT_STORE_VECTOR_DIM,
                    auto_id=True,
                    enable_dynamic_field=True,
                    timeout=store.rpc_timeout,
                )
            else:
                # The lookup above already settled existence, so the removal of
                # the document's previous parents costs no second check.
                self._delete_with_client(
                    store,
                    client,
                    collection_name,
                    knowledge_id,
                    parent_nodes[0].metadata.get("doc_ref", ""),
                )

            client.insert(
                collection_name=collection_name,
                data=[
                    {
                        "vector": [0.0] * PARENT_STORE_VECTOR_DIM,
                        PARENT_NODE_ID_FIELD: node.node_id,
                        PARENT_KNOWLEDGE_ID_FIELD: knowledge_id,
                        PARENT_DOC_REF_FIELD: node.metadata.get("doc_ref"),
                        "source_file": node.metadata.get("source_file"),
                        "content": self._display_text_for(node),
                        "title": node.metadata.get("source_file", ""),
                        "metadata_json": json.dumps(node.metadata),
                    }
                    for node in parent_nodes
                ],
                timeout=store.rpc_timeout,
            )
        return {"stored_count": len(parent_nodes)}

    def get(
        self,
        knowledge_id: str,
        parent_node_ids: List[str],
        **kwargs,
    ) -> Dict[str, Dict[str, Any]]:
        """Load the parent bodies of the document-scoped references asked for.

        A parent node id is only unique inside the document that stored it, so
        the read serves the ``(doc_ref, parent_node_id)`` pairs the caller
        declared and matches both halves in one query. A pair whose id maps to
        more than one document in the same request is ambiguous and is left
        out instead of being answered from whichever document matched, and a
        request that declares no pair expands nothing rather than reading by
        id alone.
        """
        if not parent_node_ids:
            return {}

        pairs = self._resolve_pairs(parent_node_ids, kwargs.get("parent_refs"))
        if not pairs:
            logger.warning(
                "[Milvus] Parent read without document-scoped references is "
                "not expanded: knowledge_id=%s, parent_node_ids=%d",
                knowledge_id,
                len(parent_node_ids),
            )
            return {}

        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        store = self._store
        with store.client() as client:
            if not client.has_collection(collection_name, timeout=store.rpc_timeout):
                return {}

            results = client.query(
                collection_name=collection_name,
                filter=self._pair_filter(knowledge_id, pairs),
                output_fields=[
                    PARENT_NODE_ID_FIELD,
                    PARENT_DOC_REF_FIELD,
                    "content",
                    "title",
                    "metadata_json",
                ],
                limit=len(pairs),
                timeout=store.rpc_timeout,
            )

        allowed = set(pairs)
        parent_records: Dict[str, Dict[str, Any]] = {}
        for record in results:
            reference = (
                str(record.get(PARENT_DOC_REF_FIELD) or ""),
                str(record.get(PARENT_NODE_ID_FIELD) or ""),
            )
            if reference not in allowed:
                continue
            parent_records[reference[1]] = {
                "content": record.get("content", ""),
                "title": record.get("title", ""),
                "metadata": json.loads(record.get("metadata_json") or "{}"),
            }
        return parent_records

    @staticmethod
    def _resolve_pairs(
        parent_node_ids: List[str],
        parent_refs: Any,
    ) -> List[tuple[str, str]]:
        """The unambiguous ``(doc_ref, parent_node_id)`` pairs of one read."""
        wanted = {str(node_id) for node_id in parent_node_ids}
        documents_by_parent: Dict[str, set[str]] = {}
        for reference in parent_refs or []:
            doc_ref, parent_node_id = _reference_parts(reference)
            if not doc_ref or parent_node_id not in wanted:
                continue
            documents_by_parent.setdefault(parent_node_id, set()).add(doc_ref)
        return [
            (next(iter(documents)), parent_node_id)
            for parent_node_id, documents in documents_by_parent.items()
            if len(documents) == 1
        ]

    @staticmethod
    def _pair_filter(knowledge_id: str, pairs: List[tuple[str, str]]) -> str:
        """Compile the exact document-scoped pairs of one parent read."""
        pair_conditions = " or ".join(
            "("
            f'{PARENT_DOC_REF_FIELD} == "{sanitize_filter_value(doc_ref)}"'
            " and "
            f'{PARENT_NODE_ID_FIELD} == "{sanitize_filter_value(parent_node_id)}"'
            ")"
            for doc_ref, parent_node_id in pairs
        )
        return f"{MilvusParentStore.scope_filter(knowledge_id)} and ({pair_conditions})"

    def delete(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        """Delete the parent nodes of one document."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        store = self._store
        with store.client() as client:
            if not client.has_collection(collection_name, timeout=store.rpc_timeout):
                return 0
            return self._delete_with_client(
                store, client, collection_name, knowledge_id, doc_ref
            )

    def _delete_with_client(
        self,
        store: MilvusDocumentStore,
        client,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
    ) -> int:
        """Delete the document's parent rows; the caller settled existence."""
        return store.delete_rows(
            client,
            collection_name,
            self.scope_filter(knowledge_id, doc_ref),
            flush=False,
        )
