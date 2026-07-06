# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest
from llama_index.core import Document
from llama_index.core.schema import TextNode

from knowledge_engine.embedding.custom import CustomEmbedding
from knowledge_engine.index.indexer import DocumentIndexer
from knowledge_engine.ingestion.pipeline import (
    _build_file_aware_transformations,
    build_ingestion_result,
    prepare_ingestion,
)
from knowledge_engine.splitter.config import FlatChunkConfig, MarkdownEnhancementConfig
from knowledge_engine.storage.chunk_metadata import ChunkMetadata


class _DummyEmbedding(CustomEmbedding):
    def _call_api(self, text: str) -> list[float]:
        del text
        return [0.1, 0.2, 0.3]


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


def test_prepare_ingestion_with_hierarchical_pdf_file_aware_hides_parser_subtype() -> (
    None
):
    preparation = prepare_ingestion(
        {
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".pdf",
    )

    assert preparation.normalized_splitter_config.chunk_strategy == "hierarchical"
    assert preparation.parser_subtype is None
    assert "parser_subtype" not in preparation.ingestion_metadata


@pytest.mark.parametrize("parser_subtype", ["markdown_sentence", "sentence"])
def test_build_file_aware_transformations_passes_separator_to_sentence_splitter(
    parser_subtype: str,
) -> None:
    with patch("knowledge_engine.ingestion.pipeline.LlamaSentenceSplitter") as mock:
        _build_file_aware_transformations(
            parser_subtype=parser_subtype,
            flat_config=FlatChunkConfig(
                chunk_size=512,
                chunk_overlap=64,
                separator="|",
            ),
            markdown_enhancement=MarkdownEnhancementConfig(enabled=False),
        )

    mock.assert_called_once_with(
        chunk_size=512,
        chunk_overlap=64,
        separator="|",
        paragraph_separator="|",
    )


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
    assert result.index_nodes == result.nodes
    assert result.parent_nodes is None
    assert result.child_nodes is None
    assert len(result.index_nodes) == 1
    assert result.index_nodes[0].metadata["chunk_strategy"] == "flat"
    assert result.index_nodes[0].metadata["format_enhancement"] == "file_aware"
    assert result.index_nodes[0].metadata["parser_subtype"] == "markdown_sentence"
    assert result.index_nodes[0].metadata["node_role"] == "chunk"
    assert result.index_nodes[0].metadata["heading_path"] == "Intro"
    assert "Useful body paragraph with enough detail." in result.index_nodes[0].text


@pytest.mark.parametrize("file_extension", [".md", ".txt"])
def test_build_ingestion_result_auto_unitizes_qa_documents(
    file_extension: str,
) -> None:
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "## Section A\n\n"
                    "**Q1：What does Wegent index?**\n\n"
                    "**A：**\n"
                    "Wegent indexes the complete answer with enough detail "
                    "to keep the returned chunk useful.\n"
                    "- It preserves readable answer structure.\n\n"
                    "**Q2：How is each answer returned?**\n\n"
                    "**A：**\n"
                    "Each detected question and answer pair becomes one node "
                    "without changing the query architecture."
                )
            )
        ],
        splitter_config=None,
        file_extension=file_extension,
        embed_model=MagicMock(),
    )

    assert result.normalized_splitter_config.chunk_strategy == "flat"
    assert result.parser_subtype == "qa_pair"
    assert result.index_nodes == result.nodes
    assert result.parent_nodes is None
    assert result.child_nodes is None
    assert len(result.index_nodes) == 2

    first_node = result.index_nodes[0]
    second_node = result.index_nodes[1]
    assert first_node.metadata["node_role"] == "qa_pair"
    assert first_node.metadata["parser_subtype"] == "qa_pair"
    assert first_node.metadata["chunk_strategy"] == "flat"
    assert first_node.metadata["format_enhancement"] == "file_aware"
    assert first_node.metadata["qa_id"] == "doc1-q0001"
    assert first_node.metadata["qa_index"] == 0
    assert first_node.metadata["question"] == "What does Wegent index?"
    assert first_node.metadata["display_text"] == first_node.text
    assert first_node.metadata["retrieval_text"].startswith(
        "Section: Section A\nQuestion: What does Wegent index?"
    )
    assert first_node.metadata["retrieval_text"] != first_node.text
    assert "\n\nA:" not in first_node.metadata["retrieval_text"]
    assert "question" in first_node.excluded_embed_metadata_keys
    assert "question" in first_node.excluded_llm_metadata_keys
    assert first_node.metadata["heading_path"] == "Section A"
    assert first_node.metadata["qa_confidence"] > 0.8
    assert first_node.metadata["source_position"].count(":") == 1
    assert first_node.text.startswith("Q: What does Wegent index?")
    assert "A: Wegent indexes the complete answer" in first_node.text
    assert "\n- It preserves readable answer structure." in first_node.text
    assert "How is each answer returned?" not in first_node.text
    assert second_node.metadata["qa_id"] == "doc1-q0002"
    assert "Each detected question and answer pair becomes one node" in second_node.text


