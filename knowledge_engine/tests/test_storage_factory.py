# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from shared.models import RuntimeRetrieverConfig

MILVUS_URL = "http://milvus:19530/v2"


def _milvus_storage_config(
    *,
    prefix: str | None = None,
    mode: str = "per_dataset",
) -> dict:
    """One resolved Milvus storage config, in the shape the resolver reads."""
    strategy: dict = {"mode": mode}
    if prefix is not None:
        strategy["prefix"] = prefix
    return {"type": "milvus", "url": MILVUS_URL, "indexStrategy": strategy}


def test_create_storage_backend_from_runtime_config_uses_registered_backend(
    monkeypatch,
) -> None:
    from knowledge_engine.storage.factory import (
        STORAGE_BACKEND_REGISTRY,
        create_storage_backend_from_runtime_config,
    )

    captured: dict[str, object] = {}

    class FakeBackend:
        def __init__(self, config):
            captured["config"] = config

    monkeypatch.setitem(STORAGE_BACKEND_REGISTRY, "fake", FakeBackend)

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="retriever-a",
            storage_config={
                "type": "fake",
                "url": "http://vector-store:1234",
                "username": "tester",
                "apiKey": "secret",
                "indexStrategy": {"mode": "per_dataset"},
                "ext": {"vector_size": 1536},
            },
        )
    )

    assert isinstance(backend, FakeBackend)
    assert captured["config"] == {
        "url": "http://vector-store:1234",
        "username": "tester",
        "password": None,
        "apiKey": "secret",
        "indexStrategy": {"mode": "per_dataset"},
        "ext": {"vector_size": 1536},
    }


def test_get_storage_retrieval_methods_uses_registered_backends(monkeypatch) -> None:
    from knowledge_engine.storage.factory import (
        STORAGE_BACKEND_REGISTRY,
        get_all_storage_retrieval_methods,
        get_supported_retrieval_methods,
    )

    class FakeBackend:
        @classmethod
        def get_supported_retrieval_methods(cls):
            return ["vector", "hybrid"]

    monkeypatch.setitem(STORAGE_BACKEND_REGISTRY, "fake", FakeBackend)

    assert get_supported_retrieval_methods("fake") == ["vector", "hybrid"]
    assert get_all_storage_retrieval_methods()["fake"] == ["vector", "hybrid"]


def test_registered_backends_advertise_their_keyword_and_hybrid_capability() -> None:
    """The public capability map is what the backend API serves to clients."""
    from knowledge_engine.storage.factory import get_all_storage_retrieval_methods

    methods = get_all_storage_retrieval_methods()

    assert methods["milvus"] == ["vector", "keyword", "hybrid"]
    assert set(methods) == {"elasticsearch", "qdrant", "milvus"}


def test_only_one_public_storage_type_reaches_milvus() -> None:
    """A Retriever configures ``milvus``; the generation is not a public type.

    The transition rule lives inside the factory, so publishing a second type
    for the second generation would make the storage type - not the resolver -
    decide which adapter answers a knowledge base.
    """
    from knowledge_engine.storage.factory import get_supported_storage_types

    assert get_supported_storage_types() == ["elasticsearch", "qdrant", "milvus"]


def test_the_reserved_prefix_is_the_value_the_deployment_is_told_to_configure() -> None:
    """The transition's routing marker is pinned, not left implicit.

    A Retriever reaches the second generation by declaring this exact prefix,
    and the operator configures it by hand, so a change to it is a change to
    the rollout's instruction rather than a rename.
    """
    from knowledge_engine.storage.factory import MILVUS_V2_RESERVED_PREFIX

    assert MILVUS_V2_RESERVED_PREFIX == "wegent_v2"


def test_the_reserved_prefix_builds_the_second_generation() -> None:
    """``per_dataset`` plus the reserved prefix is the one V2 selection."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus.backend import MilvusBackend as MilvusV2Backend
    from knowledge_engine.storage.milvus_backend import (
        MilvusBackend as LegacyMilvusBackend,
    )

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="v2-retriever",
            storage_config=_milvus_storage_config(prefix="wegent_v2"),
        )
    )

    assert type(backend) is MilvusV2Backend
    assert not issubclass(MilvusV2Backend, LegacyMilvusBackend)
    assert not issubclass(LegacyMilvusBackend, MilvusV2Backend)


@pytest.mark.parametrize(
    "index_strategy",
    [
        pytest.param({}, id="no-index-strategy"),
        pytest.param({"mode": "per_dataset"}, id="default-prefix"),
        pytest.param({"mode": "per_dataset", "prefix": "wegent"}, id="wegent-prefix"),
        pytest.param({"mode": "per_dataset", "prefix": "another"}, id="other-prefix"),
        pytest.param({"mode": "per_user", "prefix": "wegent"}, id="per-user-mode"),
        pytest.param({"mode": "rolling", "prefix": "wegent"}, id="rolling-mode"),
        pytest.param({"mode": "fixed", "fixedName": "one"}, id="fixed-mode"),
    ],
)
def test_an_absent_or_ordinary_prefix_keeps_the_frozen_adapter(
    index_strategy: dict,
) -> None:
    """Everything but the reserved values keeps serving the old collections."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus_backend import (
        MilvusBackend as LegacyMilvusBackend,
    )

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="legacy-retriever",
            storage_config={
                "type": "milvus",
                "url": MILVUS_URL,
                "indexStrategy": index_strategy,
            },
        )
    )

    assert type(backend) is LegacyMilvusBackend


