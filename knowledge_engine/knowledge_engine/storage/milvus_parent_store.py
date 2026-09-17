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

from knowledge_engine.storage.milvus_native import (
    MilvusDocumentStore,
    build_scope_filter,
    sanitize_filter_value,
)

logger = logging.getLogger(__name__)

PARENT_STORE_VECTOR_DIM = 2
PARENT_NODE_ID_FIELD = "parent_node_id"


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
                        "knowledge_id": knowledge_id,
                        "doc_ref": node.metadata.get("doc_ref"),
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
        """Load parent nodes by id."""
        if not parent_node_ids:
            return {}

        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        store = self._store
        with store.client() as client:
            if not client.has_collection(collection_name, timeout=store.rpc_timeout):
                return {}

            parent_records: Dict[str, Dict[str, Any]] = {}
            for parent_node_id in parent_node_ids:
                results = client.query(
                    collection_name=collection_name,
                    filter=build_scope_filter(
                        knowledge_id=knowledge_id,
                        extra_conditions=[
                            f"{PARENT_NODE_ID_FIELD} == "
                            f'"{sanitize_filter_value(parent_node_id)}"'
                        ],
                    ),
                    output_fields=[
                        PARENT_NODE_ID_FIELD,
                        "content",
                        "title",
                        "metadata_json",
                    ],
                    limit=1,
                    timeout=store.rpc_timeout,
                )
                if not results:
                    continue
                record = results[0]
                parent_records[parent_node_id] = {
                    "content": record.get("content", ""),
                    "title": record.get("title", ""),
                    "metadata": json.loads(record.get("metadata_json") or "{}"),
                }
            return parent_records

    def delete(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        """Delete the parent nodes of one document."""
        collection_name = self._collection_name_for(knowledge_id, **kwargs)
        store = self._store
        with store.client() as client:
            return self._delete_with_client(
                store, client, collection_name, knowledge_id, doc_ref
            )

    @staticmethod
    def _delete_with_client(
        store: MilvusDocumentStore,
        client,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
    ) -> int:
        if not client.has_collection(collection_name, timeout=store.rpc_timeout):
            return 0
        client.delete(
            collection_name=collection_name,
            filter=build_scope_filter(
                knowledge_id=knowledge_id,
                doc_refs=[doc_ref],
            ),
            timeout=store.rpc_timeout,
        )
        return 0
