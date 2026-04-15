# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock, patch

from llama_index.core import Document


def test_hierarchical_splitter_emits_parent_and_child_nodes() -> None:
    from knowledge_engine.splitter.hierarchical import build_hierarchical_nodes

    result = build_hierarchical_nodes(
        documents=[Document(text="A " * 3000)],
        parent_chunk_size=1024,
        child_chunk_size=256,
        child_chunk_overlap=32,
        parent_separator="\n\n",
        child_separator="\n",
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


def test_hierarchical_splitter_passes_distinct_parent_and_child_separators() -> None:
    from llama_index.core.schema import TextNode

    from knowledge_engine.splitter import hierarchical as hierarchical_module

    with patch.object(hierarchical_module, "SentenceSplitter") as mock_splitter:
        parent_splitter = MagicMock()
        child_splitter = MagicMock()
        parent_splitter.get_nodes_from_documents.return_value = [
            TextNode(text="Parent text", metadata={})
        ]
        child_splitter.get_nodes_from_documents.return_value = [
            TextNode(text="Child text", metadata={})
        ]
        mock_splitter.side_effect = [parent_splitter, child_splitter]

        hierarchical_module.build_hierarchical_nodes(
            documents=[Document(text="A\n\nB")],
            parent_chunk_size=1024,
            child_chunk_size=256,
            child_chunk_overlap=32,
            parent_separator="\n\n",
            child_separator="\n",
        )

    assert mock_splitter.call_count == 2
    assert mock_splitter.call_args_list[0].kwargs["separator"] == "\n\n"
    assert mock_splitter.call_args_list[0].kwargs["paragraph_separator"] == "\n\n"
    assert mock_splitter.call_args_list[1].kwargs["separator"] == "\n"
    assert mock_splitter.call_args_list[1].kwargs["paragraph_separator"] == "\n"


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
        parent_separator="\n\n",
        child_separator="\n",
    )

    assert result.parent_nodes
    assert result.child_nodes
    assert "Useful body paragraph with enough detail." in result.parent_nodes[0].text
    assert all(
        child.metadata.get("parent_node_id") == result.parent_nodes[0].node_id
        for child in result.child_nodes
    )
