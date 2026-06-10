# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for _build_vision_structure and _combine_text_contents in contexts module."""

from types import SimpleNamespace

import pytest

from app.services.chat.preprocessing.contexts import (
    _build_vision_structure,
    _combine_text_contents,
    _process_attachment_context,
)
from app.services.context.context_service import VideoAttachmentResolutionError


class TestBuildVisionStructure:
    """Tests for the refactored _build_vision_structure function."""

    def test_user_message_is_separate_block(self):
        """User message should be the LAST input_text block, separate from attachment metadata."""
        image_contents = [
            {
                "image_base64": "abc123",
                "mime_type": "image/jpeg",
                "image_header": "[Image: photo.jpg | JPEG | 100x100]",
            }
        ]
        result = _build_vision_structure([], image_contents, [], "What is this?")

        # Expect: 1 attachment block + 1 image block + 1 user message block
        assert len(result) == 3
        assert result[0]["type"] == "input_text"
        assert "<attachment>" in result[0]["text"]
        assert result[1]["type"] == "input_image"
        assert result[2]["type"] == "input_text"
        assert result[2]["text"] == "What is this?"

    def test_no_attachments_no_attachment_block(self):
        """When there are no text contents and no image headers, skip attachment block."""
        image_contents = [{"image_base64": "abc", "mime_type": "image/png"}]
        result = _build_vision_structure([], image_contents, [], "Describe")

        # Expect: 1 image block + 1 user message block (no attachment block)
        assert len(result) == 2
        assert result[0]["type"] == "input_image"
        assert result[1]["type"] == "input_text"
        assert result[1]["text"] == "Describe"

    def test_text_and_image_attachments(self):
        """Both text and image attachments are combined in one <attachment> block."""
        text_contents = ["Document: test.pdf\nContent of PDF"]
        image_contents = [
            {
                "image_base64": "xyz",
                "mime_type": "image/png",
                "image_header": "[Image: chart.png]",
            }
        ]
        result = _build_vision_structure(text_contents, image_contents, [], "Summarize")

        # attachment block should contain both text and image header
        attachment_block = result[0]
        assert "<attachment>" in attachment_block["text"]
        assert "Document: test.pdf" in attachment_block["text"]
        assert "[Image: chart.png]" in attachment_block["text"]

        # Last block is user message (no marker prefix)
        assert result[-1]["text"] == "Summarize"

    def test_multiple_images(self):
        """Multiple images produce multiple input_image blocks."""
        image_contents = [
            {"image_base64": "img1", "mime_type": "image/jpeg"},
            {"image_base64": "img2", "mime_type": "image/png"},
        ]
        result = _build_vision_structure([], image_contents, [], "Compare these")

        image_blocks = [b for b in result if b["type"] == "input_image"]
        assert len(image_blocks) == 2
        assert result[-1]["text"] == "Compare these"

    def test_empty_image_base64_skipped(self):
        """Images without base64 data don't produce image blocks."""
        image_contents = [
            {"image_base64": "", "mime_type": "image/png"},
        ]
        result = _build_vision_structure([], image_contents, [], "Hello")

        image_blocks = [b for b in result if b["type"] == "input_image"]
        assert len(image_blocks) == 0

    def test_video_blocks_are_inserted_before_user_message(self):
        video_contents = [
            {
                "video_url": "https://s3.example.com/video-1.mp4",
                "mime_type": "video/mp4",
            },
            {
                "video_url": "https://s3.example.com/video-2.mp4",
                "mime_type": "video/mp4",
            },
        ]

        result = _build_vision_structure([], [], video_contents, "Analyze videos")

        video_blocks = [block for block in result if block["type"] == "input_video"]
        assert len(video_blocks) == 2
        assert video_blocks[0]["video_url"] == "https://s3.example.com/video-1.mp4"
        assert result[-1] == {"type": "input_text", "text": "Analyze videos"}


class TestCombineTextContents:
    """Tests for _combine_text_contents (returns list of content blocks)."""

    def test_returns_list_with_attachment_and_message(self):
        result = _combine_text_contents(["doc content"], "My question")
        assert isinstance(result, list)
        assert len(result) == 2
        assert result[0]["type"] == "input_text"
        assert "<attachment>" in result[0]["text"]
        assert "doc content" in result[0]["text"]
        assert "</attachment>" in result[0]["text"]
        assert result[1]["type"] == "input_text"
        assert result[1]["text"] == "My question"

    def test_user_message_is_last_block(self):
        result = _combine_text_contents(["doc"], "Question")
        assert result[-1]["text"] == "Question"
        # No [User Question]: marker
        assert "[User Question]:" not in result[-1]["text"]

    def test_multiple_text_contents(self):
        result = _combine_text_contents(["doc1", "doc2"], "Q")
        assert "doc1" in result[0]["text"]
        assert "doc2" in result[0]["text"]
        assert result[1]["text"] == "Q"


class TestProcessAttachmentContext:
    """Tests for video attachment preprocessing branches."""

    def test_video_context_metadata_only_adds_fid_text_without_video_block(self):
        context = SimpleNamespace(
            id=42,
            user_id=7,
            context_type="attachment",
            original_filename="clip.mp4",
            mime_type="video/mp4",
            file_size=1024,
            file_extension=".mp4",
            image_base64="",
            type_data={"fid": "fid-123"},
        )
        text_contents: list[str] = []
        image_contents: list[dict] = []
        video_contents: list[dict] = []

        _process_attachment_context(
            db=object(),
            context=context,
            idx=1,
            text_contents=text_contents,
            image_contents=image_contents,
            video_contents=video_contents,
            model_config={"modelCapabilities": {"supportsVideo": False}},
        )

        assert video_contents == []
        assert image_contents == []
        assert len(text_contents) == 1
        assert "[Video Attachment: clip.mp4" in text_contents[0]
        assert '"fid": "fid-123"' in text_contents[0]

    def test_video_context_metadata_only_requires_fid(self):
        context = SimpleNamespace(
            id=43,
            user_id=7,
            context_type="attachment",
            original_filename="clip.mp4",
            mime_type="video/mp4",
            file_size=1024,
            file_extension=".mp4",
            image_base64="",
            type_data={},
        )

        with pytest.raises(VideoAttachmentResolutionError, match="missing fid"):
            _process_attachment_context(
                db=object(),
                context=context,
                idx=1,
                text_contents=[],
                image_contents=[],
                video_contents=[],
                model_config={"modelCapabilities": {"supportsVideo": False}},
            )
