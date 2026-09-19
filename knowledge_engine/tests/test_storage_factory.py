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


def test_only_the_self_replacing_storage_types_are_declared() -> None:
    """Only an engine that deletes inside its write owns the replacement.

    The indexing layer asks this before it deletes a document's previous rows,
    so a backend that answers True is the only one deleting them. An unknown
    storage type keeps the existing delete-then-index order.
    """
    from knowledge_engine.storage.factory import (
        storage_backend_owns_document_replacement,
    )

    assert storage_backend_owns_document_replacement("milvus") is True
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