@pytest.mark.parametrize(
    "prefix",
    [
        pytest.param("wegent_v20", id="longer-prefix"),
        pytest.param("my_wegent_v2", id="prefixed-value"),
        pytest.param("WEGENT_V2", id="other-case"),
        pytest.param("wegent_v2x", id="trailing-character"),
    ],
)
def test_a_prefix_that_merely_resembles_the_reserved_one_keeps_the_frozen_adapter(
    prefix: str,
) -> None:
    """The reserved value is compared for equality, never by prefix matching."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus_backend import (
        MilvusBackend as LegacyMilvusBackend,
    )

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="legacy-retriever",
            storage_config=_milvus_storage_config(prefix=prefix),
        )
    )

    assert type(backend) is LegacyMilvusBackend


@pytest.mark.parametrize(
    "index_strategy",
    [
        pytest.param(
            {"mode": "fixed", "fixedName": "one", "prefix": "wegent_v2"},
            id="fixed",
        ),
        pytest.param({"mode": "rolling", "prefix": "wegent_v2"}, id="rolling"),
        pytest.param({"mode": "per_user", "prefix": "wegent_v2"}, id="per-user"),
    ],
)
def test_the_reserved_prefix_is_refused_by_a_shared_index_strategy(
    index_strategy: dict,
) -> None:
    """The reserved prefix only names a per-dataset collection.

    A shared strategy keeps its own naming - a fixed name, a rolling index or
    one index per user - so the prefix the routing rule reads would not be the
    physical name the adapter writes. That must fail as a configuration error
    instead of quietly serving the legacy collections.
    """
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    with pytest.raises(ValueError, match="wegent_v2"):
        create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="v2-retriever",
                storage_config={
                    "type": "milvus",
                    "url": MILVUS_URL,
                    "indexStrategy": index_strategy,
                },
            )
        )


def test_a_milvus_storage_type_is_normalized_before_it_is_dispatched() -> None:
    """A configured type is matched the way every other storage type is."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus_backend import (
        MilvusBackend as LegacyMilvusBackend,
    )

    configured_types = ("Milvus", "MILVUS")

    for configured_type in configured_types:
        backend = create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-1",
                storage_config={
                    "type": configured_type,
                    "url": MILVUS_URL,
                },
            )
        )

        assert type(backend) is LegacyMilvusBackend


