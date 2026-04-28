# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver helper methods."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_runtime.services.config_resolver import (
    ConfigResolutionError,
    ConfigResolver,
)

from .conftest import (
    _make_document,
    _make_kb_kind,
    _make_model_kind,
    _make_retriever_kind,
    _make_user,
)


class TestGetKnowledgeBase:
    """Tests for ConfigResolver._get_knowledge_base."""

    def test_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test KB found returns the record."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        mock_db.query.return_value.filter.return_value.first.return_value = kb

        result = resolver._get_knowledge_base(mock_db, 1)

        assert result.id == 1
        assert result.user_id == 42

    def test_not_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test KB not found raises ConfigResolutionError."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver._get_knowledge_base(mock_db, 999)

        assert exc_info.value.code == "config_not_found"
        assert "999 not found" in str(exc_info.value)


class TestParseKbRetrievalConfig:
    """Tests for ConfigResolver._parse_kb_retrieval_config."""

    def test_full_config(self, resolver: ConfigResolver) -> None:
        """Test parsing a fully populated retrieval config."""
        retrieval_config = {
            "retriever_name": "my-retriever",
            "retriever_namespace": "production",
            "embedding_config": {
                "model_name": "text-embedding-3-large",
                "model_namespace": "custom",
            },
            "top_k": 15,
            "score_threshold": 0.6,
            "retrieval_mode": "hybrid",
            "hybrid_weights": {"vector_weight": 0.8, "keyword_weight": 0.2},
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        result = resolver._parse_kb_retrieval_config(kb)

        assert result["retriever_name"] == "my-retriever"
        assert result["retriever_namespace"] == "production"
        assert result["embedding_model_name"] == "text-embedding-3-large"
        assert result["embedding_model_namespace"] == "custom"
        assert result["top_k"] == 15
        assert result["score_threshold"] == 0.6
        assert result["retrieval_mode"] == "hybrid"
        assert result["hybrid_weights"] == {"vector_weight": 0.8, "keyword_weight": 0.2}

    def test_defaults(self, resolver: ConfigResolver) -> None:
        """Test parsing with minimal config uses defaults."""
        retrieval_config = {
            "retriever_name": "my-retriever",
            "embedding_config": {
                "model_name": "text-embedding-3-small",
            },
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        result = resolver._parse_kb_retrieval_config(kb)

        assert result["retriever_namespace"] == "default"
        assert result["embedding_model_namespace"] == "default"
        assert result["top_k"] == 20
        assert result["score_threshold"] == 0.7
        assert result["retrieval_mode"] == "vector"
        assert result["hybrid_weights"] is None

    def test_missing_retriever_name(self, resolver: ConfigResolver) -> None:
        """Test missing retriever_name raises ConfigResolutionError."""
        retrieval_config = {
            "embedding_config": {"model_name": "text-embedding-3-small"},
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver._parse_kb_retrieval_config(kb)

        assert exc_info.value.code == "config_incomplete"
        assert "missing retriever_name" in str(exc_info.value)

    def test_missing_embedding_model_name(self, resolver: ConfigResolver) -> None:
        """Test missing embedding model_name raises ConfigResolutionError."""
        retrieval_config = {
            "retriever_name": "my-retriever",
            "embedding_config": {},
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver._parse_kb_retrieval_config(kb)

        assert exc_info.value.code == "config_incomplete"
        assert "incomplete embedding config" in str(exc_info.value)

    def test_empty_retrieval_config(self, resolver: ConfigResolver) -> None:
        """Test empty retrieval config raises ConfigResolutionError."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42, retrieval_config={})

        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver._parse_kb_retrieval_config(kb)

        assert exc_info.value.code == "config_incomplete"


class TestGetSplitterConfig:
    """Tests for ConfigResolver._get_splitter_config."""

    def test_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test document found returns its splitter_config."""
        doc = _make_document(document_id=100, splitter_config={"chunk_size": 512})
        mock_db.query.return_value.filter.return_value.first.return_value = doc

        result = resolver._get_splitter_config(mock_db, 100)

        assert result == {"chunk_size": 512}

    def test_not_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test document not found raises ConfigResolutionError."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver._get_splitter_config(mock_db, 999)

        assert exc_info.value.code == "config_not_found"
        assert "999 not found" in str(exc_info.value)

    def test_null_splitter_config(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test document with null splitter_config returns empty dict."""
        doc = _make_document(document_id=100, splitter_config=None)
        mock_db.query.return_value.filter.return_value.first.return_value = doc

        result = resolver._get_splitter_config(mock_db, 100)

        assert result == {}


class TestGetUserName:
    """Tests for ConfigResolver._get_user_name."""

    def test_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test user found returns user_name."""
        user = _make_user(user_id=42, user_name="testuser")
        mock_db.query.return_value.filter.return_value.first.return_value = user

        result = resolver._get_user_name(mock_db, 42)

        assert result == "testuser"

    def test_not_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test user not found returns None."""
        mock_db.query.return_value.filter.return_value.first.return_value = None

        result = resolver._get_user_name(mock_db, 999)

        assert result is None


class TestDecryptOptionalValue:
    """Tests for ConfigResolver._decrypt_optional_value."""

    def test_none_value(self) -> None:
        """Test None value returns None."""
        result = ConfigResolver._decrypt_optional_value(None)
        assert result is None

    def test_empty_string(self) -> None:
        """Test empty string returns empty string."""
        result = ConfigResolver._decrypt_optional_value("")
        assert result == ""

    def test_successful_decrypt(self) -> None:
        """Test successful decryption returns decrypted value."""
        with patch(
            "knowledge_runtime.services.config_resolver.decrypt_api_key",
            return_value="decrypted_value",
        ):
            result = ConfigResolver._decrypt_optional_value("encrypted_value")
            assert result == "decrypted_value"

    def test_failed_decrypt_returns_original(self) -> None:
        """Test failed decryption returns the original value."""
        with patch(
            "knowledge_runtime.services.config_resolver.decrypt_api_key",
            side_effect=Exception("Decryption failed"),
        ):
            result = ConfigResolver._decrypt_optional_value("encrypted_value")
            assert result == "encrypted_value"

    def test_plain_text_api_key(self) -> None:
        """Test plain text API key (sk- prefix) is returned as-is by decrypt_api_key."""
        with patch(
            "knowledge_runtime.services.config_resolver.decrypt_api_key",
            return_value="sk-plain-key",
        ):
            result = ConfigResolver._decrypt_optional_value("sk-plain-key")
            assert result == "sk-plain-key"


class TestGetRetrieverKind:
    """Tests for ConfigResolver._get_retriever_kind."""

    def test_default_namespace_queries_with_user_priority(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test default namespace queries with user_id priority."""
        retriever = _make_retriever_kind()
        mock_db.query.return_value.filter.return_value.filter.return_value.order_by.return_value.first.return_value = (
            retriever
        )

        result = resolver._get_retriever_kind(
            mock_db, user_id=42, name="test-retriever", namespace="default"
        )

        assert result is not None
        mock_db.query.assert_called()

    def test_group_namespace_queries_without_user_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test group namespace queries without user_id filter."""
        retriever = _make_retriever_kind(namespace="team-ns")
        mock_db.query.return_value.filter.return_value.first.return_value = retriever

        result = resolver._get_retriever_kind(
            mock_db, user_id=42, name="test-retriever", namespace="team-ns"
        )

        assert result is not None

    def test_group_namespace_fallback_to_public(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test group namespace falls back to public retriever (user_id=0)."""
        public_retriever = _make_retriever_kind()

        # First query (group namespace) returns None, second query (public fallback) returns result
        mock_db.query.return_value.filter.return_value.first.side_effect = [
            None,
            public_retriever,
        ]

        result = resolver._get_retriever_kind(
            mock_db, user_id=42, name="test-retriever", namespace="team-ns"
        )

        assert result is not None


class TestGetModelKind:
    """Tests for ConfigResolver._get_model_kind."""

    def test_default_namespace_queries_with_user_priority(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test default namespace queries with user_id priority."""
        model = _make_model_kind()
        mock_db.query.return_value.filter.return_value.filter.return_value.order_by.return_value.first.return_value = (
            model
        )

        result = resolver._get_model_kind(
            db=mock_db,
            user_id=42,
            model_name="text-embedding-3-small",
            model_namespace="default",
        )

        assert result is not None

    def test_group_namespace_queries_without_user_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test group namespace queries without user_id filter."""
        model = _make_model_kind(model_namespace="team-ns")
        mock_db.query.return_value.filter.return_value.first.return_value = model

        result = resolver._get_model_kind(
            db=mock_db,
            user_id=42,
            model_name="text-embedding-3-small",
            model_namespace="team-ns",
        )

        assert result is not None
