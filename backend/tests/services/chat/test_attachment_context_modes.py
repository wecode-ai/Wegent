# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for attachment prompt injection modes."""

from types import SimpleNamespace

import pytest

from app.models.subtask_context import ContextStatus, ContextType
from app.services.chat.preprocessing.contexts import (
    _process_attachment_contexts_for_message,
)


def _attachment(**overrides):
    data = {
        "id": 17,
        "context_type": ContextType.ATTACHMENT.value,
        "status": ContextStatus.READY.value,
        "original_filename": "report.md",
        "mime_type": "text/markdown",
        "file_size": 2048,
        "file_extension": ".md",
        "extracted_text": "Backend parsed content should not be injected.",
        "image_base64": "",
    }
    data.update(overrides)
    return SimpleNamespace(**data)


@pytest.mark.asyncio
async def test_metadata_only_attachment_context_omits_backend_parsed_text():
    result = await _process_attachment_contexts_for_message(
        [_attachment()],
        "please inspect it",
        task_id=78,
        subtask_id=213,
        inline_attachment_content=False,
    )

    assert isinstance(result, list)
    attachment_text = result[0]["text"]
    assert "Backend parsed content should not be injected." not in attachment_text
    assert "[Attachment: report.md | ID: 17" in attachment_text
    assert "/home/user/78:executor:attachments/213/report.md" in attachment_text
    assert result[1]["text"] == "please inspect it"


@pytest.mark.asyncio
async def test_metadata_only_image_context_omits_image_block():
    result = await _process_attachment_contexts_for_message(
        [
            _attachment(
                original_filename="image.png",
                mime_type="image/png",
                file_extension=".png",
                image_base64="base64-image-data",
            )
        ],
        "what is this?",
        task_id=78,
        subtask_id=213,
        inline_attachment_content=False,
    )

    assert isinstance(result, list)
    assert all(block["type"] != "input_image" for block in result)
    assert "[Image Attachment: image.png | ID: 17" in result[0]["text"]
    assert "base64-image-data" not in result[0]["text"]
