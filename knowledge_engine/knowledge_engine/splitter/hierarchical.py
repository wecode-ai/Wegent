# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass

from llama_index.core import Document
from llama_index.core.node_parser import SentenceSplitter
from llama_index.core.schema import BaseNode, TextNode


@dataclass
class HierarchicalNodes:
    parent_nodes: list[BaseNode]
    child_nodes: list[BaseNode]


def build_hierarchical_nodes(
    *,
    documents: list[Document],
    parent_chunk_size: int,
    child_chunk_size: int,
    child_chunk_overlap: int,
    parent_separator: str,
    child_separator: str,
) -> HierarchicalNodes:
    """Build parent and child nodes for hierarchical indexing from prepared documents."""
    parent_splitter = SentenceSplitter(
        chunk_size=parent_chunk_size,
        chunk_overlap=0,
        separator=parent_separator,
        paragraph_separator=parent_separator,
    )
    child_splitter = SentenceSplitter(
        chunk_size=child_chunk_size,
        chunk_overlap=child_chunk_overlap,
        separator=child_separator,
        paragraph_separator=child_separator,
    )

    raw_parent_nodes = parent_splitter.get_nodes_from_documents(documents)
    parent_nodes: list[BaseNode] = []
    child_nodes: list[BaseNode] = []

    for raw_parent_node in raw_parent_nodes:
        parent_metadata = dict(raw_parent_node.metadata or {})
        parent_metadata.update(
            {
                "chunk_strategy": "hierarchical",
                "node_role": "parent",
            }
        )
        parent_node = TextNode(
            id_=raw_parent_node.node_id,
            text=raw_parent_node.text,
            metadata=parent_metadata,
        )
        parent_nodes.append(parent_node)

        raw_child_nodes = child_splitter.get_nodes_from_documents(
            [Document(text=parent_node.text, metadata=parent_metadata)]
        )
        for raw_child_node in raw_child_nodes:
            child_metadata = dict(raw_child_node.metadata or {})
            child_metadata.update(
                {
                    "chunk_strategy": "hierarchical",
                    "node_role": "child",
                    "parent_node_id": parent_node.node_id,
                }
            )
            child_nodes.append(
                TextNode(
                    id_=raw_child_node.node_id,
                    text=raw_child_node.text,
                    metadata=child_metadata,
                )
            )

    return HierarchicalNodes(
        parent_nodes=parent_nodes,
        child_nodes=child_nodes,
    )
