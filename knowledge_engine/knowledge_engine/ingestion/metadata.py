# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from llama_index.core.schema import BaseNode

from knowledge_engine.splitter.config import NormalizedSplitterConfig

HEADING_PATH_KEY = "heading_path"
HEADER_PATH_KEY = "header_path"
DEFAULT_NODE_ROLE = "chunk"


@dataclass(frozen=True, slots=True)
class IngestionMetadata:
    """Normalized ingestion metadata for downstream pipeline stages."""

    chunk_strategy: str
    format_enhancement: str
    parser_subtype: str | None = None

    def to_dict(self) -> dict[str, Any]:
        metadata: dict[str, Any] = {
            "chunk_strategy": self.chunk_strategy,
            "format_enhancement": self.format_enhancement,
        }
        if self.parser_subtype is not None:
            metadata["parser_subtype"] = self.parser_subtype
        return metadata


def build_ingestion_metadata(
    splitter_config: NormalizedSplitterConfig | None,
    *,
    parser_subtype: str | None = None,
) -> dict[str, Any]:
    """Build stable ingestion metadata from a normalized splitter config."""
    if splitter_config is None:
        return {}

    return IngestionMetadata(
        chunk_strategy=splitter_config.chunk_strategy,
        format_enhancement=splitter_config.format_enhancement,
        parser_subtype=parser_subtype,
    ).to_dict()


def normalize_heading_path(raw_path: str | None) -> str | None:
    """Normalize parser-specific heading metadata to one stable display format."""
    if raw_path is None:
        return None

    normalized = raw_path.strip()
    if not normalized or normalized == "/":
        return None

    if "/" in normalized:
        parts = [part.strip() for part in normalized.split("/") if part.strip()]
        if not parts:
            return None
        return " > ".join(parts)

    return normalized


def enrich_node_metadata(
    node: BaseNode,
    *,
    ingestion_metadata: dict[str, Any],
    default_node_role: str = DEFAULT_NODE_ROLE,
) -> BaseNode:
    """Apply stable ingestion metadata to a single node."""
    metadata = dict(node.metadata or {})
    raw_heading_path = metadata.get(HEADING_PATH_KEY) or metadata.get(HEADER_PATH_KEY)
    metadata.pop(HEADER_PATH_KEY, None)
    metadata.pop(HEADING_PATH_KEY, None)
    heading_path = normalize_heading_path(raw_heading_path)

    if heading_path is not None:
        metadata[HEADING_PATH_KEY] = heading_path

    for key, value in ingestion_metadata.items():
        if value is not None:
            metadata[key] = value

    metadata.setdefault("node_role", default_node_role)

    excluded_embed = list(getattr(node, "excluded_embed_metadata_keys", []) or [])
    excluded_llm = list(getattr(node, "excluded_llm_metadata_keys", []) or [])
    if heading_path is not None:
        if HEADING_PATH_KEY not in excluded_embed:
            excluded_embed.append(HEADING_PATH_KEY)
        if HEADING_PATH_KEY not in excluded_llm:
            excluded_llm.append(HEADING_PATH_KEY)

    return node.model_copy(
        update={
            "metadata": metadata,
            "excluded_embed_metadata_keys": excluded_embed,
            "excluded_llm_metadata_keys": excluded_llm,
        }
    )


def enrich_nodes_metadata(
    nodes: list[BaseNode],
    *,
    ingestion_metadata: dict[str, Any],
    default_node_role: str = DEFAULT_NODE_ROLE,
) -> list[BaseNode]:
    """Apply stable ingestion metadata to a list of nodes."""
    return [
        enrich_node_metadata(
            node,
            ingestion_metadata=ingestion_metadata,
            default_node_role=default_node_role,
        )
        for node in nodes
    ]
