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
    RuntimeEmbeddingModelConfig,
    RuntimeRetrieverConfig,
)

from .conftest import _make_model_kind, _make_retriever_kind


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


class TestBuildResolvedEmbeddingModelConfig:
    """Tests for ConfigResolver._build_resolved_embedding_model_config."""

    def test_success(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test building resolved embedding model config."""
        spec = {
            "protocol": "openai",
            "modelConfig": {
                "env": {
                    "api_key": "sk-enc-key",
                    "base_url": "https://api.openai.com/v1",
                    "model_id": "text-embedding-3-small",
                    "custom_headers": {"X-Custom": "value"},
                },
            },
            "embeddingConfig": {"dimensions": 1536},
        }
        model = _make_model_kind(spec=spec)

        with (
            patch.object(resolver, "_get_model_kind", return_value=model),
            patch.object(
                resolver,
                "_decrypt_optional_value",
                side_effect=lambda v: f"dec_{v}" if v and v.startswith("sk-enc") else v,
            ),
            patch(
                "knowledge_runtime.services.config_resolver.process_custom_headers_placeholders",
                side_effect=lambda h, u: h,
            ),
        ):
            result = resolver._build_resolved_embedding_model_config(
                db=mock_db,
                user_id=42,
                model_name="text-embedding-3-small",
                model_namespace="default",
                user_name="testuser",
            )

        assert isinstance(result, RuntimeEmbeddingModelConfig)
        assert result.model_name == "text-embedding-3-small"
        assert result.model_namespace == "default"
        assert result.resolved_config["protocol"] == "openai"
        assert result.resolved_config["api_key"] == "dec_sk-enc-key"
        assert result.resolved_config["base_url"] == "https://api.openai.com/v1"
        assert result.resolved_config["model_id"] == "text-embedding-3-small"
        assert result.resolved_config["dimensions"] == 1536

    def test_protocol_fallback_to_env_model(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test that protocol falls back to env.model when spec.protocol is absent."""
        spec = {
            "modelConfig": {
                "env": {
                    "model": "anthropic",
                    "api_key": "sk-test",
                    "base_url": "https://api.anthropic.com",
                    "model_id": "claude-embedding",
                    "custom_headers": {},
                },
            },
            "embeddingConfig": {},
        }
        model = _make_model_kind(spec=spec)

        with (
            patch.object(resolver, "_get_model_kind", return_value=model),
            patch.object(resolver, "_decrypt_optional_value", side_effect=lambda v: v),
            patch(
                "knowledge_runtime.services.config_resolver.process_custom_headers_placeholders",
                side_effect=lambda h, u: h,
            ),
        ):
            result = resolver._build_resolved_embedding_model_config(
                db=mock_db,
                user_id=42,
                model_name="claude-embedding",
                model_namespace="default",
                user_name="testuser",
            )

        assert result.resolved_config["protocol"] == "anthropic"

    def test_no_embedding_config_section(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test missing embeddingConfig section sets dimensions to None."""
        spec = {
            "protocol": "openai",
            "modelConfig": {
                "env": {
                    "api_key": "sk-test",
                    "base_url": "https://api.openai.com/v1",
                    "model_id": "text-embedding-3-small",
                    "custom_headers": {},
                },
            },
        }
        model = _make_model_kind(spec=spec)

        with (
            patch.object(resolver, "_get_model_kind", return_value=model),
            patch.object(resolver, "_decrypt_optional_value", side_effect=lambda v: v),
            patch(
                "knowledge_runtime.services.config_resolver.process_custom_headers_placeholders",
                side_effect=lambda h, u: h,
            ),
        ):
            result = resolver._build_resolved_embedding_model_config(
                db=mock_db,
                user_id=42,
                model_name="text-embedding-3-small",
                model_namespace="default",
                user_name="testuser",
            )

        assert result.resolved_config["dimensions"] is None

    def test_model_not_found(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test missing model raises ConfigResolutionError."""
        with patch.object(resolver, "_get_model_kind", return_value=None):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver._build_resolved_embedding_model_config(
                    db=mock_db,
                    user_id=42,
                    model_name="missing-model",
                    model_namespace="default",
                    user_name="testuser",
                )

            assert exc_info.value.code == "config_not_found"
            assert "missing-model" in str(exc_info.value)

    def test_custom_headers_placeholders_processed(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test that custom_headers with placeholders are processed."""
        spec = {
            "protocol": "openai",
            "modelConfig": {
                "env": {
                    "api_key": "sk-test",
                    "base_url": "https://api.openai.com/v1",
                    "model_id": "text-embedding-3-small",
                    "custom_headers": {"X-User": "${user.name}"},
                },
            },
            "embeddingConfig": {},
        }
        model = _make_model_kind(spec=spec)

        with (
            patch.object(resolver, "_get_model_kind", return_value=model),
            patch.object(resolver, "_decrypt_optional_value", side_effect=lambda v: v),
        ):
            result = resolver._build_resolved_embedding_model_config(
                db=mock_db,
                user_id=42,
                model_name="text-embedding-3-small",
                model_namespace="default",
                user_name="alice",
            )

        assert result.resolved_config["custom_headers"]["X-User"] == "alice"
