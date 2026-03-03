# SPDX-FileCopyrightText: 2025 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""
Tests for generation-related schemas.

Tests the ImageGenerationConfig and VideoGenerationConfig schemas including:
- Default values
- Field validation (max_images range, etc.)
"""

import pytest
from pydantic import ValidationError


class TestImageGenerationConfig:
    """Tests for ImageGenerationConfig schema."""

    def test_default_values(self):
        """Test that default values are set correctly."""
        from app.schemas.generation import ImageGenerationConfig

        config = ImageGenerationConfig()

        assert config.size == "2048x2048"
        assert config.sequential_image_generation == "disabled"
        assert config.max_images == 1
        assert config.response_format == "url"
        assert config.output_format == "jpeg"
        assert config.watermark is False
        assert config.optimize_prompt_mode == "standard"
        assert config.max_reference_images == 1

    def test_custom_values(self):
        """Test setting custom values."""
        from app.schemas.generation import ImageGenerationConfig

        config = ImageGenerationConfig(
            size="3K",
            sequential_image_generation="auto",
            max_images=10,
            response_format="b64_json",
            output_format="png",
            watermark=True,
            optimize_prompt_mode="fast",
            max_reference_images=5,
        )

        assert config.size == "3K"
        assert config.sequential_image_generation == "auto"
        assert config.max_images == 10
        assert config.response_format == "b64_json"
        assert config.output_format == "png"
        assert config.watermark is True
        assert config.optimize_prompt_mode == "fast"
        assert config.max_reference_images == 5

    def test_max_images_minimum_value(self):
        """Test max_images minimum value validation (ge=1)."""
        from app.schemas.generation import ImageGenerationConfig

        # Valid minimum value
        config = ImageGenerationConfig(max_images=1)
        assert config.max_images == 1

        # Invalid value below minimum
        with pytest.raises(ValidationError) as exc_info:
            ImageGenerationConfig(max_images=0)

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert errors[0]["loc"] == ("max_images",)
        assert "greater than or equal to 1" in errors[0]["msg"]

    def test_max_images_maximum_value(self):
        """Test max_images maximum value validation (le=15)."""
        from app.schemas.generation import ImageGenerationConfig

        # Valid maximum value
        config = ImageGenerationConfig(max_images=15)
        assert config.max_images == 15

        # Invalid value above maximum
        with pytest.raises(ValidationError) as exc_info:
            ImageGenerationConfig(max_images=16)

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert errors[0]["loc"] == ("max_images",)
        assert "less than or equal to 15" in errors[0]["msg"]

    def test_max_images_negative_value(self):
        """Test max_images rejects negative values."""
        from app.schemas.generation import ImageGenerationConfig

        with pytest.raises(ValidationError):
            ImageGenerationConfig(max_images=-1)

    def test_max_images_valid_range(self):
        """Test max_images accepts values in valid range."""
        from app.schemas.generation import ImageGenerationConfig

        for value in [1, 5, 10, 15]:
            config = ImageGenerationConfig(max_images=value)
            assert config.max_images == value

    def test_max_reference_images_minimum_value(self):
        """Test max_reference_images minimum value validation (ge=1)."""
        from app.schemas.generation import ImageGenerationConfig

        # Valid minimum value
        config = ImageGenerationConfig(max_reference_images=1)
        assert config.max_reference_images == 1

        # Invalid value below minimum
        with pytest.raises(ValidationError) as exc_info:
            ImageGenerationConfig(max_reference_images=0)

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert errors[0]["loc"] == ("max_reference_images",)
        assert "greater than or equal to 1" in errors[0]["msg"]

    def test_max_reference_images_maximum_value(self):
        """Test max_reference_images maximum value validation (le=10)."""
        from app.schemas.generation import ImageGenerationConfig

        # Valid maximum value
        config = ImageGenerationConfig(max_reference_images=10)
        assert config.max_reference_images == 10

        # Invalid value above maximum
        with pytest.raises(ValidationError) as exc_info:
            ImageGenerationConfig(max_reference_images=11)

        errors = exc_info.value.errors()
        assert len(errors) == 1
        assert errors[0]["loc"] == ("max_reference_images",)
        assert "less than or equal to 10" in errors[0]["msg"]

    def test_max_reference_images_valid_range(self):
        """Test max_reference_images accepts values in valid range."""
        from app.schemas.generation import ImageGenerationConfig

        for value in [1, 3, 5, 10]:
            config = ImageGenerationConfig(max_reference_images=value)
            assert config.max_reference_images == value

    def test_size_various_formats(self):
        """Test size field accepts various formats."""
        from app.schemas.generation import ImageGenerationConfig

        # Resolution format
        config = ImageGenerationConfig(size="2K")
        assert config.size == "2K"

        config = ImageGenerationConfig(size="3K")
        assert config.size == "3K"

        # Pixel dimensions format
        config = ImageGenerationConfig(size="1024x1024")
        assert config.size == "1024x1024"

        config = ImageGenerationConfig(size="2048x2048")
        assert config.size == "2048x2048"

        config = ImageGenerationConfig(size="2304x1728")
        assert config.size == "2304x1728"

    def test_optional_fields_can_be_none(self):
        """Test that optional fields can be set to None."""
        from app.schemas.generation import ImageGenerationConfig

        config = ImageGenerationConfig(
            size=None,
            sequential_image_generation=None,
            max_images=None,
            response_format=None,
            output_format=None,
            watermark=None,
            optimize_prompt_mode=None,
            max_reference_images=None,
        )

        assert config.size is None
        assert config.sequential_image_generation is None
        assert config.max_images is None
        assert config.response_format is None
        assert config.output_format is None
        assert config.watermark is None
        assert config.optimize_prompt_mode is None
        assert config.max_reference_images is None

    def test_model_dump(self):
        """Test model serialization."""
        from app.schemas.generation import ImageGenerationConfig

        config = ImageGenerationConfig(
            size="2K",
            max_images=5,
            watermark=True,
        )

        data = config.model_dump()

        assert data["size"] == "2K"
        assert data["max_images"] == 5
        assert data["watermark"] is True
        assert data["sequential_image_generation"] == "disabled"  # default

    def test_model_dump_exclude_none(self):
        """Test model serialization excluding None values."""
        from app.schemas.generation import ImageGenerationConfig

        config = ImageGenerationConfig(
            size="2K",
            output_format=None,
        )

        data = config.model_dump(exclude_none=True)

        assert data["size"] == "2K"
        assert "output_format" not in data

    def test_from_dict(self):
        """Test creating config from dictionary."""
        from app.schemas.generation import ImageGenerationConfig

        data = {
            "size": "3K",
            "max_images": 8,
            "watermark": True,
        }

        config = ImageGenerationConfig(**data)

        assert config.size == "3K"
        assert config.max_images == 8
        assert config.watermark is True

    def test_extra_fields_ignored(self):
        """Test that extra fields are ignored (default Pydantic behavior)."""
        from app.schemas.generation import ImageGenerationConfig

        # Extra fields should be ignored by default
        config = ImageGenerationConfig(
            size="2K",
            unknown_field="value",  # This should be ignored
        )

        assert config.size == "2K"
        assert not hasattr(config, "unknown_field")


class TestVideoGenerationConfig:
    """Tests for VideoGenerationConfig schema."""

    def test_default_values(self):
        """Test that default values are set correctly."""
        from app.schemas.generation import VideoGenerationConfig

        config = VideoGenerationConfig()

        assert config.resolution == "1080p"
        assert config.fps == 24
        assert config.max_duration is None

    def test_custom_values(self):
        """Test setting custom values."""
        from app.schemas.generation import VideoGenerationConfig

        config = VideoGenerationConfig(
            resolution="4K",
            fps=60,
            max_duration=120,
        )

        assert config.resolution == "4K"
        assert config.fps == 60
        assert config.max_duration == 120

    def test_optional_fields_can_be_none(self):
        """Test that optional fields can be set to None."""
        from app.schemas.generation import VideoGenerationConfig

        config = VideoGenerationConfig(
            resolution=None,
            fps=None,
            max_duration=None,
        )

        assert config.resolution is None
        assert config.fps is None
        assert config.max_duration is None


class TestModelSpecWithImageConfig:
    """Tests for ModelSpec with imageConfig field."""

    def test_model_spec_with_image_config(self):
        """Test ModelSpec includes imageConfig field."""
        from app.schemas.generation import ImageGenerationConfig
        from app.schemas.kind import ModelSpec

        image_config = ImageGenerationConfig(
            size="2K",
            max_images=5,
        )

        spec = ModelSpec(
            modelConfig={"model": "doubao-seedream-5.0-lite"},
            modelType="image",
            protocol="seedream",
            imageConfig=image_config,
        )

        assert spec.modelType == "image"
        assert spec.imageConfig is not None
        assert spec.imageConfig.size == "2K"
        assert spec.imageConfig.max_images == 5

    def test_model_spec_without_image_config(self):
        """Test ModelSpec works without imageConfig."""
        from app.schemas.kind import ModelSpec

        spec = ModelSpec(
            modelConfig={"model": "gpt-4"},
            modelType="llm",
            protocol="openai",
        )

        assert spec.modelType == "llm"
        assert spec.imageConfig is None

    def test_model_spec_image_config_from_dict(self):
        """Test ModelSpec with imageConfig from dictionary."""
        from app.schemas.kind import ModelSpec

        data = {
            "modelConfig": {"model": "doubao-seedream-5.0-lite"},
            "modelType": "image",
            "protocol": "seedream",
            "imageConfig": {
                "size": "3K",
                "max_images": 10,
                "watermark": True,
            },
        }

        spec = ModelSpec(**data)

        assert spec.imageConfig is not None
        assert spec.imageConfig.size == "3K"
        assert spec.imageConfig.max_images == 10
        assert spec.imageConfig.watermark is True
