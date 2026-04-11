# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from knowledge_engine.splitter import (
    normalize_splitter_config,
    parse_splitter_config,
    serialize_splitter_config,
)


def test_parse_splitter_config_supports_legacy_smart_type() -> None:
    splitter = parse_splitter_config({"type": "smart"})

    assert splitter.chunk_strategy == "flat"
    assert splitter.format_enhancement == "file_aware"
    assert splitter.markdown_enhancement.enabled is True
    assert splitter.legacy_type == "smart"


def test_parse_splitter_config_defaults_to_flat_strategy() -> None:
    splitter = parse_splitter_config({})

    assert splitter.chunk_strategy == "flat"
    assert splitter.format_enhancement == "none"
    assert splitter.flat_config is not None


def test_serialize_splitter_config_drops_legacy_marker_for_new_config() -> None:
    normalized = normalize_splitter_config(
        {
            "chunk_strategy": "flat",
            "format_enhancement": "file_aware",
            "flat_config": {
                "chunk_size": 1024,
                "chunk_overlap": 50,
                "separator": "\n\n",
            },
            "markdown_enhancement": {"enabled": True},
        }
    )

    assert serialize_splitter_config(normalized) == {
        "chunk_strategy": "flat",
        "format_enhancement": "file_aware",
        "flat_config": {
            "chunk_size": 1024,
            "chunk_overlap": 50,
            "separator": "\n\n",
        },
        "markdown_enhancement": {"enabled": True},
    }


def test_normalize_splitter_config_rejects_child_chunk_size_not_smaller_than_parent() -> (
    None
):
    with pytest.raises(ValueError, match="child_chunk_size"):
        normalize_splitter_config(
            {
                "chunk_strategy": "hierarchical",
                "hierarchical_config": {
                    "parent_chunk_size": 512,
                    "child_chunk_size": 512,
                    "child_chunk_overlap": 32,
                },
            }
        )
