# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver resolve_index_config and resolve_query_config."""

from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from knowledge_runtime.services.config_resolver import (
    AdminResolvedConfig,
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

    def test_embedding_model_not_found_fails_with_config_not_found(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """The index precheck for an unknown embedding model lives here now."""
        kb = _make_kb_kind(
            knowledge_base_id=7,
            user_id=42,
            retrieval_config={
                "retriever_name": "test-retriever",
                "retriever_namespace": "default",
                "embedding_config": {"model_name": "missing-model"},
            },
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
            patch.object(resolver, "_get_model_kind", return_value=None),
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_index_config(
                    mock_db,
                    knowledge_base_id=7,
                    user_id=42,
                    document_id=None,
                )

        assert exc_info.value.code == "config_not_found"
        assert str(exc_info.value) == (
            "Embedding model 'missing-model' not found in namespace 'default'"
        )


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
        self,
        resolver: ConfigResolver,
        shared_model_db: Session,
    ) -> None:
        """A group-visible model reference resolves to its source Model Kind."""
        query_config = resolver.resolve_query_config(
            shared_model_db,
            knowledge_base_id=1,
            user_id=42,
        )
        index_config = resolver.resolve_index_config(
            shared_model_db,
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


class TestResolveAdminConfig:
    """Tests for ConfigResolver.resolve_admin_config.

    The delete, purge, drop and list-chunks requests carry references only, so
    these failures are the ones the Backend no longer pre-checks.
    """

    def test_success_uses_the_knowledge_base_owner(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """The knowledge base owner owns the resolved retriever config."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        resolved = RuntimeRetrieverConfig(
            name="test-retriever",
            namespace="default",
            storage_config={"type": "qdrant"},
        )

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(
                resolver,
                "_build_resolved_retriever_config",
                return_value=resolved,
            ) as build_retriever,
        ):
            result = resolver.resolve_admin_config(mock_db, knowledge_base_id=1)

        assert isinstance(result, AdminResolvedConfig)
        assert result.index_owner_user_id == 42
        assert result.retriever_config is resolved
        build_retriever.assert_called_once_with(
            db=mock_db,
            user_id=42,
            name="test-retriever",
            namespace="default",
        )

    def test_missing_retriever_name_fails_with_config_incomplete(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A knowledge base without retriever_name fails here, not in Backend."""
        kb = _make_kb_kind(
            knowledge_base_id=7,
            user_id=42,
            retrieval_config={"embedding_config": {"model_name": "embed-a"}},
        )

        with patch.object(resolver, "_get_knowledge_base", return_value=kb):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_admin_config(mock_db, knowledge_base_id=7)

        assert exc_info.value.code == "config_incomplete"
        assert str(exc_info.value) == (
            "Knowledge base 7 has incomplete retrieval config "
            "(missing retriever_name)"
        )

    def test_unresolvable_retriever_fails_with_config_not_found(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """An unknown owner-scoped retriever fails here, not in Backend."""
        kb = _make_kb_kind(
            knowledge_base_id=7,
            user_id=42,
            retrieval_config={
                "retriever_name": "missing-retriever",
                "retriever_namespace": "default",
                "embedding_config": {"model_name": "embed-a"},
            },
        )

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_retriever_kind", return_value=None),
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_admin_config(mock_db, knowledge_base_id=7)

        assert exc_info.value.code == "config_not_found"
        assert str(exc_info.value) == (
            "Retriever missing-retriever (namespace: default) not found"
        )


def test_query_headers_use_reader_name_and_owner_credentials(
    resolver: ConfigResolver, mock_db: MagicMock
) -> None:
    kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
    model = _make_model_kind()
    model.json["spec"]["modelConfig"]["env"]["custom_headers"] = {
        "X-Query-User": "${user.name}"
    }
    reader = MagicMock(user_name="reader")
    mock_db.query.return_value.filter.return_value.first.return_value = reader
    with (
        patch.object(resolver, "_get_knowledge_base", return_value=kb),
        patch.object(
            resolver,
            "_build_resolved_retriever_config",
            return_value=RuntimeRetrieverConfig(
                name="test-retriever", namespace="default", storage_config={}
            ),
        ) as retriever,
        patch.object(resolver, "_get_model_kind", return_value=model) as get_model,
    ):
        result = resolver.resolve_query_config(mock_db, knowledge_base_id=1, user_id=7)
    assert result.index_owner_user_id == 42
    assert result.user_name == "reader"
    assert result.embedding_model_config.resolved_config["custom_headers"] == {
        "X-Query-User": "reader"
    }
    retriever.assert_called_once()
    assert retriever.call_args.kwargs["user_id"] == 42
    assert get_model.call_args.kwargs["user_id"] == 42
    assert (
        str(
            mock_db.query.return_value.filter.call_args.args[0].compile(
                compile_kwargs={"literal_binds": True}
            )
        )
        == "users.id = 7"
    )
