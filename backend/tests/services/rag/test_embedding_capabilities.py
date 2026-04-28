# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from app.schemas.kind import EmbeddingConfig
from knowledge_engine.embedding.capabilities import (
    embedding_supports_image_input,
    normalize_additional_input_modalities,
)


@pytest.mark.unit
class TestEmbeddingCapabilities:
    def test_embedding_config_without_modalities_defaults_to_text_only(self) -> None:
        config = EmbeddingConfig(dimensions=1536)

        assert (
            normalize_additional_input_modalities(config.additional_input_modalities)
            == []
        )
        assert (
            embedding_supports_image_input(config.additional_input_modalities) is False
        )

    def test_embedding_config_with_empty_modalities_stays_text_only(self) -> None:
        config = EmbeddingConfig(
            dimensions=1536,
            additional_input_modalities=[],
        )

        assert (
            normalize_additional_input_modalities(config.additional_input_modalities)
            == []
        )
        assert (
            embedding_supports_image_input(config.additional_input_modalities) is False
        )

    def test_embedding_config_with_image_modality_is_detected(self) -> None:
        config = EmbeddingConfig(
            dimensions=1536,
            additional_input_modalities=["image"],
        )

        assert normalize_additional_input_modalities(
            config.additional_input_modalities
        ) == ["image"]
        assert (
            embedding_supports_image_input(config.additional_input_modalities) is True
        )
