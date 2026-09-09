# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from datetime import datetime
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
@pytest.mark.parametrize(
    "reference_images", [None, ["42"], [42, "https://example.com/ref.png", "42"]]
)
async def test_generated_image_returns_one_hour_download_url(
    reference_images: list[str | int] | None,
) -> None:
    token_info = SimpleNamespace(user_id=7, task_id=8, subtask_id=9)
    db = MagicMock()
    attachment = SimpleNamespace(
        id=42,
        user_id=7,
        context_type="attachment",
        mime_type="image/png",
        file_extension=".png",
        image_base64="aW1hZ2U=",
        storage_backend="mysql",
        storage_key="attachments/42",
        updated_at=datetime(2026, 1, 1),
        original_filename="image.png",
        file_size=5,
        type_data={},
    )
    db.query.return_value.filter.return_value.first.return_value = attachment
    db.get.return_value = attachment
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
            db=db,
            token_info=token_info,
            prompt="draw a lighthouse",
            reference_images=reference_images,
        )

    expected_references = [
        "data:image/png;base64,aW1hZ2U=" if str(value) == "42" else value
        for value in reference_images or []
    ]
    provider.generate.assert_awaited_once_with(
        prompt="draw a lighthouse", reference_images=expected_references
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


@pytest.mark.parametrize(
    "attachment",
    [
        None,
        SimpleNamespace(
            context_type="attachment", file_extension=".png", image_base64=""
        ),
    ],
)
def test_reference_attachment_without_image_data_has_actionable_error(
    attachment: SimpleNamespace | None,
) -> None:
    db = MagicMock()
    db.get.return_value = attachment
    with pytest.raises(
        ValueError, match="Reference attachment 42 has no readable image data"
    ):
        ImageGenerationService._resolve_reference_images(db, [{"attachment_id": 42}])


@pytest.mark.asyncio
async def test_inaccessible_reference_attachment_never_reaches_provider() -> None:
    db = MagicMock()
    db.query.return_value.filter.return_value.first.return_value = None
    with (
        patch(
            "app.services.execution.agents.image.generation_service.resolve_generation_context"
        ),
        patch(
            "app.services.execution.agents.image.generation_service.resolve_generation_model",
            return_value={},
        ),
        patch(
            "app.services.execution.agents.image.generation_service.get_image_provider"
        ) as provider,
        pytest.raises(ValueError, match="Reference attachment not found: 42"),
    ):
        await ImageGenerationService().generate(
            db=db,
            token_info=SimpleNamespace(user_id=7, task_id=8, subtask_id=9),
            prompt="edit",
            reference_images=["42"],
        )
    provider.assert_not_called()
    db.get.assert_not_called()


def test_reference_data_url_is_preserved() -> None:
    data_url = "data:image/png;base64,aW1hZ2U="
    assert ImageGenerationService._resolve_reference_images(
        MagicMock(), [{"url": data_url}]
    ) == [data_url]


def test_reference_descriptor_url_is_preserved_without_attachment_lookup() -> None:
    db = MagicMock()
    url = "https://cdn.example/ref.png"

    assert ImageGenerationService._resolve_reference_images(
        db, [{"attachment_id": 42, "url": url}]
    ) == [url]
    db.get.assert_not_called()


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
