# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.schema import TextNode

from knowledge_engine.splitter.markdown_enhancement import enhance_markdown_nodes


def test_markdown_enhancement_merges_heading_only_sections() -> None:
    nodes = [
        TextNode(text="# Intro", metadata={"heading_path": "Intro"}),
        TextNode(
            text="Useful body paragraph with enough detail.",
            metadata={"heading_path": "Intro > Body"},
        ),
    ]

    merged = enhance_markdown_nodes(nodes)

    assert len(merged) == 1
    assert merged[0].metadata["heading_path"] == "Intro > Body"
    assert "Useful body paragraph with enough detail." in merged[0].text
    assert merged[0].text.startswith("# Intro")
