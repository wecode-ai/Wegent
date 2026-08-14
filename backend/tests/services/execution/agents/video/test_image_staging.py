# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.video.image_staging import (
    DirectVideoImageStagingBackend,
)


@pytest.mark.asyncio
async def test_direct_staging_preserves_images_without_mutating_input() -> None:
    images = [{"url": "https://example.com/image.png", "attachment_id": 1}]

    result = await DirectVideoImageStagingBackend().stage(images, user_id=2)

    assert result == images
    assert result is not images
    assert result[0] is not images[0]


@pytest.mark.asyncio
async def test_direct_staging_resolves_attachment_url(mocker) -> None:
    mocker.patch(
        "app.services.execution.agents.video.image_staging."
        "settings.ATTACHMENT_PUBLIC_BASE_URL",
        "https://backend.example.com",
    )
    mocker.patch(
        "app.services.execution.agents.video.image_staging."
        "generate_public_attachment_token",
        return_value="signed-token",
    )

    result = await DirectVideoImageStagingBackend().stage(
        [{"attachment_id": 51, "mime_type": "image/png"}],
        user_id=2,
    )

    assert result[0]["url"] == (
        "https://backend.example.com/api/attachments/download/shared"
        "?token=signed-token"
    )


@pytest.mark.asyncio
async def test_direct_staging_requires_public_base_url_for_attachment(
    mocker,
) -> None:
    mocker.patch(
        "app.services.execution.agents.video.image_staging."
        "settings.ATTACHMENT_PUBLIC_BASE_URL",
        "",
    )

    with pytest.raises(ValueError, match="direct backend"):
        await DirectVideoImageStagingBackend().stage(
            [{"attachment_id": 51, "mime_type": "image/png"}],
            user_id=2,
        )
