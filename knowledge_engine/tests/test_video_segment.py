# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from llama_index.core.schema import TextNode

from knowledge_engine.ingestion.video_segment import (
    enrich_video_segment_nodes,
    extract_video_segment_copy,
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


def test_extract_video_segment_metadata_accepts_unicode_range_separator() -> None:
    metadata = extract_video_segment_metadata("### 章节 2 [00:15–00:37]\n后续内容")

    assert metadata["video_start_sec"] == 15
    assert metadata["video_end_sec"] == 37


@pytest.mark.parametrize(
    "heading",
    [
        "### 酒店枪口下的生死救赎 ([00:31:42] - [00:38:08])",
        "### 酒店枪口下的生死救赎 [00:31:42] - [00:38:08]",
        "### 酒店枪口下的生死救赎 (00:31:42) — (00:38:08)",
        "### 酒店枪口下的生死救赎 【00:31:42 至 00:38:08】",
        "### 酒店枪口下的生死救赎 （【00:31:42】~【00:38:08】）",
        "### 酒店枪口下的生死救赎 00:31:42 - 00:38:08",
    ],
)
def test_extract_video_segment_metadata_accepts_bracket_variants(heading: str) -> None:
    metadata = extract_video_segment_metadata(f"{heading}\n章节内容")

    assert metadata == {
        "video_segment_id": "segment_1902_2288",
        "video_start_sec": 1902,
        "video_end_sec": 2288,
    }


def test_extract_video_segment_copy_removes_endpoint_brackets() -> None:
    copy = extract_video_segment_copy(
        "### 章节 6：酒店枪口下的生死救赎 ([00:31:42] - [00:38:08])\n"
        "> **本段摘要**：查理阻止弗兰克自尽。"
    )

    assert copy == {
        "video_segment_title": "酒店枪口下的生死救赎",
        "video_segment_description": "查理阻止弗兰克自尽。",
    }


def test_extract_video_segment_metadata_ignores_body_timestamp() -> None:
    metadata = extract_video_segment_metadata(
        "正文提到了 [00:00:05 - 00:00:10]\n但这不是章节标题"
    )

    assert metadata is None


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


def test_extract_video_segment_copy_preserves_title_and_summary() -> None:
    copy = extract_video_segment_copy(
        "### 章节 2：引入 Agent 的提效与业务收益 ([02:58:00 - 04:59:00])\n"
        "> **本段摘要**：量化介绍 Agent 的业务收益。"
    )

    assert copy == {
        "video_segment_title": "引入 Agent 的提效与业务收益",
        "video_segment_description": "量化介绍 Agent 的业务收益。",
    }


def test_extract_accepts_mmss_with_minute_over_59() -> None:
    """Long videos may emit (65:00 - 70:00) where minute > 59 in MM:SS form."""
    metadata = extract_video_segment_metadata(
        "### 章节 (65:00 - 70:30)\n长视频章节内容"
    )

    assert metadata == {
        "video_segment_id": "segment_3900_4230",
        "video_start_sec": 3900,
        "video_end_sec": 4230,
    }


def test_extract_rejects_invalid_seconds_in_mmss() -> None:
    """Seconds > 59 are invalid even in MM:SS form."""
    assert extract_video_segment_metadata("### 章节 (00:75 - 01:30)\n无效秒数") is None


def test_enrich_video_segment_nodes_copies_display_metadata_to_parent() -> None:
    node = TextNode(
        text=(
            "### 章节 1：课程导入 ([00:00:00 - 00:01:00])\n"
            "> **本段摘要**：介绍课程背景。"
        ),
        metadata={"filename": "813.video"},
    )

    enrich_video_segment_nodes([node])

    assert node.metadata["video_segment_title"] == "课程导入"
    assert node.metadata["video_segment_description"] == "介绍课程背景。"
