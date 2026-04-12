# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from langchain_text_splitters import RecursiveCharacterTextSplitter
from llama_index.core import Document
from llama_index.core.ingestion import IngestionPipeline
from llama_index.core.node_parser import (
    LangchainNodeParser,
    MarkdownNodeParser,
    SemanticSplitterNodeParser,
)
from llama_index.core.node_parser import SentenceSplitter as LlamaSentenceSplitter
from llama_index.core.schema import BaseNode, TransformComponent

from knowledge_engine.ingestion.metadata import (
    build_ingestion_metadata,
    enrich_nodes_metadata,
)
from knowledge_engine.splitter.config import (
    FlatChunkConfig,
    MarkdownEnhancementConfig,
    NormalizedSplitterConfig,
    SemanticSplitterConfig,
    SplitterConfigModel,
    normalize_runtime_splitter_config,
)
from knowledge_engine.splitter.file_aware import resolve_file_aware_parser_subtype
from knowledge_engine.splitter.markdown_enhancement import enhance_markdown_nodes

DEFAULT_FILE_AWARE_EXTENSION = ".txt"


@dataclass(frozen=True, slots=True)
class IngestionPreparation:
    """Prepared ingestion contract for service and indexer entrypoints."""

    normalized_splitter_config: NormalizedSplitterConfig
    ingestion_metadata: dict[str, Any]
    parser_subtype: str | None = None


@dataclass(frozen=True, slots=True)
class IngestionResult:
    """Result of running the ingestion pipeline for one document batch."""

    nodes: list[BaseNode]
    normalized_splitter_config: NormalizedSplitterConfig
    ingestion_metadata: dict[str, Any]
    parser_subtype: str | None = None


class MarkdownEnhancementTransform(TransformComponent):
    """Apply deterministic markdown weak-section merge before final chunking."""

    def __call__(
        self,
        nodes: Sequence[BaseNode],
        **kwargs: Any,
    ) -> Sequence[BaseNode]:
        del kwargs
        return enhance_markdown_nodes(list(nodes))


class MetadataEnrichmentTransform(TransformComponent):
    """Attach stable metadata fields to all nodes emitted by the pipeline."""

    ingestion_metadata: dict[str, Any]
    default_node_role: str = "chunk"

    def __call__(
        self,
        nodes: Sequence[BaseNode],
        **kwargs: Any,
    ) -> Sequence[BaseNode]:
        del kwargs
        return enrich_nodes_metadata(
            list(nodes),
            ingestion_metadata=self.ingestion_metadata,
            default_node_role=self.default_node_role,
        )


def resolve_parser_subtype(
    splitter_config: NormalizedSplitterConfig,
    *,
    file_extension: str | None = None,
) -> str | None:
    """Resolve the parser subtype used for the ingestion path."""
    if (
        splitter_config.chunk_strategy != "flat"
        or splitter_config.format_enhancement != "file_aware"
    ):
        return None

    return resolve_file_aware_parser_subtype(
        (file_extension or DEFAULT_FILE_AWARE_EXTENSION).lower()
    )


def prepare_ingestion(
    splitter_config: dict | SplitterConfigModel | None,
    *,
    file_extension: str | None = None,
) -> IngestionPreparation:
    """Normalize splitter config and derive stable ingestion metadata."""
    normalized_splitter_config = normalize_runtime_splitter_config(splitter_config)
    parser_subtype = resolve_parser_subtype(
        normalized_splitter_config,
        file_extension=file_extension,
    )
    ingestion_metadata = build_ingestion_metadata(
        normalized_splitter_config,
        parser_subtype=parser_subtype,
    )
    return IngestionPreparation(
        normalized_splitter_config=normalized_splitter_config,
        ingestion_metadata=ingestion_metadata,
        parser_subtype=parser_subtype,
    )


def build_ingestion_result(
    *,
    documents: list[Document],
    splitter_config: dict | NormalizedSplitterConfig | SplitterConfigModel | None,
    file_extension: str | None,
    embed_model,
) -> IngestionResult:
    """Run the lightweight ingestion pipeline for non-hierarchical indexing."""
    preparation = prepare_ingestion(
        splitter_config,
        file_extension=file_extension,
    )
    pipeline = IngestionPipeline(
        transformations=_build_transformations(
            preparation.normalized_splitter_config,
            ingestion_metadata=preparation.ingestion_metadata,
            parser_subtype=preparation.parser_subtype,
            embed_model=embed_model,
        )
    )
    nodes = list(pipeline.run(documents=documents))
    return IngestionResult(
        nodes=nodes,
        normalized_splitter_config=preparation.normalized_splitter_config,
        ingestion_metadata=preparation.ingestion_metadata,
        parser_subtype=preparation.parser_subtype,
    )


def _build_transformations(
    splitter_config: NormalizedSplitterConfig,
    *,
    ingestion_metadata: dict[str, Any],
    parser_subtype: str | None,
    embed_model,
) -> list[TransformComponent]:
    if splitter_config.chunk_strategy == "semantic":
        semantic_config = splitter_config.semantic_config or SemanticSplitterConfig()
        return [
            SemanticSplitterNodeParser(
                buffer_size=semantic_config.buffer_size,
                breakpoint_percentile_threshold=(
                    semantic_config.breakpoint_percentile_threshold
                ),
                embed_model=embed_model,
            ),
            MetadataEnrichmentTransform(ingestion_metadata=ingestion_metadata),
        ]

    flat_config = splitter_config.flat_config or FlatChunkConfig()
    transformations: list[TransformComponent] = []
    if splitter_config.format_enhancement == "file_aware":
        transformations.extend(
            _build_file_aware_transformations(
                parser_subtype=parser_subtype,
                flat_config=flat_config,
                markdown_enhancement=splitter_config.markdown_enhancement,
            )
        )
    else:
        transformations.append(
            LlamaSentenceSplitter(
                chunk_size=flat_config.chunk_size,
                chunk_overlap=flat_config.chunk_overlap,
                separator=flat_config.separator,
            )
        )

    transformations.append(
        MetadataEnrichmentTransform(ingestion_metadata=ingestion_metadata)
    )
    return transformations


def _build_file_aware_transformations(
    *,
    parser_subtype: str | None,
    flat_config: FlatChunkConfig,
    markdown_enhancement: MarkdownEnhancementConfig,
) -> list[TransformComponent]:
    if parser_subtype == "markdown_sentence":
        transformations: list[TransformComponent] = [MarkdownNodeParser()]
        if markdown_enhancement.enabled:
            transformations.append(MarkdownEnhancementTransform())
        transformations.append(
            LlamaSentenceSplitter(
                chunk_size=flat_config.chunk_size,
                chunk_overlap=flat_config.chunk_overlap,
            )
        )
        return transformations

    if parser_subtype == "sentence":
        return [
            LlamaSentenceSplitter(
                chunk_size=flat_config.chunk_size,
                chunk_overlap=flat_config.chunk_overlap,
            )
        ]

    return [
        LangchainNodeParser(
            lc_splitter=RecursiveCharacterTextSplitter(
                chunk_size=flat_config.chunk_size,
                chunk_overlap=flat_config.chunk_overlap,
                separators=["\n\n", "\n", " ", ""],
            )
        )
    ]
