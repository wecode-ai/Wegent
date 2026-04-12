# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import MagicMock

from llama_index.core import Document

from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.ingestion.pipeline import (
    build_ingestion_result,
    prepare_ingestion,
)
from knowledge_engine.storage.chunk_metadata import ChunkMetadata


def test_prepare_ingestion_defaults_to_flat_file_aware_when_config_missing() -> None:
    preparation = prepare_ingestion(None)

    assert preparation.normalized_splitter_config.chunk_strategy == "flat"
    assert preparation.normalized_splitter_config.format_enhancement == "file_aware"
    assert preparation.normalized_splitter_config.flat_config is not None
    assert preparation.normalized_splitter_config.flat_config.chunk_overlap == 50
    assert preparation.normalized_splitter_config.markdown_enhancement.enabled is True
    assert preparation.ingestion_metadata == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "parser_subtype": "sentence",
    }
    assert preparation.parser_subtype == "sentence"


def test_build_ingestion_result_without_splitter_config_uses_flat_file_aware_default() -> (
    None
):
    result = build_ingestion_result(
        documents=[
            Document(
                text="# Intro\n\n## Details\n\nUseful body paragraph with enough detail."
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.normalized_splitter_config.chunk_strategy == "flat"
    assert result.normalized_splitter_config.format_enhancement == "file_aware"
    assert result.parser_subtype == "markdown_sentence"
    assert result.normalized_splitter_config.markdown_enhancement.enabled is True
    assert len(result.nodes) == 1
    assert result.nodes[0].metadata["chunk_strategy"] == "flat"
    assert result.nodes[0].metadata["format_enhancement"] == "file_aware"
    assert result.nodes[0].metadata["parser_subtype"] == "markdown_sentence"
    assert result.nodes[0].metadata["node_role"] == "chunk"
    assert result.nodes[0].metadata["heading_path"] == "Intro"
    assert "Useful body paragraph with enough detail." in result.nodes[0].text


def test_document_indexer_indexes_flat_nodes_with_enriched_metadata() -> None:
    storage_backend = MagicMock()
    storage_backend.index_with_metadata.return_value = {
        "status": "success",
        "indexed_count": 1,
        "index_name": "wegent_kb_1",
    }
    indexer = DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=MagicMock(),
        splitter_config={"type": "smart"},
        file_extension=".md",
    )

    result = indexer._index_documents(
        documents=[
            Document(
                text="# Intro\n\n## Details\n\nUseful body paragraph with enough detail."
            )
        ],
        chunk_metadata=ChunkMetadata(
            knowledge_id="1",
            doc_ref="doc_1",
            source_file="notes.md",
            created_at="2026-04-12T00:00:00+00:00",
        ),
    )

    indexed_nodes = storage_backend.index_with_metadata.call_args.kwargs["nodes"]
    assert indexed_nodes[0].metadata["chunk_strategy"] == "flat"
    assert indexed_nodes[0].metadata["format_enhancement"] == "file_aware"
    assert indexed_nodes[0].metadata["parser_subtype"] == "markdown_sentence"
    assert indexed_nodes[0].metadata["node_role"] == "chunk"
    assert indexed_nodes[0].metadata["heading_path"] == "Intro"
    assert result["chunks_data"]["splitter_type"] == "flat"
    assert result["chunks_data"]["splitter_subtype"] == "markdown_sentence"
