# SPDX-FileCopyrightText: 2026 Weibo, Inc.
# SPDX-License-Identifier: Apache-2.0

from unittest.mock import AsyncMock, patch

import pytest

from app.services.execution.agents.image.attachment_uploader import (
    _persist_image_attachment,
    upload_image_attachment,
)


@pytest.mark.asyncio
async def test_data_url_codec_and_persistence_use_bounded_boundaries() -> None:
    payload = "data:image/png;base64,aGVsbG8="
    persist = AsyncMock(return_value=42)

    with patch(
        "app.services.execution.agents.image.attachment_uploader.run_execution_io",
        persist,
    ):
        attachment_id = await upload_image_attachment(
            image_url=payload,
            image_size="1x1",
            user_id=7,
            task_id=8,
            subtask_id=9,
        )

    assert attachment_id == 42
    persist.assert_awaited_once_with(
        _persist_image_attachment,
        image_data=b"hello",
        image_url=payload,
        image_size="1x1",
        user_id=7,
        subtask_id=9,
        filename="image_8_9_0.png",
        is_data_url=True,
    )
