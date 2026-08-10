# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.services.execution.agents.image.generation_service import (
    ImageGenerationService,
)


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
