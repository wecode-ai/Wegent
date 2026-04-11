# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.schema import NodeRelationship, RelatedNodeInfo, TextNode

from knowledge_engine.splitter.markdown_enhancement import enhance_markdown_nodes


def test_markdown_enhancement_merges_heading_only_sections() -> None:
    nodes = [
        TextNode(
            text="# Intro",
            id_="heading-node",
            metadata={"heading_path": "Intro"},
            excluded_embed_metadata_keys=["heading_path"],
            excluded_llm_metadata_keys=["heading_path"],
            embedding=[0.1, 0.2],
        ),
        TextNode(
            text="Useful body paragraph with enough detail.",
            id_="body-node",
            metadata={"heading_path": "Intro > Body"},
            relationships={
                NodeRelationship.SOURCE: RelatedNodeInfo(node_id="source-node")
            },
            excluded_embed_metadata_keys=["heading_path"],
            excluded_llm_metadata_keys=["heading_path"],
            embedding=[0.3, 0.4],
        ),
    ]

    merged = enhance_markdown_nodes(nodes)

    assert len(merged) == 1
    assert merged[0].id_ == "body-node"
    assert merged[0].metadata["heading_path"] == "Intro > Body"
    assert merged[0].relationships == {
        NodeRelationship.SOURCE: RelatedNodeInfo(node_id="source-node")
    }
    assert merged[0].excluded_embed_metadata_keys == ["heading_path"]
    assert merged[0].excluded_llm_metadata_keys == ["heading_path"]
    assert merged[0].embedding == [0.3, 0.4]
    assert "Useful body paragraph with enough detail." in merged[0].text
    assert merged[0].text.startswith("# Intro")
