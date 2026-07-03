# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import json
from types import SimpleNamespace

from app.api.endpoints.internal.chat_storage import _build_user_message_content
from app.models.subtask_context import ContextStatus, ContextType


class _FakeQuery:
    def __init__(self, result):
        self._result = result

    def filter(self, *args, **kwargs):
        return self

    def order_by(self, *args, **kwargs):
        return self

    def all(self):
        return self._result


class _FakeDb:
    def __init__(self, contexts, *next_results):
        self.contexts = contexts
        self.next_results = list(next_results)
        self.query_count = 0

    def query(self, *args, **kwargs):
        self.query_count += 1
        if self.query_count == 1:
            return _FakeQuery(self.contexts)
        if self.next_results:
            return _FakeQuery(self.next_results.pop(0))
        return _FakeQuery(self.contexts)


def test_history_uses_video_metadata_when_model_does_not_support_video():
    subtask = SimpleNamespace(id=10, prompt="describe the video")
    context = SimpleNamespace(
        id=30,
        context_type=ContextType.ATTACHMENT.value,
        status=ContextStatus.READY.value,
        name="clip.mp4",
        original_filename="clip.mp4",
        mime_type="video/mp4",
        file_extension=".mp4",
        image_base64=None,
        extracted_text="",
        file_size=1024,
        text_length=0,
        type_data={"fid": 123},
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert len(content) == 2
    assert "video_url" not in str(content)
    assert "Video Attachment: clip.mp4" in content[0]["text"]
    assert "ID: 30" in content[0]["text"]
    assert content[1] == {"type": "text", "text": "describe the video"}


def test_history_uses_video_metadata_when_fid_is_missing():
    subtask = SimpleNamespace(id=10, prompt="describe the video")
    context = SimpleNamespace(
        id=30,
        context_type=ContextType.ATTACHMENT.value,
        status=ContextStatus.READY.value,
        name="clip.mp4",
        original_filename="clip.mp4",
        mime_type="video/mp4",
        file_extension=".mp4",
        image_base64=None,
        extracted_text="",
        file_size=1024,
        text_length=0,
        type_data={},
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert len(content) == 2
    assert "video_url" not in str(content)
    assert "Video Attachment: clip.mp4" in content[0]["text"]
    assert '"fid"' not in content[0]["text"]
    assert content[1] == {"type": "text", "text": "describe the video"}


def test_history_keeps_video_metadata_with_stored_extra_blocks():
    subtask = SimpleNamespace(
        id=10,
        prompt=json.dumps(
            [
                {"type": "input_text", "text": "<attachment>stale</attachment>"},
                {"type": "input_text", "text": "describe the video"},
                {
                    "type": "text",
                    "text": "<system-reminder><CurrentTime>now</CurrentTime></system-reminder>",
                },
            ]
        ),
    )
    context = SimpleNamespace(
        id=30,
        context_type=ContextType.ATTACHMENT.value,
        status=ContextStatus.READY.value,
        name="clip.mp4",
        original_filename="clip.mp4",
        mime_type="video/mp4",
        file_extension=".mp4",
        image_base64=None,
        extracted_text="",
        file_size=1024,
        text_length=0,
        type_data={"fid": 123},
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert "Video Attachment: clip.mp4" in content[0]["text"]
    assert "stale" not in content[0]["text"]
    assert content[1] == {"type": "text", "text": "describe the video"}
    assert content[2]["text"].startswith("<system-reminder>")
    assert "video_url" not in str(content)


def test_history_replays_external_web_content_page_text():
    subtask = SimpleNamespace(id=10, user_id=20, prompt="summarize this page")
    context = SimpleNamespace(
        id=40,
        user_id=20,
        context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
        status=ContextStatus.READY.value,
        name="External Note",
        type_data={
            "source": "external_web_content",
            "external_source_url": "https://example.com/post/1",
            "site": "example.com",
            "title": "Page Title",
            "body": "desc text\n\nbody text",
            "asset_context_ids": {"videos": [], "comments": []},
        },
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert len(content) == 2
    assert "<attachment>" in content[0]["text"]
    assert "[External Web Content: External Note]" in content[0]["text"]
    assert "Source: https://example.com/post/1" in content[0]["text"]
    assert "Title: Page Title" in content[0]["text"]
    assert "desc text" in content[0]["text"]
    assert "body text" in content[0]["text"]
    assert content[1] == {"type": "text", "text": "summarize this page"}


def test_history_skips_non_ready_external_web_content():
    subtask = SimpleNamespace(id=10, user_id=20, prompt="summarize this page")
    context = SimpleNamespace(
        id=40,
        user_id=20,
        context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
        status=ContextStatus.PENDING.value,
        name="External Note",
        type_data={
            "source": "external_web_content",
            "external_source_url": "https://example.com/post/1",
            "title": "Page Title",
            "body": "not ready body",
            "asset_context_ids": {"videos": [], "comments": []},
        },
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert content == "summarize this page"


def test_history_replays_external_web_content_image_urls():
    subtask = SimpleNamespace(id=10, user_id=20, prompt="describe the image")
    aggregate_context = SimpleNamespace(
        id=40,
        user_id=20,
        context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
        status=ContextStatus.READY.value,
        name="External Note",
        type_data={
            "source": "external_web_content",
            "external_source_url": "https://example.com/post/1",
            "title": "Page Title",
            "body": "page body",
            "image_urls": [
                {
                    "url": "https://public.example.com/external-image.jpg",
                    "source_index": 0,
                }
            ],
            "asset_context_ids": {"videos": [], "comments": []},
        },
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([aggregate_context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert "<attachment>" in content[0]["text"]
    assert "[External Web Content: External Note]" in content[0]["text"]
    assert "Image Attachment" not in content[0]["text"]
    assert content[1]["type"] == "image_url"
    assert (
        content[1]["image_url"]["url"]
        == "https://public.example.com/external-image.jpg"
    )
    assert content[2] == {"type": "text", "text": "describe the image"}


def test_history_omits_external_web_image_block_without_image_urls():
    subtask = SimpleNamespace(id=10, user_id=20, prompt="describe the image")
    aggregate_context = SimpleNamespace(
        id=40,
        user_id=20,
        context_type=ContextType.EXTERNAL_WEB_CONTENT.value,
        status=ContextStatus.READY.value,
        name="External Note",
        type_data={
            "source": "external_web_content",
            "external_source_url": "https://example.com/post/1",
            "title": "Page Title",
            "body": "page body",
            "asset_context_ids": {"videos": [], "comments": []},
        },
        created_at=None,
    )

    content = _build_user_message_content(
        _FakeDb([aggregate_context]),
        subtask,
        sender_username=None,
        is_group_chat=False,
        model_config={"modelCapabilities": {"supportsVideo": False}},
    )

    assert [block["type"] for block in content] == ["text", "text"]
    assert "Image Attachment" not in content[0]["text"]
    assert content[1] == {"type": "text", "text": "describe the image"}
