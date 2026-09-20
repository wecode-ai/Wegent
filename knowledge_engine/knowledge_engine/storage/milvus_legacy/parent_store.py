# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Parent-node sidecar methods of the legacy Milvus adapter.

This is the online main branch's implementation, moved into its own module so
the adapter stays within the repository's file size rule. The class below is a
mixin of ``LegacyMilvusBackend`` and holds no state of its own: it reads the
connection, the naming strategy and the helpers off that adapter.
"""

import json
from typing import Any, Dict, List

from llama_index.core.schema import BaseNode
from pymilvus import MilvusClient


class LegacyMilvusParentStore:
    """The parent bodies stored beside one document's child rows."""

    def _build_parent_node_filter_expr(self, knowledge_id: str, doc_ref: str) -> str:
        safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
        safe_doc_ref = self._sanitize_filter_value(doc_ref)
        return f'knowledge_id == "{safe_knowledge_id}" and doc_ref == "{safe_doc_ref}"'

    def _delete_parent_nodes_with_client(
        self,
        client: MilvusClient,
        collection_name: str,
        knowledge_id: str,
        doc_ref: str,
    ) -> int:
        if not client.has_collection(collection_name):
            return 0

        filter_expr = self._build_parent_node_filter_expr(knowledge_id, doc_ref)
        try:
            client.delete(collection_name=collection_name, filter=filter_expr)
        except TypeError:
            client.delete(collection_name=collection_name, expr=filter_expr)
        return 0

    def delete_parent_nodes(self, knowledge_id: str, doc_ref: str, **kwargs) -> int:
        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = self._get_client()

        try:
            return self._delete_parent_nodes_with_client(
                client,
                collection_name,
                knowledge_id,
                doc_ref,
            )
        finally:
            try:
                client.close()
            except Exception:
                pass

    def save_parent_nodes(
        self,
        knowledge_id: str,
        parent_nodes: List[BaseNode],
        **kwargs,
    ) -> Dict[str, Any]:
        if not parent_nodes:
            return {"stored_count": 0}

        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = self._get_client()

        try:
            if not client.has_collection(collection_name):
                client.create_collection(
                    collection_name=collection_name,
                    dimension=1,
                    auto_id=True,
                    enable_dynamic_field=True,
                )
            else:
                self._delete_parent_nodes_with_client(
                    client,
                    collection_name,
                    knowledge_id,
                    parent_nodes[0].metadata.get("doc_ref", ""),
                )

            client.insert(
                collection_name=collection_name,
                data=[
                    {
                        "vector": [0.0],
                        "parent_node_id": node.node_id,
                        "knowledge_id": knowledge_id,
                        "doc_ref": node.metadata.get("doc_ref"),
                        "source_file": node.metadata.get("source_file"),
                        "content": self.get_node_display_text(node),
                        "title": node.metadata.get("source_file", ""),
                        "metadata_json": json.dumps(node.metadata),
                    }
                    for node in parent_nodes
                ],
            )
            return {"stored_count": len(parent_nodes)}
        finally:
            try:
                client.close()
            except Exception:
                pass

    def get_parent_nodes(
        self,
        knowledge_id: str,
        parent_node_ids: List[str],
        **kwargs,
    ) -> Dict[str, Dict[str, Any]]:
        if not parent_node_ids:
            return {}

        collection_name = self.get_parent_store_name(knowledge_id, **kwargs)
        client = self._get_client()

        try:
            if not client.has_collection(collection_name):
                return {}

            parent_records: Dict[str, Dict[str, Any]] = {}
            safe_knowledge_id = self._sanitize_filter_value(knowledge_id)
            for parent_node_id in parent_node_ids:
                safe_parent_node_id = self._sanitize_filter_value(parent_node_id)
                results = client.query(
                    collection_name=collection_name,
                    filter=(
                        f'knowledge_id == "{safe_knowledge_id}" and '
                        f'parent_node_id == "{safe_parent_node_id}"'
                    ),
                    output_fields=[
                        "parent_node_id",
                        "content",
                        "title",
                        "metadata_json",
                    ],
                    limit=1,
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
        finally:
            try:
                client.close()
            except Exception:
                pass
