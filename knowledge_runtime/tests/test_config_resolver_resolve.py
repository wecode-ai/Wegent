# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Tests for ConfigResolver resolve_index_config and resolve_query_config."""

from typing import Literal
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
    RemoteAuthorizedRetrievalResources,
    RemoteRetrievalResourceRef,
    RuntimeEmbeddingModelConfig,
    RuntimeRetrievalConfig,
    RuntimeRetrieverConfig,
)
from shared.models.db import Kind

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
    operation: Literal["query", "index"] = "query",
) -> RemoteAuthorizedRetrievalResources:
    """Build the resources Backend authorized for one query."""
    return RemoteAuthorizedRetrievalResources(
        operation=operation,
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


@pytest.mark.parametrize("operation", ["query", "index"])
@pytest.mark.parametrize(
    "category_fields",
    [
        {"modelType": "llm"},
        {"modelConfig": {"modelType": "llm"}},
        {"modelType": "llm", "modelConfig": {"modelType": "embedding"}},
        {},
    ],
)
def test_rejects_model_changed_to_llm_after_authorization(
    resolver: ConfigResolver,
    shared_model_db: Session,
    operation: str,
    category_fields: dict,
) -> None:
    """Current Model capabilities must override the earlier authorization."""
    authorized = _authorized_entry(
        operation=operation,
        embedding_model_name="shared-embedding",
        embedding_model_namespace="search-team",
    )
    model = shared_model_db.get(Kind, 3)
    spec = dict(model.json["spec"])
    spec.pop("modelType")
    model.json = {"spec": {**spec, **category_fields}}
    shared_model_db.commit()

    with pytest.raises(ConfigResolutionError) as exc_info:
        getattr(resolver, f"resolve_{operation}_config")(
            shared_model_db,
            knowledge_base_id=1,
            user_id=42,
            authorized=authorized,
        )

    assert exc_info.value.code == "config_invalid"
    assert "embedding" in str(exc_info.value)


@pytest.mark.parametrize("operation", ["query", "index"])
@pytest.mark.parametrize(
    "category_fields",
    [
        {"modelType": "embedding"},
        {"modelType": " EMBEDDING "},
        {"modelConfig": {"modelType": "embedding"}},
        {"modelType": None, "modelConfig": {"modelType": "embedding"}},
    ],
)
def test_accepts_current_and_legacy_embedding_category(
    resolver: ConfigResolver,
    shared_model_db: Session,
    operation: str,
    category_fields: dict,
) -> None:
    """Both runtime operations use the same current/legacy category semantics."""
    model = shared_model_db.get(Kind, 3)
    spec = dict(model.json["spec"])
    spec.pop("modelType")
    model_config = {**spec["modelConfig"], **category_fields.get("modelConfig", {})}
    model.json = {"spec": {**spec, **category_fields, "modelConfig": model_config}}
    shared_model_db.commit()
    authorized = _authorized_entry(
        operation=operation,
        embedding_model_name="shared-embedding",
        embedding_model_namespace="search-team",
    )

    with patch.object(
        resolver, "_get_model_kind", wraps=resolver._get_model_kind
    ) as load:
        result = getattr(resolver, f"resolve_{operation}_config")(
            shared_model_db,
            knowledge_base_id=1,
            user_id=42,
            authorized=authorized,
        )

    assert result.embedding_model_config.resolved_config["model_id"] == (
        "provider-embedding-id"
    )
    load.assert_called_once()


class TestResolveIndexConfig:
    """Tests for ConfigResolver.resolve_index_config."""

    def test_success_with_document_id(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """Test successful index config resolution with document_id."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry(operation="index")

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
        authorized = _authorized_entry(operation="index")

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
                    authorized=_authorized_entry(
                        operation="index", knowledge_base_id=999
                    ),
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
        authorized = _authorized_entry(
            operation="index", retriever_name="other-retriever"
        )

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

    def test_rejects_authorized_resources_for_another_knowledge_base(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """References authorized for another knowledge base never index this one."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry(operation="index", knowledge_base_id=2)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_retriever_kind") as get_retriever,
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_index_config(
                    mock_db,
                    knowledge_base_id=1,
                    user_id=42,
                    document_id=100,
                    authorized=authorized,
                )

        assert exc_info.value.code == "authorization_mismatch"
        get_retriever.assert_not_called()

    def test_rejects_authorized_owner_that_is_not_the_kb_owner(
        self, resolver: ConfigResolver, mock_db: MagicMock
    ) -> None:
        """References authorized for another owner never index this knowledge base."""
        kb = _make_kb_kind(knowledge_base_id=1, user_id=42)
        authorized = _authorized_entry(operation="index", index_owner_user_id=99)

        with (
            patch.object(resolver, "_get_knowledge_base", return_value=kb),
            patch.object(resolver, "_get_retriever_kind") as get_retriever,
        ):
            with pytest.raises(ConfigResolutionError) as exc_info:
                resolver.resolve_index_config(
                    mock_db,
                    knowledge_base_id=1,
                    user_id=42,
                    document_id=100,
                    authorized=authorized,
                )

        assert exc_info.value.code == "authorization_mismatch"
        get_retriever.assert_not_called()


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
            authorized=authorized.model_copy(update={"operation": "index"}),
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


@pytest.mark.parametrize("target,owner", [(2, 42), (1, 99)])
def test_query_rejects_authorization_for_another_target_or_owner(
    resolver, shared_model_db, target, owner
):
    authorized = _authorized_entry(
        knowledge_base_id=target,
        index_owner_user_id=owner,
        embedding_model_name="shared-embedding",
        embedding_model_namespace="search-team",
    )
    with pytest.raises(ConfigResolutionError, match="[Aa]uthorized"):
        resolver.resolve_query_config(
            shared_model_db, knowledge_base_id=1, user_id=42, authorized=authorized
        )


@pytest.mark.parametrize(
    "operation,target,owner,namespace",
    [
        ("purge", 1, 42, "default"),
        ("drop", 1, 42, "other"),
        ("drop", 2, 42, "default"),
        ("drop", 1, 99, "default"),
    ],
)
def test_management_rejects_mismatched_authorization(
    resolver, shared_model_db, operation, target, owner, namespace
):
    from shared.models import RemoteAuthorizedIndexResources

    authorized = RemoteAuthorizedIndexResources(
        knowledge_base_id=target,
        index_owner_user_id=owner,
        operation=operation,
        retriever=RemoteRetrievalResourceRef(
            kind="Retriever", name="test-retriever", namespace=namespace
        ),
    )
    with pytest.raises(ConfigResolutionError):
        resolver.resolve_admin_config(
            shared_model_db,
            knowledge_base_id=1,
            operation="drop",
            authorized=authorized,
        )


def test_management_executes_without_embedding_or_query_parameters(
    resolver, shared_model_db
):
    from shared.models import RemoteAuthorizedIndexResources
    from shared.models.db import Kind

    kb = shared_model_db.get(Kind, 1)
    kb.json = {
        "spec": {
            "retrievalConfig": {
                "retriever_name": "test-retriever",
                "retriever_namespace": "default",
            }
        }
    }
    shared_model_db.commit()
    authorized = RemoteAuthorizedIndexResources(
        knowledge_base_id=1,
        index_owner_user_id=42,
        operation="purge",
        retriever=RemoteRetrievalResourceRef(kind="Retriever", name="test-retriever"),
    )
    config = resolver.resolve_admin_config(
        shared_model_db, knowledge_base_id=1, operation="purge", authorized=authorized
    )
    assert config.index_owner_user_id == 42
    assert config.retriever_config.storage_config["type"] == "qdrant"


@pytest.mark.parametrize(
    "operation,grant_operation", [("index", "query"), ("query", "index")]
)
def test_rejects_grant_for_another_operation(
    resolver: ConfigResolver,
    shared_model_db: Session,
    operation: Literal["query", "index"],
    grant_operation: Literal["query", "index"],
) -> None:
    grant = _authorized_entry(
        operation=grant_operation,
        embedding_model_name="shared-embedding",
        embedding_model_namespace="search-team",
    )
    with pytest.raises(ConfigResolutionError) as error:
        getattr(resolver, f"resolve_{operation}_config")(
            shared_model_db, knowledge_base_id=1, user_id=42, authorized=grant
        )
    assert error.value.code == "authorization_mismatch"


def test_index_rejects_temporary_resource_selection(
    resolver: ConfigResolver, shared_model_db: Session
) -> None:
    grant = _authorized_entry(
        operation="index",
        explicit_selection=True,
        embedding_model_name="shared-embedding",
        embedding_model_namespace="search-team",
    )
    with pytest.raises(ConfigResolutionError) as error:
        resolver.resolve_index_config(
            shared_model_db, knowledge_base_id=1, user_id=42, authorized=grant
        )
    assert error.value.code == "authorization_mismatch"


@pytest.mark.parametrize(
    "modalities,expected",
    [(None, []), (["image"], ["image"]), (["image", "image"], ["image"])],
)
def test_query_preserves_embedding_input_capabilities(
    resolver: ConfigResolver,
    shared_model_db: Session,
    modalities: list[str] | None,
    expected: list[str],
) -> None:
    model = shared_model_db.get(Kind, 3)
    spec = dict(model.json["spec"])
    spec["embeddingConfig"] = {
        "dimensions": 1024,
        "additional_input_modalities": modalities,
    }
    model.json = {"spec": spec}
    shared_model_db.commit()
    grant = _authorized_entry(
        embedding_model_name="shared-embedding", embedding_model_namespace="search-team"
    )
    config = resolver.resolve_query_config(
        shared_model_db, knowledge_base_id=1, user_id=42, authorized=grant
    )
    assert (
        config.embedding_model_config.resolved_config["additional_input_modalities"]
        == expected
    )
