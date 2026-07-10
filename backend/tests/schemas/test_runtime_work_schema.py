# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest
from pydantic import ValidationError

from app.schemas.runtime_work import RuntimeGuidanceRequest, RuntimeTaskAddress


def test_runtime_guidance_accepts_image_attachment_without_text() -> None:
    request = RuntimeGuidanceRequest(
        address=RuntimeTaskAddress(deviceId="device-1", taskId="runtime-1"),
        attachmentIds=[1],
    )

    assert request.message == ""
    assert request.attachment_ids == [1]


def test_runtime_guidance_requires_text_or_attachment() -> None:
    with pytest.raises(ValidationError, match="message or attachment is required"):
        RuntimeGuidanceRequest(
            address=RuntimeTaskAddress(deviceId="device-1", taskId="runtime-1"),
        )
