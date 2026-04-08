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
