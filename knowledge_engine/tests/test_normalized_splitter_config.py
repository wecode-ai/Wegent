# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from knowledge_engine.splitter.config import (
    normalize_splitter_config,
    serialize_splitter_config,
)


def test_normalize_legacy_smart_to_flat_file_aware() -> None:
    normalized = normalize_splitter_config({"type": "smart"})

    assert normalized.chunk_strategy == "flat"
    assert normalized.format_enhancement == "file_aware"
    assert normalized.flat_config is not None
    assert normalized.flat_config.chunk_overlap == 50
    assert normalized.markdown_enhancement.enabled is True
    assert normalized.legacy_type == "smart"


def test_normalized_config_round_trips_cleanly() -> None:
    payload = {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 256,
            "chunk_overlap": 16,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
    }

    normalized = normalize_splitter_config(payload)

    assert serialize_splitter_config(normalized) == payload


def test_normalize_splitter_config_clears_semantic_config_for_flat_strategy() -> None:
    normalized = normalize_splitter_config(
        {
            "chunk_strategy": "flat",
            "format_enhancement": "none",
            "flat_config": {
                "chunk_size": 512,
                "chunk_overlap": 64,
                "separator": "\n\n",
            },
            "semantic_config": {
                "buffer_size": 2,
                "breakpoint_percentile_threshold": 90,
            },
        }
    )

    assert normalized.semantic_config is None


def test_normalize_splitter_config_clears_semantic_config_for_hierarchical_strategy() -> (
    None
):
    normalized = normalize_splitter_config(
        {
            "chunk_strategy": "hierarchical",
            "hierarchical_config": {
                "parent_chunk_size": 2048,
                "child_chunk_size": 512,
                "child_chunk_overlap": 64,
                "parent_separator": "\n\n",
                "child_separator": "\n",
            },
            "semantic_config": {
                "buffer_size": 2,
                "breakpoint_percentile_threshold": 90,
            },
        }
    )

    assert normalized.semantic_config is None
    assert normalized.hierarchical_config is not None
    assert normalized.hierarchical_config.parent_chunk_size == 2048
    assert normalized.hierarchical_config.child_chunk_size == 512
    assert normalized.hierarchical_config.child_chunk_overlap == 64
    assert normalized.hierarchical_config.parent_separator == "\n\n"
    assert normalized.hierarchical_config.child_separator == "\n"
