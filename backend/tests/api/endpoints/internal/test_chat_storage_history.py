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
    def __init__(self, contexts):
        self.contexts = contexts

    def query(self, *args, **kwargs):
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

    assert content[0] == {"type": "text", "text": "describe the video"}
    assert len(content) == 2
    assert "video_url" not in str(content)
    assert "Video Attachment: clip.mp4" in content[1]["text"]
    assert "ID: 30" in content[1]["text"]


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

    assert content[0] == {"type": "text", "text": "describe the video"}
    assert len(content) == 2
    assert "video_url" not in str(content)
    assert "Video Attachment: clip.mp4" in content[1]["text"]
    assert '"fid"' not in content[1]["text"]


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

    assert content[0] == {"type": "text", "text": "describe the video"}
    assert "Video Attachment: clip.mp4" in content[1]["text"]
    assert "stale" not in content[1]["text"]
    assert content[2]["text"].startswith("<system-reminder>")
    assert "video_url" not in str(content)
