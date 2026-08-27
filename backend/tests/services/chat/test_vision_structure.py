# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for _build_vision_structure and _combine_text_contents in contexts module."""

from types import SimpleNamespace
from typing import Any

import pytest

from app.services.chat.preprocessing.contexts import (
    _build_vision_structure,
    _combine_text_contents,
    _process_attachment_context,
)


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
        result = _build_vision_structure([], image_contents, "What is this?")

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
        result = _build_vision_structure([], image_contents, "Describe")

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
        result = _build_vision_structure(text_contents, image_contents, "Summarize")

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
        result = _build_vision_structure([], image_contents, "Compare these")

        image_blocks = [b for b in result if b["type"] == "input_image"]
        assert len(image_blocks) == 2
        assert result[-1]["text"] == "Compare these"

    def test_empty_image_base64_skipped(self):
        """Images without base64 data don't produce image blocks."""
        image_contents = [
            {"image_base64": "", "mime_type": "image/png"},
        ]
        result = _build_vision_structure([], image_contents, "Hello")

        image_blocks = [b for b in result if b["type"] == "input_image"]
        assert len(image_blocks) == 0


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


def _image_context(**overrides: Any) -> SimpleNamespace:
    data = {
        "id": 41,
        "context_type": "attachment",
        "original_filename": "photo.png",
        "mime_type": "image/png",
        "file_size": 1024,
        "file_extension": ".png",
        "image_base64": "aW1hZ2U=",
        "type_data": {"source": "quick_launch_preset"},
    }
    data.update(overrides)
    return SimpleNamespace(**data)


class TestProcessAttachmentContext:
    def test_image_generation_model_uses_reference_image_capability(
        self,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        caplog.set_level(
            "INFO",
            logger="app.services.chat.preprocessing.contexts",
        )
        text_contents: list[str] = []
        image_contents: list[dict] = []

        _process_attachment_context(
            context=_image_context(),
            idx=1,
            text_contents=text_contents,
            image_contents=image_contents,
            task_id=10,
            subtask_id=20,
            model_config={
                "modelType": "image",
                "imageConfig": {
                    "capabilities": {"supports_image_input": True},
                },
            },
        )

        assert image_contents[0]["image_base64"] == "aW1hZ2U="
        assert image_contents[0]["id"] == 41
        assert (
            "Added image input context: id=41 filename=photo.png "
            "source=quick_launch_preset"
        ) in caplog.text
        assert "aW1hZ2U=" not in caplog.text

    @pytest.mark.parametrize(
        "image_config",
        [
            {"capabilities": {"supports_image_input": False}},
            {"max_reference_images": 0},
            {"capabilities": {"max_reference_images": 0}},
        ],
    )
    def test_image_generation_model_rejects_unsupported_reference_image(
        self,
        image_config: dict[str, Any],
    ) -> None:
        text_contents: list[str] = []
        image_contents: list[dict] = []

        _process_attachment_context(
            context=_image_context(),
            idx=1,
            text_contents=text_contents,
            image_contents=image_contents,
            model_config={
                "modelType": "image",
                "imageConfig": image_config,
            },
        )

        assert image_contents == []
        assert "[Image Attachment: photo.png" in text_contents[0]

    @pytest.mark.parametrize(
        "image_config",
        [
            {},
            {"capabilities": {}},
            {"max_reference_images": 1},
        ],
    )
    def test_image_generation_model_allows_reference_image_by_default(
        self,
        image_config: dict[str, Any],
    ) -> None:
        text_contents: list[str] = []
        image_contents: list[dict] = []

        _process_attachment_context(
            context=_image_context(),
            idx=1,
            text_contents=text_contents,
            image_contents=image_contents,
            model_config={
                "modelType": "image",
                "imageConfig": image_config,
            },
        )

        assert image_contents[0]["image_base64"] == "aW1hZ2U="

    @pytest.mark.parametrize(
        ("model_capabilities", "expected_image_count"),
        [
            ({}, 0),
            ({"supportsImage": False}, 0),
            ({"supportsImage": True}, 1),
        ],
    )
    def test_chat_model_requires_declared_image_capability(
        self,
        model_capabilities: dict[str, bool],
        expected_image_count: int,
    ) -> None:
        text_contents: list[str] = []
        image_contents: list[dict] = []

        _process_attachment_context(
            context=_image_context(),
            idx=1,
            text_contents=text_contents,
            image_contents=image_contents,
            model_config={"modelCapabilities": model_capabilities},
        )

        assert len(image_contents) == expected_image_count
