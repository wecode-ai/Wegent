# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver builder methods."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_runtime.services.config_resolver import (
    ConfigResolutionError,
    ConfigResolver,
)
from shared.models import (
    RuntimeRetrieverConfig,
)

from .conftest import _make_retriever_kind


class TestBuildResolvedRetrieverConfig:
    """Tests for ConfigResolver._build_resolved_retriever_config."""

    def test_success(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test building resolved retriever config with decrypted credentials."""
        storage_config = {
            "type": "qdrant",
            "url": "http://localhost:6333",
            "username": "admin",
            "password": "enc_password",
            "apiKey": "enc_api_key",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {"timeout": 30},
        }
        retriever = _make_retriever_kind(storage_config=storage_config)

        with (
            patch.object(resolver, "_get_retriever_kind", return_value=retriever),
            patch.object(
                resolver,
                "_decrypt_optional_value",
                side_effect=lambda v: (
                    f"decrypted_{v}" if v and v.startswith("enc_") else v
                ),
            ),
        ):
            result = resolver._build_resolved_retriever_config(
                db=mock_db,
                user_id=42,
                name="test-retriever",
                namespace="default",
            )

        assert isinstance(result, RuntimeRetrieverConfig)
        assert result.name == "test-retriever"
        assert result.namespace == "default"
        assert result.storage_config["type"] == "qdrant"
        assert result.storage_config["url"] == "http://localhost:6333"
        assert result.storage_config["password"] == "decrypted_enc_password"
        assert result.storage_config["apiKey"] == "decrypted_enc_api_key"
        assert result.storage_config["indexStrategy"] == {"mode": "per_dataset"}
        assert result.storage_config["ext"] == {"timeout": 30}

    def test_default_index_strategy(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test that missing indexStrategy defaults to per_dataset."""
        storage_config = {
            "type": "qdrant",
            "url": "http://localhost:6333",
        }
        retriever = _make_retriever_kind(storage_config=storage_config)

        with (
            patch.object(resolver, "_get_retriever_kind", return_value=retriever),
            patch.object(resolver, "_decrypt_optional_value", side_effect=lambda v: v),
        ):
            result = resolver._build_resolved_retriever_config(
                db=mock_db,
                user_id=42,
                name="test-retriever",
                namespace="default",
            )

        assert result.storage_config["indexStrategy"] == {"mode": "per_dataset"}
        assert result.storage_config["ext"] == {}

    def test_retriever_not_found(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test that missing retriever raises ConfigResolutionError."""
        with patch.object(resolver, "_get_retriever_kind", return_value=None):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver._build_resolved_retriever_config(
                    db=mock_db,
                    user_id=42,
                    name="missing-retriever",
                    namespace="default",
                )

            assert exc_info.value.code == "config_not_found"
            assert "missing-retriever" in str(exc_info.value)