def test_build_ingestion_result_preserves_qa_question_continuation() -> None:
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "Question: What does Wegent index?\n"
                    "Include uploaded files and pasted text.\n\n"
                    "Answer: Wegent indexes the resulting text as searchable nodes "
                    "with metadata for retrieval.\n\n"
                    "Question: How is each answer returned?\n\n"
                    "Answer: Each answer remains readable as display text while "
                    "retrieval uses a focused search text."
                )
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.parser_subtype == "qa_pair"
    assert "Include uploaded files and pasted text." in result.index_nodes[0].text
    assert result.index_nodes[0].metadata["question"] == (
        "What does Wegent index? Include uploaded files and pasted text."
    )


def test_build_ingestion_result_generates_unique_ids_for_mixed_question_numbering() -> (
    None
):
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "**Q1: What is indexed?**\n\n"
                    "**A:** Indexed text is stored as retrievable nodes with "
                    "source metadata.\n\n"
                    "**Q: How is it returned?**\n\n"
                    "**A:** Returned text remains readable and includes the "
                    "complete answer.\n\n"
                    "**Q2: Does retrieval change?**\n\n"
                    "**A:** The retrieval contract remains compatible with "
                    "existing knowledge base queries."
                )
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    qa_ids = [
        node.metadata["qa_id"]
        for node in result.index_nodes
        if node.metadata["node_role"] == "qa_pair"
    ]
    assert qa_ids == ["doc1-q0001", "doc1-q0003", "doc1-q0002"]
    assert len(qa_ids) == len(set(qa_ids))


def test_build_ingestion_result_unitizes_plain_qa_labels() -> None:
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "Q1: What changed in retrieval?\n\n"
                    "A: Retrieval can index each question and answer pair "
                    "as a focused searchable node.\n\n"
                    "Q2: Does the answer stay readable?\n\n"
                    "A: The returned node keeps the full answer text for "
                    "downstream LLM context."
                )
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.parser_subtype == "qa_pair"
    assert [node.metadata["node_role"] for node in result.index_nodes] == [
        "qa_pair",
        "qa_pair",
    ]


def test_build_ingestion_result_preserves_uncovered_text_in_mixed_qa_document() -> None:
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "This introduction contains important operational context that "
                    "is not part of any individual question and must remain "
                    "available to retrieval after QA unitization.\n\n"
                    "**Q1: What is indexed?**\n\n"
                    "**A:** Indexed text is stored as retrievable nodes with "
                    "source metadata.\n\n"
                    "**Q2: How is it returned?**\n\n"
                    "**A:** Returned text remains readable and includes the "
                    "complete answer."
                )
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.parser_subtype == "qa_pair"
    assert [node.metadata["node_role"] for node in result.index_nodes] == [
        "qa_pair",
        "qa_pair",
        "chunk",
    ]
    assert "important operational context" in result.index_nodes[2].text


def test_build_ingestion_result_does_not_unitize_single_qa_document() -> None:
    result = build_ingestion_result(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "**Q1：What does Wegent index?**\n\n"
                    "**A：**\n"
                    "Wegent indexes the complete answer with enough detail."
                )
            )
        ],
        splitter_config=None,
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.parser_subtype == "markdown_sentence"
    assert len(result.index_nodes) == 1
    assert result.index_nodes[0].metadata["node_role"] == "chunk"


