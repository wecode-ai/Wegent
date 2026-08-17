# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch
from urllib.parse import parse_qs, urlparse

import pytest

from app.services.attachment.public_link import verify_public_attachment_token
from app.services.execution.agents.image.download_url import (
    IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS,
)
from app.services.execution.agents.image.generation_service import (
    ImageGenerationService,
)
from app.services.execution.agents.image.providers.base import (
    ImageGenerationResult,
    ImageResult,
)


@pytest.mark.asyncio
async def test_generated_image_returns_one_hour_download_url() -> None:
    token_info = SimpleNamespace(user_id=7, task_id=8, subtask_id=9)
    provider = MagicMock()
    provider.generate = AsyncMock(
        return_value=ImageGenerationResult(
            images=[ImageResult(url="https://provider.example/image.png")],
            model="image-model",
        )
    )

    with (
        patch(
            "app.services.execution.agents.image.generation_service."
            "resolve_generation_context",
            return_value=MagicMock(),
        ),
        patch(
            "app.services.execution.agents.image.generation_service."
            "resolve_generation_model",
            return_value={"protocol": "gpt-image", "imageConfig": {}},
        ),
        patch(
            "app.services.execution.agents.image.generation_service."
            "normalize_reference_materials",
            return_value=[],
        ),
        patch(
            "app.services.execution.agents.image.generation_service."
            "get_image_provider",
            return_value=provider,
        ),
        patch(
            "app.services.execution.agents.image.generation_service."
            "upload_image_attachment",
            new=AsyncMock(return_value=42),
        ),
        patch(
            "app.services.execution.agents.image.download_url."
            "settings.WEGENT_BACKEND_PUBLIC_URL",
            "https://files.example",
        ),
    ):
        result = await ImageGenerationService().generate(
            db=MagicMock(),
            token_info=token_info,
            prompt="draw a lighthouse",
        )

    image = result["images"][0]
    parsed_url = urlparse(image["url"])
    token = parse_qs(parsed_url.query)["token"][0]
    payload = verify_public_attachment_token(token)

    assert parsed_url.scheme == "https"
    assert parsed_url.netloc == "files.example"
    assert parsed_url.path == "/api/attachments/download/shared"
    assert payload["attachment_id"] == 42
    assert payload["exp"] - payload["iat"] == IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS
    assert image["expires_in_seconds"] == IMAGE_DOWNLOAD_URL_EXPIRES_SECONDS
    assert image["attachment_url"] == "/api/attachments/42/download"
    assert result["result_data"]["blocks"][0]["image_urls"] == [
        "/api/attachments/42/download"
    ]
    assert result["result_data"]["blocks"][0]["image_download_urls"] == [image["url"]]


def test_reference_image_format_uses_model_capabilities() -> None:
    image_config = {
        "capabilities": {
            "supports_image_input": True,
            "max_reference_images": 2,
            "image_formats": ["png", "webp"],
        }
    }

    with pytest.raises(ValueError, match="Unsupported reference image format: gif"):
        ImageGenerationService._validate_reference_images(
            image_config,
            [{"file_extension": ".gif"}],
        )


def test_reference_image_format_accepts_jpg_for_jpeg_capability() -> None:
    image_config = {
        "capabilities": {
            "supports_image_input": True,
            "max_reference_images": 2,
            "image_formats": ["jpeg"],
        }
    }

    ImageGenerationService._validate_reference_images(
        image_config,
        [{"file_extension": ".jpg"}],
    )


def test_reference_image_format_is_not_restricted_without_model_configuration() -> None:
    ImageGenerationService._validate_reference_images(
        {"capabilities": {"supports_image_input": True}},
        [{"file_extension": ".gif"}],
    )
