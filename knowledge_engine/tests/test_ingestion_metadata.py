# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.schema import TextNode

from knowledge_engine.ingestion.metadata import (
    build_ingestion_metadata,
    enrich_node_metadata,
)
from knowledge_engine.splitter.config import normalize_splitter_config


def test_build_ingestion_metadata_uses_normalized_splitter_fields() -> None:
    splitter_config = normalize_splitter_config({"type": "smart"})

    assert build_ingestion_metadata(splitter_config) == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
    }


def test_build_ingestion_metadata_includes_parser_subtype_when_provided() -> None:
    splitter_config = normalize_splitter_config({"type": "smart"})

    assert build_ingestion_metadata(
        splitter_config,
        parser_subtype="markdown_sentence",
    ) == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "parser_subtype": "markdown_sentence",
    }


def test_enrich_node_metadata_promotes_header_path_and_sets_node_role() -> None:
    node = TextNode(
        text="Body paragraph",
        metadata={"header_path": "/Intro/Details/"},
    )

    enriched = enrich_node_metadata(
        node,
        ingestion_metadata={
            "chunk_strategy": "flat",
            "format_enhancement": "file_aware",
            "parser_subtype": "markdown_sentence",
        },
    )

    assert enriched.metadata == {
        "heading_path": "Intro > Details",
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "parser_subtype": "markdown_sentence",
        "node_role": "chunk",
    }
    assert enriched.excluded_embed_metadata_keys == ["heading_path"]
    assert enriched.excluded_llm_metadata_keys == ["heading_path"]


def test_enrich_node_metadata_drops_blank_heading_paths_before_normalizing() -> None:
    node = TextNode(
        text="Body paragraph",
        metadata={"heading_path": "", "header_path": " / "},
    )

    enriched = enrich_node_metadata(
        node,
        ingestion_metadata={
            "chunk_strategy": "flat",
            "format_enhancement": "none",
        },
    )

    assert "heading_path" not in enriched.metadata
    assert "header_path" not in enriched.metadata
    assert enriched.metadata["chunk_strategy"] == "flat"
    assert enriched.metadata["format_enhancement"] == "none"
    assert enriched.metadata["node_role"] == "chunk"
