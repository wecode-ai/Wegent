# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core import Document


def test_hierarchical_splitter_emits_parent_and_child_nodes() -> None:
    from knowledge_engine.splitter.hierarchical import build_hierarchical_nodes

    result = build_hierarchical_nodes(
        documents=[Document(text="A " * 3000)],
        parent_chunk_size=1024,
        child_chunk_size=256,
        child_chunk_overlap=32,
    )

    assert result.parent_nodes
    assert result.child_nodes

    parent_ids = {node.node_id for node in result.parent_nodes}
    assert parent_ids

    assert all(
        child.metadata.get("parent_node_id") in parent_ids
        for child in result.child_nodes
    )
    assert not any(
        parent.metadata.get("parent_node_id") is not None
        for parent in result.parent_nodes
    )


def test_hierarchical_splitter_consumes_prepared_markdown_content() -> None:
    from knowledge_engine.splitter.hierarchical import build_hierarchical_nodes

    result = build_hierarchical_nodes(
        documents=[
            Document(
                text="# Intro\n\nUseful body paragraph with enough detail.",
                metadata={"heading_path": "Intro"},
            )
        ],
        parent_chunk_size=1024,
        child_chunk_size=256,
        child_chunk_overlap=32,
    )

    assert result.parent_nodes
    assert result.child_nodes
    assert "Useful body paragraph with enough detail." in result.parent_nodes[0].text
    assert all(
        child.metadata.get("parent_node_id") == result.parent_nodes[0].node_id
        for child in result.child_nodes
    )
