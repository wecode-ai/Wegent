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


def test_extract_video_segment_metadata_accepts_parentheses_mmss() -> None:
    """Gemini often emits (MM:SS - MM:SS) for short videos despite the prompt."""
    metadata = extract_video_segment_metadata(
        "### 章节 1：开场 (00:00 - 00:06)\n短视频内容"
    )

    assert metadata == {
        "video_segment_id": "segment_0_6",
        "video_start_sec": 0,
        "video_end_sec": 6,
    }


def test_extract_video_segment_metadata_accepts_mixed_bracket_format() -> None:
    metadata = extract_video_segment_metadata("### 章节 2 (00:15 - 00:37)\n后续内容")

    assert metadata["video_start_sec"] == 15
    assert metadata["video_end_sec"] == 37


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


def test_enrich_video_segment_nodes_handles_paren_mmss() -> None:
    """Real Gemini output uses (MM:SS - MM:SS); enrich must capture it."""
    node = TextNode(
        text="### 章节 1：开场 (00:06 - 00:15)\n内容",
        metadata={"filename": "811.video"},
    )

    enrich_video_segment_nodes([node])

    assert node.metadata["video_start_sec"] == 6
    assert node.metadata["video_end_sec"] == 15


def test_extract_video_segment_metadata_rejects_invalid_range() -> None:
    assert (
        extract_video_segment_metadata(
            "### Chapter [00:01:00 - 00:00:30]\nInvalid range"
        )
        is None
    )
