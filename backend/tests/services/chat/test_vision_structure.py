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
    _process_attachment_contexts_for_message,
)
from app.services.chat.preprocessing.external_web_content import (
    build_external_web_content_images,
    build_external_web_content_texts,
    expand_external_web_content_assets,
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

    def test_image_blocks_are_inserted_before_video_blocks(self):
        image_contents = [
            {
                "image_base64": "img1",
                "mime_type": "image/jpeg",
                "image_header": "[Image: cover.jpg]",
            }
        ]
        video_contents = [
            {
                "video_url": "https://s3.example.com/video-1.mp4",
                "mime_type": "video/mp4",
            }
        ]

        result = _build_vision_structure(
            ["External page text\n"], image_contents, video_contents, "Analyze"
        )

        assert [block["type"] for block in result] == [
            "input_text",
            "input_image",
            "input_video",
            "input_text",
        ]


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

    def test_external_web_content_aggregate_expands_asset_contexts(self, test_db):
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )

        comments_context = SubtaskContext(
            subtask_id=0,
            user_id=7,
            context_type=ContextType.ATTACHMENT.value,
            name="comments.md",
            status=ContextStatus.READY.value,
            type_data={"external_media_type": "comments"},
        )
        test_db.add(comments_context)
        test_db.flush()

        aggregate_context = SubtaskContext(
            subtask_id=100,
            user_id=7,
            context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
            name="External post",
            status=ContextStatus.READY.value,
            type_data={
                "source": "external_web_content",
                "asset_context_ids": {
                    "videos": [],
                    "comments": [comments_context.id],
                },
            },
        )

        result = expand_external_web_content_assets(
            db=test_db,
            external_contexts=[aggregate_context],
            user_id=7,
        )

        assert [context.id for context in result] == [comments_context.id]

    def test_external_web_content_text_is_built_from_aggregate_context(self):
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )

        aggregate_context = SubtaskContext(
            subtask_id=100,
            user_id=7,
            context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
            name="External post",
            status=ContextStatus.READY.value,
            type_data={
                "source": "external_web_content",
                "external_source_url": "https://example.com/post/1",
                "site": "example",
                "title": "Article title",
                "author_name": "Alice",
                "publish_time": "2026-06-17",
                "body": "Article summary\n\nArticle body",
            },
        )

        result = build_external_web_content_texts([aggregate_context])

        assert len(result) == 1
        assert "External Web Content: External post" in result[0]
        assert "Title: Article title" in result[0]
        assert "Author: Alice" in result[0]
        assert "Published at: 2026-06-17" in result[0]
        assert "Article summary" in result[0]
        assert "Article body" in result[0]

    def test_external_web_content_images_are_built_from_aggregate_context(self):
        from app.models.subtask_context import (
            ContextStatus,
            ContextType,
            SubtaskContext,
        )

        aggregate_context = SubtaskContext(
            subtask_id=100,
            user_id=7,
            context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
            name="External post",
            status=ContextStatus.READY.value,
            type_data={
                "source": "external_web_content",
                "image_urls": [
                    {
                        "url": "https://public.example.com/cover.jpg",
                        "source_index": 0,
                    }
                ],
            },
        )

        result = build_external_web_content_images([aggregate_context])

        assert result == [
            {
                "image_url": "https://public.example.com/cover.jpg",
                "url": "https://public.example.com/cover.jpg",
                "source_index": 0,
            }
        ]

    @pytest.mark.asyncio
    async def test_external_web_content_text_is_injected_without_asset_attachments(
        self,
    ):
        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[],
            message="Summarize it",
            initial_text_contents=[
                "[External Web Content: External post]\n"
                "Title: Article title\n"
                "Body:\n"
                "Article body\n\n"
            ],
        )

        assert result == [
            {
                "type": "input_text",
                "text": (
                    "<attachment>[External Web Content: External post]\n"
                    "Title: Article title\n"
                    "Body:\n"
                    "Article body\n\n</attachment>"
                ),
            },
            {"type": "input_text", "text": "Summarize it"},
        ]

    def test_external_web_comments_are_injected_as_text_attachment(self):
        context = SimpleNamespace(
            id=44,
            user_id=7,
            context_type="attachment",
            original_filename="post comments.md",
            mime_type="text/markdown",
            file_size=128,
            file_extension=".md",
            image_base64="",
            extracted_text="# External Web First-Screen Comments\n\nGreat post",
            text_length=48,
            type_data={
                "source": "external_web_content",
                "external_media_type": "comments",
            },
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
        )

        assert image_contents == []
        assert video_contents == []
        assert len(text_contents) == 1
        assert "[Attachment 1]" in text_contents[0]
        assert "External Web First-Screen Comments" in text_contents[0]
        assert "Great post" in text_contents[0]

    @pytest.mark.asyncio
    async def test_external_web_text_metadata_order_is_text_video_comments(self):
        video_context = SimpleNamespace(
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
        comments_context = SimpleNamespace(
            id=44,
            user_id=7,
            context_type="attachment",
            original_filename="post comments.md",
            mime_type="text/markdown",
            file_size=128,
            file_extension=".md",
            image_base64="",
            extracted_text="# External Web First-Screen Comments\n\nGreat post",
            text_length=48,
            type_data={
                "source": "external_web_content",
                "external_media_type": "comments",
            },
        )

        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[video_context, comments_context],
            message="Summarize it",
            model_config={"modelCapabilities": {"supportsVideo": False}},
            initial_text_contents=[
                "[External Web Content: External post]\nBody:\nPage body\n\n"
            ],
            initial_image_contents=[
                {"image_url": "https://public.example.com/cover.jpg"}
            ],
        )

        attachment_text = result[0]["text"]
        assert attachment_text.index("Page body") < attachment_text.index(
            "[Video Attachment: clip.mp4"
        )
        assert attachment_text.index("[Video Attachment: clip.mp4") < (
            attachment_text.index("External Web First-Screen Comments")
        )
        assert "[Image Attachment: cover.jpg" not in attachment_text
        assert result[1] == {
            "type": "input_image",
            "image_url": "https://public.example.com/cover.jpg",
        }
        assert "File Path(already in sandbox)" not in attachment_text

    @pytest.mark.asyncio
    async def test_external_web_image_url_is_injected_without_attachment_header(self):
        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[],
            message="Summarize it",
            task_id=6031188,
            subtask_id=7632151,
            initial_text_contents=[
                "[External Web Content: External post]\nBody:\nPage body\n\n"
            ],
            initial_image_contents=[
                {"image_url": "https://public.example.com/cover.jpg"}
            ],
        )

        assert result[0]["type"] == "input_text"
        assert "File Path(already in sandbox)" not in result[0]["text"]
        assert "Image Attachment" not in result[0]["text"]
        assert result[1]["type"] == "input_image"
        assert result[1]["image_url"] == "https://public.example.com/cover.jpg"
        assert result[-1] == {"type": "input_text", "text": "Summarize it"}

    @pytest.mark.asyncio
    async def test_local_image_attachment_is_injected(self):
        image_context = SimpleNamespace(
            id=52,
            user_id=7,
            context_type="attachment",
            original_filename="local-photo.jpg",
            mime_type="image/jpeg",
            file_size=2048,
            file_extension=".jpg",
            image_base64="local-image-base64",
            type_data={},
        )

        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[image_context],
            message="Describe it",
            task_id=6031188,
            subtask_id=7632151,
        )

        assert result[0]["type"] == "input_text"
        assert "Image Attachment: local-photo.jpg" in result[0]["text"]
        assert "File Path in Sandbox" in result[0]["text"]
        assert result[1] == {
            "type": "input_image",
            "image_url": "data:image/jpeg;base64,local-image-base64",
        }
        assert result[-1] == {"type": "input_text", "text": "Describe it"}

    @pytest.mark.asyncio
    async def test_external_web_and_local_images_are_both_injected_in_order(self):
        image_context = SimpleNamespace(
            id=52,
            user_id=7,
            context_type="attachment",
            original_filename="local-photo.jpg",
            mime_type="image/jpeg",
            file_size=2048,
            file_extension=".jpg",
            image_base64="local-image-base64",
            type_data={},
        )

        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[image_context],
            message="Compare them",
            task_id=6031188,
            subtask_id=7632151,
            initial_text_contents=[
                "[External Web Content: External post]\nBody:\nPage body\n\n"
            ],
            initial_image_contents=[
                {"image_url": "https://public.example.com/cover.jpg"}
            ],
        )

        image_blocks = [block for block in result if block["type"] == "input_image"]
        assert image_blocks == [
            {
                "type": "input_image",
                "image_url": "https://public.example.com/cover.jpg",
            },
            {
                "type": "input_image",
                "image_url": "data:image/jpeg;base64,local-image-base64",
            },
        ]
        assert "Page body" in result[0]["text"]
        assert "Image Attachment: local-photo.jpg" in result[0]["text"]
        assert result[-1] == {"type": "input_text", "text": "Compare them"}

    @pytest.mark.asyncio
    async def test_external_web_without_image_urls_omits_image_block(self):
        result = await _process_attachment_contexts_for_message(
            db=object(),
            attachment_contexts=[],
            message="Summarize it",
            task_id=6031188,
            subtask_id=7632151,
            initial_text_contents=[
                "[External Web Content: External post]\nBody:\nPage body\n\n"
            ],
        )

        assert [block["type"] for block in result] == ["input_text", "input_text"]
        assert "Image Attachment" not in result[0]["text"]
        assert "https://s3.example.com/cover.jpg" not in result[0]["text"]
        assert result[-1] == {"type": "input_text", "text": "Summarize it"}

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
