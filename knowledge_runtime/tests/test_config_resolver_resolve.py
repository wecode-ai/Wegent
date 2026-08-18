# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver resolve_index_config and resolve_query_config."""

from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy import Boolean, Column, Integer, MetaData, String, Table, create_engine
from sqlalchemy.orm import Session

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
from shared.models.db import Kind, User

from .conftest import (
    _make_kb_kind,
    _make_model_kind,
    _make_retriever_kind,
)


class TestResolveIndexConfig:
    """Tests for ConfigResolver.resolve_index_config."""

    def test_success_with_document_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test successful index config resolution with document_id."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        retriever = _make_retriever_kind()
        model = _make_model_kind()
        user = MagicMock()
        user.id = 42
        user.user_name = "testuser"

        mock_db.query.return_value.filter.return_value.filter.return_value.order_by.return_value.first.return_value = (
            retriever
        )
        mock_db.query.return_value.filter.return_value.first.side_effect = [
            kb,
            user,
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

    def test_resolves_embedding_model_shared_into_kb_namespace(
        self, resolver: ConfigResolver
    ) -> None:
        """A group-visible model reference resolves to its source Model Kind."""
        engine = create_engine("sqlite:///:memory:")
        Kind.__table__.create(engine)
        User.__table__.create(engine)
        metadata = MetaData()
        namespace = Table(
            "namespace",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("name", String(100), nullable=False),
            Column("is_active", Boolean, nullable=False),
        )
        resource_members = Table(
            "resource_members",
            metadata,
            Column("id", Integer, primary_key=True),
            Column("resource_type", String(50), nullable=False),
            Column("resource_id", Integer, nullable=False),
            Column("entity_type", String(20), nullable=False),
            Column("entity_id", String(100), nullable=False),
            Column("status", String(20), nullable=False),
        )
        metadata.create_all(engine)

        with Session(engine) as db:
            db.add(
                User(
                    id=42,
                    user_name="kb-owner",
                    password_hash="unused",
                )
            )
            db.add_all(
                [
                    Kind(
                        id=1,
                        user_id=42,
                        kind="KnowledgeBase",
                        name="team-kb",
                        namespace="search-team",
                        is_active=True,
                        json={
                            "spec": {
                                "retrievalConfig": {
                                    "retriever_name": "test-retriever",
                                    "retriever_namespace": "default",
                                    "embedding_config": {
                                        "model_name": "shared-embedding",
                                        "model_namespace": "search-team",
                                    },
                                }
                            }
                        },
                    ),
                    Kind(
                        id=2,
                        user_id=42,
                        kind="Retriever",
                        name="test-retriever",
                        namespace="default",
                        is_active=True,
                        json={
                            "spec": {
                                "storageConfig": {
                                    "type": "qdrant",
                                    "url": "http://qdrant:6333",
                                }
                            }
                        },
                    ),
                    Kind(
                        id=3,
                        user_id=77,
                        kind="Model",
                        name="shared-embedding",
                        namespace="default",
                        is_active=True,
                        json={
                            "spec": {
                                "protocol": "openai",
                                "modelConfig": {
                                    "env": {
                                        "base_url": "http://embedding:8000/v1",
                                        "model_id": "provider-embedding-id",
                                    }
                                },
                                "embeddingConfig": {"dimensions": 1024},
                            }
                        },
                    ),
                ]
            )
            db.execute(
                namespace.insert().values(
                    id=7,
                    name="search-team",
                    is_active=True,
                )
            )
            db.execute(
                resource_members.insert().values(
                    id=1,
                    resource_type="Model",
                    resource_id=3,
                    entity_type="namespace",
                    entity_id="7",
                    status="approved",
                )
            )
            db.commit()

            query_config = resolver.resolve_query_config(
                db,
                knowledge_base_id=1,
                user_id=42,
            )
            index_config = resolver.resolve_index_config(
                db,
                knowledge_base_id=1,
                user_id=42,
            )

            assert query_config.embedding_model_config.model_name == "shared-embedding"
            assert query_config.embedding_model_config.model_namespace == "search-team"
            assert (
                query_config.embedding_model_config.resolved_config["model_id"]
                == "provider-embedding-id"
            )
            assert index_config.embedding_model_config == (
                query_config.embedding_model_config
            )

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
