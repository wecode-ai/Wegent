# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from llama_index.core.schema import TextNode

from knowledge_engine.ingestion.video_segment import (
    enrich_video_segment_nodes,
    extract_video_segment_metadata,
)


def test_extract_video_segment_metadata_from_generated_heading() -> None:
    metadata = extract_video_segment_metadata(
        "### Chapter 1 [00:01:02 - 00:02:03]\nRelevant transcript"
    )

    assert metadata == {
        "video_segment_id": "segment_62_123",
        "video_start_sec": 62,
        "video_end_sec": 123,
    }


def test_enrich_video_segment_nodes_is_limited_to_video_documents() -> None:
    video_node = TextNode(
        text="### Chapter [00:00:05 - 00:00:10]\nVideo text",
        metadata={"filename": "42.video"},
    )
    ordinary_node = TextNode(
        text="### Chapter [00:00:05 - 00:00:10]\nOrdinary text",
        metadata={"filename": "notes.md"},
    )

    enrich_video_segment_nodes([video_node, ordinary_node])

    assert video_node.metadata["video_start_sec"] == 5
    assert video_node.metadata["video_end_sec"] == 10
    assert "video_start_sec" not in ordinary_node.metadata


def test_extract_video_segment_metadata_rejects_invalid_range() -> None:
    assert (
        extract_video_segment_metadata(
            "### Chapter [00:01:00 - 00:00:30]\nInvalid range"
        )
        is None
    )