def test_build_ingestion_result_with_hierarchical_config_returns_parent_and_child_nodes() -> (
    None
):
    result = build_ingestion_result(
        documents=[
            Document(
                text="# Intro\n\n## Tiny\n\nUseful body paragraph with enough detail."
            ),
        ],
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "markdown_enhancement": {"enabled": True},
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.normalized_splitter_config.chunk_strategy == "hierarchical"
    assert result.parent_nodes
    assert result.child_nodes
    assert result.index_nodes == result.child_nodes
    assert result.parser_subtype == "markdown_sentence"
    assert result.parent_nodes[0].metadata["format_enhancement"] == "file_aware"
    assert result.parent_nodes[0].metadata["heading_path"] == "Intro"
    assert result.parent_nodes[0].metadata["node_role"] == "parent"
    assert result.child_nodes[0].metadata["format_enhancement"] == "file_aware"
    assert result.child_nodes[0].metadata["heading_path"] == "Intro"
    assert result.child_nodes[0].metadata["node_role"] == "child"
    assert (
        result.child_nodes[0].metadata["parent_node_id"]
        == result.parent_nodes[0].node_id
    )
    assert "Useful body paragraph with enough detail." in result.parent_nodes[0].text


def test_build_ingestion_result_with_hierarchical_markdown_without_merge_keeps_markdown_preparation() -> (
    None
):
    result = build_ingestion_result(
        documents=[
            Document(
                text="# Intro\n\n## Tiny\n\nUseful body paragraph with enough detail."
            ),
        ],
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "markdown_enhancement": {"enabled": False},
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".md",
        embed_model=MagicMock(),
    )

    assert result.normalized_splitter_config.chunk_strategy == "hierarchical"
    assert result.parser_subtype == "markdown_sentence"
    assert result.parent_nodes
    assert result.child_nodes
    assert len(result.parent_nodes) == 2
    assert len(result.child_nodes) == 2
    parent_ids = {node.node_id for node in result.parent_nodes}
    assert any(
        node.metadata.get("heading_path") == "Intro" for node in result.parent_nodes
    )
    assert any(
        node.metadata.get("heading_path") == "Intro" for node in result.child_nodes
    )
    assert all(
        child.metadata.get("parent_node_id") in parent_ids
        for child in result.child_nodes
    )


def test_build_ingestion_result_with_hierarchical_pdf_file_aware_does_not_advertise_parser_subtype() -> (
    None
):
    result = build_ingestion_result(
        documents=[Document(text="A " * 3000)],
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "markdown_enhancement": {"enabled": False},
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".pdf",
        embed_model=MagicMock(),
    )

    assert result.normalized_splitter_config.chunk_strategy == "hierarchical"
    assert result.parent_nodes
    assert result.child_nodes
    assert result.parser_subtype is None
    assert "parser_subtype" not in result.ingestion_metadata
    assert "parser_subtype" not in result.parent_nodes[0].metadata
    assert "parser_subtype" not in result.child_nodes[0].metadata


def test_build_ingestion_result_with_semantic_config_returns_structured_outputs() -> (
    None
):
    result = build_ingestion_result(
        documents=[
            Document(text="Semantic chunking should still populate index nodes."),
        ],
        splitter_config={
            "chunk_strategy": "semantic",
            "semantic_config": {
                "buffer_size": 1,
                "breakpoint_percentile_threshold": 95,
            },
        },
        file_extension=".md",
        embed_model=_DummyEmbedding(api_url="http://example.invalid", model="dummy"),
    )

    assert result.normalized_splitter_config.chunk_strategy == "semantic"
    assert result.index_nodes
    assert result.parent_nodes is None
    assert result.child_nodes is None
    assert result.index_nodes == result.nodes


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
    assert result["chunks_data"]["qa_pair_count"] == 0


def test_document_indexer_exposes_qa_pair_count_for_unitized_documents() -> None:
    storage_backend = MagicMock()
    storage_backend.index_with_metadata.return_value = {
        "status": "success",
        "indexed_count": 2,
        "index_name": "wegent_kb_1",
    }
    indexer = DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=MagicMock(),
        splitter_config=None,
        file_extension=".md",
    )

    result = indexer._index_documents(
        documents=[
            Document(
                text=(
                    "# FAQ\n\n"
                    "**Q1：What does Wegent index?**\n\n"
                    "**A：**\n"
                    "Wegent indexes complete question and answer pairs.\n\n"
                    "**Q2：Does retrieval change?**\n\n"
                    "**A：**\n"
                    "Retrieval keeps reading the same node text, so query behavior "
                    "does not require a new architecture."
                )
            )
        ],
        chunk_metadata=ChunkMetadata(
            knowledge_id="1",
            doc_ref="doc_qa",
            source_file="faq.md",
            created_at="2026-04-12T00:00:00+00:00",
        ),
    )

    indexed_nodes = storage_backend.index_with_metadata.call_args.kwargs["nodes"]
    assert len(indexed_nodes) == 2
    assert indexed_nodes[0].metadata["node_role"] == "qa_pair"
    assert indexed_nodes[0].metadata["parser_subtype"] == "qa_pair"
    assert result["chunks_data"]["splitter_type"] == "flat"
    assert result["chunks_data"]["splitter_subtype"] == "qa_pair"
    assert result["chunks_data"]["qa_pair_count"] == 2
    assert result["chunks_data"]["items"][0]["content"].startswith(
        "Q: What does Wegent index?"
    )
    assert (
        "A: Wegent indexes complete question and answer pairs."
        in result["chunks_data"]["items"][0]["content"]
    )


