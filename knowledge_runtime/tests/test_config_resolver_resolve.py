# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver resolve_index_config and resolve_query_config."""

from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.orm import Session

from knowledge_runtime.services.config_resolver import (
    ConfigResolutionError,
    ConfigResolver,
    IndexConfig,
    QueryConfig,
)
from shared.models import (
    RemoteAuthorizedRetrievalResources,
    RemoteRetrievalResourceRef,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)

from .conftest import (
    _make_kb_kind,
    _make_model_kind,
    _make_retriever_kind,
)


def _authorized_entry(
    *,
    knowledge_base_id: int = 1,
    index_owner_user_id: int = 42,
    retriever_name: str = "test-retriever",
    retriever_namespace: str = "default",
    embedding_model_name: str = "text-embedding-3-small",
    embedding_model_namespace: str = "default",
    explicit_selection: bool = False,
) -> RemoteAuthorizedRetrievalResources:
    """Build the resources Backend authorized for one query."""
    return RemoteAuthorizedRetrievalResources(
        knowledge_base_id=knowledge_base_id,
        index_owner_user_id=index_owner_user_id,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name=retriever_name, namespace=retriever_namespace
        ),
        embedding_model=RemoteRetrievalResourceRef(
            kind="Model",
            name=embedding_model_name,
            namespace=embedding_model_namespace,
        ),
        explicit_selection=explicit_selection,
    )


class TestResolveIndexConfig:
    """Tests for ConfigResolver.resolve_index_config."""

    def test_success_with_document_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test successful index config resolution with document_id."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry()

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
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
                authorized=authorized,
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
        authorized = _authorized_entry()

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
        ):
            result = resolver.resolve_index_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                document_id=None,
                authorized=authorized,
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
                    authorized=_authorized_entry(knowledge_base_id=999),
                )
            assert exc_info.value.code == "config_not_found"

    def test_requires_authorized_resources(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Indexing without authorized resources fails before loading records."""
        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver.resolve_index_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                document_id=100,
            )

        assert exc_info.value.code == "authorization_required"

    def test_rejects_stored_config_outside_authorized_set(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A stored resource replaced outside the authorized set cannot index."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry(retriever_name="other-retriever")

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_index_config(
                    mock_db,
                    knowledge_base_id=1,
                    user_id=42,
                    document_id=100,
                    authorized=authorized,
                )

        assert exc_info.value.code == "config_invalid"


class TestResolveQueryConfig:
    """Tests for ConfigResolver.resolve_query_config."""

    def test_success(self, resolver: ConfigResolver, mock_db: MagicMock) -> None:
        """Test successful query config resolution."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry()

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=authorized,
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
        authorized = _authorized_entry(
            embedding_model_name="shared-embedding",
            embedding_model_namespace="search-team",
        )
        query_config = resolver.resolve_query_config(
            shared_model_db,
            knowledge_base_id=1,
            user_id=42,
            authorized=authorized,
        )
        index_config = resolver.resolve_index_config(
            shared_model_db,
            knowledge_base_id=1,
            user_id=42,
            authorized=authorized,
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
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=_authorized_entry(),
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
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=_authorized_entry(),
            )

        assert result.retrieval_config.top_k == 20
        assert result.retrieval_config.score_threshold == 0.7
        assert result.retrieval_config.retrieval_mode == "vector"
        assert result.retrieval_config.vector_weight is None
        assert result.retrieval_config.keyword_weight is None

    def test_requires_authorized_resources(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A query without Backend authorization is rejected, not widened."""
        with pytest.raises(ConfigResolutionError) as exc_info:
            resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
            )
        assert exc_info.value.code == "authorization_required"

    def test_rejects_kb_edited_outside_authorized_set(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A stored config changed to another resource must not execute."""
        retrieval_config = {
            "retriever_name": "changed-retriever",
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
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
            pytest.raises(ConfigResolutionError) as exc_info,
        ):
            resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=_authorized_entry(),
            )

        assert exc_info.value.code == "config_invalid"
        assert "not in the authorized" in str(exc_info.value)

    def test_explicit_selection_replaces_stored_references(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A public caller's marked selection executes instead of stored ones."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry(
            retriever_name="selected-retriever",
            embedding_model_name="selected-embedding",
            explicit_selection=True,
        )

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver,
                "_get_retriever_kind",
                return_value=_make_retriever_kind(name="selected-retriever"),
            ),
            patch.object(
                resolver,
                "_get_model_kind",
                return_value=_make_model_kind(model_name="selected-embedding"),
            ),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=authorized,
            )

        assert result.retriever_config.name == "selected-retriever"
        assert result.retriever_config.namespace == "default"
        assert result.embedding_model_config.model_name == "selected-embedding"
        assert result.retrieval_config.top_k == 10

    def test_resolves_referenced_retriever_into_personal_scope(
        self,
        resolver: ConfigResolver,
        referenced_retriever_db,
    ) -> None:
        """The runtime loads the same approved Retriever reference Backend allows."""
        authorized = _authorized_entry(
            retriever_name="shared-retriever",
            embedding_model_name="public-embedding",
        )

        result = resolver.resolve_query_config(
            referenced_retriever_db,
            knowledge_base_id=1,
            user_id=42,
            authorized=authorized,
        )

        assert result.retriever_config.name == "shared-retriever"
        assert result.retriever_config.storage_config["url"] == (
            "http://shared-retriever:9200"
        )
        assert result.embedding_model_config.model_name == "public-embedding"

    def test_rejects_missing_authorized_resource(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A resource the runtime cannot load inside the set is rejected."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(resolver, "_get_retriever_kind", return_value=None),
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_query_config(
                    mock_db,
                    knowledge_base_id=1,
                    user_id=42,
                    authorized=_authorized_entry(),
                )
        assert exc_info.value.code == "config_not_found"

    def test_retrieval_override_is_applied_through_the_module(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """A request override replaces the stored parameters via the module."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
        ):
            result = resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=_authorized_entry(),
                retrieval_override={
                    "top_k": 3,
                    "score_threshold": 0.25,
                },
            )

        assert result.retrieval_config.top_k == 3
        assert result.retrieval_config.score_threshold == 0.25

    def test_retrieval_override_with_invalid_weights_is_rejected(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """An override that violates a module rule never reaches execution."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_user_name", return_value="testuser"),
            patch.object(
                resolver, "_get_retriever_kind", return_value=_make_retriever_kind()
            ),
            patch.object(resolver, "_get_model_kind", return_value=_make_model_kind()),
            pytest.raises(ConfigResolutionError) as exc_info,
        ):
            resolver.resolve_query_config(
                mock_db,
                knowledge_base_id=1,
                user_id=42,
                authorized=_authorized_entry(),
                retrieval_override={
                    "retrieval_mode": "hybrid",
                    "vector_weight": 0.9,
                    "keyword_weight": 0.9,
                },
            )

        assert exc_info.value.code == "config_invalid"
        assert "hybrid_weights" in str(exc_info.value)
