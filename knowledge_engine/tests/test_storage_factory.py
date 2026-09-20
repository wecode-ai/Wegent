# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

import pytest

from shared.models import RuntimeRetrieverConfig


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
    assert methods["milvus_v2"] == ["vector", "keyword", "hybrid"]


def test_the_two_milvus_storage_types_build_their_own_adapter() -> None:
    """Each Milvus generation is reached through its own storage type.

    The routing is the fact the whole call chain dispatches on, so the two
    types must never build the same adapter: ``milvus`` serves the collections
    the online main branch wrote and ``milvus_v2`` the ones the new contract
    writes.
    """
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus.backend import MilvusBackend
    from knowledge_engine.storage.milvus_legacy import LegacyMilvusBackend

    legacy = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="legacy-retriever",
            storage_config={"type": "milvus", "url": "http://milvus:19530"},
        )
    )
    v2 = create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="v2-retriever",
            storage_config={"type": "milvus_v2", "url": "http://milvus:19530/v2"},
        )
    )

    assert type(legacy) is LegacyMilvusBackend
    assert type(v2) is MilvusBackend
    assert not issubclass(LegacyMilvusBackend, MilvusBackend)
    assert not issubclass(MilvusBackend, LegacyMilvusBackend)


def test_a_milvus_storage_type_is_normalized_before_it_is_dispatched() -> None:
    """A configured type is matched the way every other storage type is."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )
    from knowledge_engine.storage.milvus.backend import MilvusBackend
    from knowledge_engine.storage.milvus_legacy import LegacyMilvusBackend

    configured_types = (
        ("Milvus", LegacyMilvusBackend),
        ("MILVUS_V2", MilvusBackend),
        ("milvus_v2", MilvusBackend),
    )

    for configured_type, expected_adapter in configured_types:
        backend = create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-1",
                storage_config={
                    "type": configured_type,
                    "url": "http://milvus:19530",
                },
            )
        )

        assert type(backend) is expected_adapter


def test_an_unknown_storage_type_is_refused() -> None:
    """A type no adapter answers keeps failing as it does today."""
    from knowledge_engine.storage.factory import (
        create_storage_backend_from_runtime_config,
    )

    with pytest.raises(ValueError, match="Unsupported storage type: milvus_v3"):
        create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-1",
                storage_config={"type": "milvus_v3", "url": "http://milvus:19530"},
            )
        )


def test_a_milvus_v2_runtime_config_reaches_the_backend_verbatim() -> None:
    """The v2 retriever carries its own url, credentials and extra config.

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
                "type": "milvus_v2",
                "url": "http://milvus:19530",
                "username": "tester",
                "password": "s3cret",
                "apiKey": "retriever-key",
                "indexStrategy": {"mode": "per_dataset", "prefix": "wegent"},
                "ext": {"db_name": "wegent_v2", "dim": 1536},
            },
        )
    )

    assert backend.url == "http://milvus:19530"
    assert backend.username == "tester"
    assert backend.password == "s3cret"
    assert backend.api_key == "retriever-key"
    assert backend.index_strategy == {"mode": "per_dataset", "prefix": "wegent"}
    assert backend.ext == {"db_name": "wegent_v2", "dim": 1536}


def test_only_the_self_replacing_storage_types_are_declared() -> None:
    """Only an engine that deletes inside its write owns the replacement.

    The indexing layer asks this before it deletes a document's previous rows,
    so a backend that answers True is the only one deleting them. An unknown
    storage type keeps the existing delete-then-index order.
    """
    from knowledge_engine.storage.factory import (
        storage_backend_owns_document_replacement,
    )

    assert storage_backend_owns_document_replacement("milvus") is False
    assert storage_backend_owns_document_replacement("milvus_v2") is True
    assert storage_backend_owns_document_replacement("MILVUS_V2") is True
    assert storage_backend_owns_document_replacement("ELASTICSEARCH") is False
    assert storage_backend_owns_document_replacement("qdrant") is False
    assert storage_backend_owns_document_replacement("unknown") is False


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

    assert storage_backend_owns_document_replacement("replacing") is True
    assert storage_backend_owns_document_replacement("plain") is False


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
