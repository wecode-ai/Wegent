# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver service."""

from unittest.mock import MagicMock, patch

import pytest

from knowledge_runtime.services.config_resolver import (
    ConfigResolutionError,
    ConfigResolver,
    IndexConfig,
    QueryConfig,
)
from shared.models import (
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.utils.placeholder import process_custom_headers_placeholders

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def resolver() -> ConfigResolver:
    """Create a ConfigResolver instance."""
    return ConfigResolver()


@pytest.fixture
def mock_db() -> MagicMock:
    """Create a mock database session."""
    return MagicMock()


def _make_kb_kind(
    knowledge_base_id: int = 1,
    user_id: int = 42,
    retrieval_config: dict | None = None,
) -> MagicMock:
    """Create a mock KnowledgeBase Kind record."""
    if retrieval_config is None:
        retrieval_config = {
            "retriever_name": "test-retriever",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "text-embedding-3-small",
                "model_namespace": "default",
            },
            "top_k": 10,
            "score_threshold": 0.8,
            "retrieval_mode": "vector",
        }
    kb = MagicMock()
    kb.id = knowledge_base_id
    kb.user_id = user_id
    kb.kind = "KnowledgeBase"
    kb.is_active = True
    kb.json = {"spec": {"retrievalConfig": retrieval_config}}
    return kb


def _make_retriever_kind(
    name: str = "test-retriever",
    namespace: str = "default",
    storage_config: dict | None = None,
) -> MagicMock:
    """Create a mock Retriever Kind record."""
    if storage_config is None:
        storage_config = {
            "type": "qdrant",
            "url": "http://localhost:6333",
            "username": "admin",
            "password": "encrypted_password",
            "apiKey": "encrypted_api_key",
            "indexStrategy": {"mode": "per_dataset"},
            "ext": {},
        }
    retriever = MagicMock()
    retriever.name = name
    retriever.namespace = namespace
    retriever.kind = "Retriever"
    retriever.json = {"spec": {"storageConfig": storage_config}}
    return retriever


def _make_model_kind(
    model_name: str = "text-embedding-3-small",
    model_namespace: str = "default",
    spec: dict | None = None,
) -> MagicMock:
    """Create a mock Model Kind record."""
    if spec is None:
        spec = {
            "protocol": "openai",
            "modelConfig": {
                "env": {
                    "api_key": "sk-encrypted-key",
                    "base_url": "https://api.openai.com/v1",
                    "model_id": "text-embedding-3-small",
                    "custom_headers": {},
                },
            },
            "embeddingConfig": {"dimensions": 1536},
        }
    model = MagicMock()
    model.name = model_name
    model.namespace = model_namespace
    model.kind = "Model"
    model.json = {"spec": spec}
    return model


_SENTINEL = object()


def _make_document(
    document_id: int = 100, splitter_config: dict | None = _SENTINEL
) -> MagicMock:
    """Create a mock KnowledgeDocument record."""
    doc = MagicMock()
    doc.id = document_id
    if splitter_config is _SENTINEL:
        splitter_config = {"chunk_size": 512}
    doc.splitter_config = splitter_config
    return doc


def _make_user(user_id: int = 42, user_name: str = "testuser") -> MagicMock:
    """Create a mock User record."""
    user = MagicMock()
    user.id = user_id
    user.user_name = user_name
    return user


# ---------------------------------------------------------------------------
# Tests: resolve_index_config
# ---------------------------------------------------------------------------