def test_document_indexer_hierarchical_routes_through_ingestion_result_contract() -> (
    None
):
    storage_backend = MagicMock()
    storage_backend.save_parent_nodes.return_value = None
    storage_backend.index_with_metadata.return_value = {
        "status": "success",
        "indexed_count": 2,
        "index_name": "wegent_kb_1",
    }
    indexer = DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=MagicMock(),
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "markdown_enhancement": {"enabled": True},
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".md",
    )

    parent_nodes = [
        TextNode(text="parent-a", metadata={"node_role": "parent"}),
        TextNode(text="parent-b", metadata={"node_role": "parent"}),
    ]
    index_nodes = [
        TextNode(text="child-a", metadata={"node_role": "child"}),
        TextNode(text="child-b", metadata={"node_role": "child"}),
    ]
    ingestion_result = SimpleNamespace(
        parent_nodes=parent_nodes,
        index_nodes=index_nodes,
        parser_subtype="markdown_sentence",
    )

    with patch(
        "knowledge_engine.index.indexer.build_ingestion_result",
        return_value=ingestion_result,
    ) as build_ingestion_result:
        result = indexer._index_documents(
            documents=[
                Document(text="# Intro\n\n## Details\n\nHierarchical content."),
            ],
            chunk_metadata=ChunkMetadata(
                knowledge_id="1",
                doc_ref="doc_1",
                source_file="notes.md",
                created_at="2026-04-12T00:00:00+00:00",
            ),
        )

    build_ingestion_result.assert_called_once()
    assert (
        build_ingestion_result.call_args.kwargs["splitter_config"]
        is indexer.splitter_config
    )
    assert build_ingestion_result.call_args.kwargs["file_extension"] == ".md"
    assert build_ingestion_result.call_args.kwargs["embed_model"] is indexer.embed_model

    save_parent_kwargs = storage_backend.save_parent_nodes.call_args.kwargs
    assert save_parent_kwargs["parent_nodes"] is parent_nodes
    assert save_parent_kwargs["knowledge_id"] == "1"

    indexed_kwargs = storage_backend.index_with_metadata.call_args.kwargs
    assert indexed_kwargs["nodes"] is index_nodes
    assert indexed_kwargs["chunk_metadata"].knowledge_id == "1"

    assert result["chunk_count"] == 2
    assert result["chunks_data"]["total_count"] == 2
    assert len(result["chunks_data"]["items"]) == 2
    assert result["chunks_data"]["splitter_subtype"] == "markdown_sentence"


def test_document_indexer_hierarchical_chunk_metadata_counts_indexed_nodes_only() -> (
    None
):
    storage_backend = MagicMock()
    storage_backend.save_parent_nodes.return_value = None
    storage_backend.index_with_metadata.return_value = {
        "status": "success",
        "indexed_count": 3,
        "index_name": "wegent_kb_1",
    }
    indexer = DocumentIndexer(
        storage_backend=storage_backend,
        embed_model=MagicMock(),
        splitter_config={
            "chunk_strategy": "hierarchical",
            "format_enhancement": "file_aware",
            "markdown_enhancement": {"enabled": False},
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
        },
        file_extension=".md",
    )

    parent_nodes = [TextNode(text="parent", metadata={"node_role": "parent"})]
    index_nodes = [
        TextNode(text="child-1", metadata={"node_role": "child"}),
        TextNode(text="child-2", metadata={"node_role": "child"}),
        TextNode(text="child-3", metadata={"node_role": "child"}),
    ]
    ingestion_result = SimpleNamespace(
        parent_nodes=parent_nodes,
        index_nodes=index_nodes,
        parser_subtype="markdown_sentence",
    )

    with patch(
        "knowledge_engine.index.indexer.build_ingestion_result",
        return_value=ingestion_result,
    ):
        result = indexer._index_documents(
            documents=[
                Document(text="Short hierarchical content."),
            ],
            chunk_metadata=ChunkMetadata(
                knowledge_id="1",
                doc_ref="doc_2",
                source_file="notes.md",
                created_at="2026-04-12T00:00:00+00:00",
            ),
        )

    assert result["chunk_count"] == 3
    assert result["chunks_data"]["total_count"] == 3
    assert len(result["chunks_data"]["items"]) == 3
    assert result["chunks_data"]["splitter_subtype"] == "markdown_sentence"