def test_an_unknown_storage_type_is_refused() -> None:
    """A type no adapter answers keeps failing as it does today."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    with pytest.raises(ValueError, match="Unsupported storage type: milvus_v3"):
        create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-1",
                storage_config={"type": "milvus_v3", "url": MILVUS_URL},
            )
        )


def test_the_retired_second_storage_type_is_refused() -> None:
    """``milvus_v2`` is no longer a public storage type.

    The reserved prefix is the only way to reach the second generation, so a
    Retriever still configured with the retired type fails explicitly instead
    of resolving to an adapter nobody routed it to.
    """
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    with pytest.raises(ValueError, match="Unsupported storage type: milvus_v2"):
        create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-1",
                storage_config={"type": "milvus_v2", "url": MILVUS_URL},
            )
        )


def test_a_reserved_prefix_runtime_config_reaches_the_backend_verbatim() -> None:
    """The second generation needs no field of its own to be addressed.

    Nothing about the second generation is a new database column or a new
    transport field: the resolved storage config the runtime hands over is what
    the adapter is built from, including the Milvus database it must not share
    with the legacy retriever.
    """
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="v2-retriever",
            namespace="default",
            storage_config={
                "type": "milvus",
                "url": "http://milvus:19530",
                "username": "tester",
                "password": "s3cret",
                "apiKey": "retriever-key",
                "indexStrategy": {"mode": "per_dataset", "prefix": "wegent_v2"},
                "ext": {"db_name": "wegent_v2", "dim": 1536},
            },
        )
    )

    assert backend.url == "http://milvus:19530"
    assert backend.username == "tester"
    assert backend.password == "s3cret"
    assert backend.api_key == "retriever-key"
    assert backend.index_strategy == {"mode": "per_dataset", "prefix": "wegent_v2"}
    assert backend.ext == {"db_name": "wegent_v2", "dim": 1536}


def test_only_the_reserved_prefix_config_owns_the_document_replacement() -> None:
    """Only an adapter that deletes inside its write owns the replacement.

    The indexing layer asks this before it deletes a document's previous rows,
    so the config that answers True is the only one deleting them. The
    question is answered from the whole storage config - the type and the index
    strategy - because the same ``milvus`` type answers both ways.
    """
    from knowledge_engine.storage.factory import (
        storage_backend_owns_document_replacement,
    )

    assert storage_backend_owns_document_replacement(_milvus_storage_config()) is False
    assert (
        storage_backend_owns_document_replacement(
            _milvus_storage_config(prefix="wegent")
        )
        is False
    )
    assert (
        storage_backend_owns_document_replacement(
            _milvus_storage_config(prefix="wegent_v2")
        )
        is True
    )


def test_a_non_milvus_config_keeps_the_delete_then_index_order() -> None:
    """Every other engine, and a config no engine answers, keeps its old order."""
    from knowledge_engine.storage.factory import (
        storage_backend_owns_document_replacement,
    )

    assert storage_backend_owns_document_replacement({"type": "ELASTICSEARCH"}) is False
    assert storage_backend_owns_document_replacement({"type": "qdrant"}) is False
    assert storage_backend_owns_document_replacement({"type": "unknown"}) is False
    assert storage_backend_owns_document_replacement({"type": "milvus_v2"}) is False
    assert storage_backend_owns_document_replacement({"type": 5}) is False
    assert (
        storage_backend_owns_document_replacement(
            {"type": "milvus", "indexStrategy": "wegent_v2"}
        )
        is False
    )
    assert storage_backend_owns_document_replacement({}) is False
    assert storage_backend_owns_document_replacement(None) is False
    # The question used to be asked with a bare storage type.
    assert storage_backend_owns_document_replacement("milvus") is False


def test_ownership_does_not_swallow_a_routing_rule_a_known_type_breaks() -> None:
    """A config for a known type that breaks its rule fails, it is not answered.

    The reserved prefix with a strategy that shares one index is refused when
    the adapter is built, so answering the delete-order question with a plain
    False would let indexing start down a path that cannot finish. It fails
    here for the same reason and in the same way.
    """
    from knowledge_engine.storage.factory import (
        storage_backend_owns_document_replacement,
    )

    with pytest.raises(ValueError, match="wegent_v2"):
        storage_backend_owns_document_replacement(
            {
                "type": "milvus",
                "indexStrategy": {"mode": "fixed", "prefix": "wegent_v2"},
            }
        )


@pytest.mark.parametrize(
    "storage_config",
    [
        pytest.param(_milvus_storage_config(), id="legacy-default-prefix"),
        pytest.param(_milvus_storage_config(prefix="wegent"), id="legacy-prefix"),
        pytest.param(_milvus_storage_config(prefix="wegent_v2"), id="reserved-prefix"),
    ],
)
def test_ownership_answers_from_the_adapter_the_builder_builds(
    storage_config: dict,
) -> None:
    """One resolver answers both questions, so they can never disagree."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
        storage_backend_owns_document_replacement,
    )

    backend = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(name="retriever-1", storage_config=storage_config)
    )

    assert (
        storage_backend_owns_document_replacement(storage_config)
        is backend.owns_document_replacement
    )


def test_document_replacement_capability_comes_from_the_backend_class(
    monkeypatch,
) -> None:
    """The capability is declared once, by the backend that owns the write."""
    from knowledge_engine.storage.factory import (
        STORAGE_BACKEND_REGISTRY,
        storage_backend_owns_document_replacement,
    )

    class ReplacingBackend:
        owns_document_replacement = True

    class PlainBackend:
        owns_document_replacement = False

    monkeypatch.setitem(STORAGE_BACKEND_REGISTRY, "replacing", ReplacingBackend)
    monkeypatch.setitem(STORAGE_BACKEND_REGISTRY, "plain", PlainBackend)

    assert storage_backend_owns_document_replacement({"type": "replacing"}) is True
    assert storage_backend_owns_document_replacement({"type": "plain"}) is False


def test_create_storage_backend_from_runtime_config_requires_url() -> None:
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    with pytest.raises(ValueError, match="storage url must be provided"):
        create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-a",
                storage_config={
                    "type": "qdrant",
                },
            )
        )