class TestResolveIndexConfig:
    """Tests for ConfigResolver.resolve_index_config."""

    def test_success_with_document_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test successful index config resolution with document_id."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        retriever = _make_retriever_kind()
        model = _make_model_kind()
        doc = _make_document(document_id=100, splitter_config={"chunk_size": 1024})
        user = _make_user(user_id=42, user_name="testuser")

        mock_db.query.return_value.filter.return_value.filter.return_value.order_by.return_value.first.return_value = (
            retriever
        )
        mock_db.query.return_value.filter.return_value.first.side_effect = [
            kb,
            user,
            doc,
        ]

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=RuntimeRetrieverConfig(
                    name="test-retriever",
                    namespace="default",
                    storage_config={"type": "qdrant", "url": "http://localhost:6333"},
                ),
            ),
            patch.object(
                resolver,
                "_build_resolved_embedding_model_config",
                return_value=RuntimeEmbeddingModelConfig(
                    model_name="text-embedding-3-small",
                    model_namespace="default",
                    resolved_config={"protocol": "openai"},
                ),
            ),
            patch.object(
                resolver,
                "_get_splitter_config",
                return_value={"chunk_size": 1024},
            ),
        ):
            result = resolver.resolve_index_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                document_id=100,
            )

        assert isinstance(result, IndexConfig)
        assert result.index_owner_user_id == 42
        assert result.user_name == "testuser"
        assert result.splitter_config == {"chunk_size": 1024}
        assert result.retriever_config.name == "test-retriever"
        assert result.embedding_model_config.model_name == "text-embedding-3-small"

    def test_success_without_document_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test index config resolution without document_id yields empty splitter_config."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=RuntimeRetrieverConfig(
                    name="test-retriever",
                    namespace="default",
                    storage_config={},
                ),
            ),
            patch.object(
                resolver,
                "_build_resolved_embedding_model_config",
                return_value=RuntimeEmbeddingModelConfig(
                    model_name="text-embedding-3-small",
                    model_namespace="default",
                    resolved_config={},
                ),
            ),
        ):
            result = resolver.resolve_index_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                document_id=None,
            )

        assert result.splitter_config == {}

    def test_kb_not_found(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test that ConfigResolutionError is raised when KB is not found."""
        with patch.object(
            resolver,
            "_get_knowledge_base",
            side_effect=ConfigResolutionError(
                "config_not_found", "Knowledge base 999 not found"
            ),
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_index_config(
                    mock_db,
                    knowledge_base_id=999,
                    user_id=42,
                )
            assert exc_info.value.code == "config_not_found"


# ---------------------------------------------------------------------------
# Tests: resolve_query_config
# ---------------------------------------------------------------------------


class TestResolveQueryConfig:
    """Tests for ConfigResolver.resolve_query_config."""

    def test_success(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test successful query config resolution."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=RuntimeRetrieverConfig(
                    name="test-retriever",
                    namespace="default",
                    storage_config={"type": "qdrant"},
                ),
            ),
            patch.object(
                resolver,
                "_build_resolved_embedding_model_config",
                return_value=RuntimeEmbeddingModelConfig(
                    model_name="text-embedding-3-small",
                    model_namespace="default",
                    resolved_config={"protocol": "openai"},
                ),
            ),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
            )

        assert isinstance(result, QueryConfig)
        assert result.knowledge_base_id == 1
        assert result.index_owner_user_id == 42
        assert result.user_name == "testuser"
        assert result.retriever_config.name == "test-retriever"
        assert result.embedding_model_config.model_name == "text-embedding-3-small"
        assert isinstance(result.retrieval_config, RuntimeRetrievalConfig)
        assert result.retrieval_config.top_k == 10
        assert result.retrieval_config.score_threshold == 0.8
        assert result.retrieval_config.retrieval_mode == "vector"

    def test_hybrid_retrieval_mode(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test query config with hybrid retrieval mode includes weights."""
        retrieval_config = {
            "retriever_name": "test-retriever",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "text-embedding-3-small",
                "model_namespace": "default",
            },
            "top_k": 5,
            "score_threshold": 0.5,
            "retrieval_mode": "hybrid",
            "hybrid_weights": {
                "vector_weight": 0.7,
                "keyword_weight": 0.3,
            },
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=RuntimeRetrieverConfig(
                    name="test-retriever",
                    namespace="default",
                    storage_config={},
                ),
            ),
            patch.object(
                resolver,
                "_build_resolved_embedding_model_config",
                return_value=RuntimeEmbeddingModelConfig(
                    model_name="text-embedding-3-small",
                    model_namespace="default",
                    resolved_config={},
                ),
            ),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
            )

        assert result.retrieval_config.retrieval_mode == "hybrid"
        assert result.retrieval_config.vector_weight == 0.7
        assert result.retrieval_config.keyword_weight == 0.3

    def test_default_retrieval_values(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test query config with minimal retrieval config uses defaults."""
        retrieval_config = {
            "retriever_name": "test-retriever",
            "retriever_namespace": "default",
            "embedding_config": {
                "model_name": "text-embedding-3-small",
                "model_namespace": "default",
            },
        }
        kb = _make_kb_kind(
            knowledge_base_id=1, user_id=42, retrieval_config=retrieval_config
        )

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=RuntimeRetrieverConfig(
                    name="test-retriever",
                    namespace="default",
                    storage_config={},
                ),
            ),
            patch.object(
                resolver,
                "_build_resolved_embedding_model_config",
                return_value=RuntimeEmbeddingModelConfig(
                    model_name="text-embedding-3-small",
                    model_namespace="default",
                    resolved_config={},
                ),
            ),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
            )

        assert result.retrieval_config.top_k == 20
        assert result.retrieval_config.score_threshold == 0.7
        assert result.retrieval_config.retrieval_mode == "vector"
        assert result.retrieval_config.vector_weight is None
        assert result.retrieval_config.keyword_weight is None


# ---------------------------------------------------------------------------
# Tests: _get_knowledge_base
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _parse_kb_retrieval_config
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _build_resolved_retriever_config
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _build_resolved_embedding_model_config
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _get_retriever_kind
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _get_model_kind
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _get_splitter_config
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _get_user_name
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: _decrypt_optional_value
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# Tests: ConfigResolutionError
# ---------------------------------------------------------------------------


class TestConfigResolutionError:
    """Tests for ConfigResolutionError."""

    def test_stores_error_code(self) -> None:
        """Test that error code is stored correctly."""
        error = ConfigResolutionError("config_not_found", "Something was not found")
        assert error.code == "config_not_found"
        assert str(error) == "Something was not found"

    def test_is_value_error(self) -> None:
        """Test that ConfigResolutionError is a ValueError."""
        error = ConfigResolutionError("config_incomplete", "Incomplete config")
        assert isinstance(error, ValueError)

    def test_raises_and_catches(self) -> None:
        """Test that ConfigResolutionError can be raised and caught."""
        with pytest.raises(ConfigResolutionError) as exc_info:
            raise ConfigResolutionError("config_not_found", "KB not found")

        assert exc_info.value.code == "config_not_found"
        assert "KB not found" in str(exc_info.value)


# ---------------------------------------------------------------------------
# Tests: process_custom_headers_placeholders
# ---------------------------------------------------------------------------


class TestProcessCustomHeadersPlaceholders:
    """Tests for process_custom_headers_placeholders helper."""

    def test_replaces_user_name_placeholder(self) -> None:
        """Test ${user.name} placeholder is replaced."""
        headers = {"X-User": "${user.name}"}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-User"] == "alice"

    def test_replaces_in_mixed_string(self) -> None:
        """Test placeholder replacement within a longer string."""
        headers = {"Authorization": "Bearer ${user.name}-token"}
        result = process_custom_headers_placeholders(headers, user_name="bob")
        assert result["Authorization"] == "Bearer bob-token"

    def test_no_placeholders(self) -> None:
        """Test headers without placeholders pass through unchanged."""
        headers = {"X-Custom": "static-value"}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-Custom"] == "static-value"

    def test_none_user_name(self) -> None:
        """Test placeholder with None user_name uses empty string."""
        headers = {"X-User": "${user.name}"}
        result = process_custom_headers_placeholders(headers, user_name=None)
        assert result["X-User"] == ""

    def test_empty_headers(self) -> None:
        """Test empty headers dict returns empty dict."""
        result = process_custom_headers_placeholders({}, user_name="alice")
        assert result == {}

    def test_none_headers(self) -> None:
        """Test None headers returns None."""
        result = process_custom_headers_placeholders(None, user_name="alice")
        assert result is None

    def test_non_string_values_preserved(self) -> None:
        """Test non-string header values are preserved as-is."""
        headers = {"X-Count": 42, "X-Flag": True}
        result = process_custom_headers_placeholders(headers, user_name="alice")
        assert result["X-Count"] == 42
        assert result["X-Flag"] is True

    def test_multiple_placeholders(self) -> None:
        """Test multiple placeholders in the same header value."""
        headers = {"X-Auth": "user=${user.name}&type=bearer"}
        result = process_custom_headers_placeholders(headers, user_name="charlie")
        assert result["X-Auth"] == "user=charlie&type=bearer"
