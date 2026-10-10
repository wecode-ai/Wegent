# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

from importlib import import_module

import pytest

from knowledge_engine.storage import factory
from shared.models import RuntimeRetrieverConfig


def test_create_storage_backend_from_runtime_config_builds_backend_config(
    monkeypatch,
) -> None:
    captured: dict[str, object] = {}

    class FakeBackend:
        def __init__(self, config):
            captured["config"] = config

    monkeypatch.setattr(
        factory,
        "_load_backend_class",
        lambda storage_type: FakeBackend,
    )

    backend = factory.create_storage_backend_from_runtime_config(
        RuntimeRetrieverConfig(
            name="retriever-a",
            storage_config={
                "type": "qdrant",
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


def test_capability_registry_matches_backend_declarations() -> None:
    from knowledge_engine.storage.capabilities import (
        STORAGE_BACKEND_SPECS,
        get_all_storage_retrieval_methods,
        get_supported_retrieval_methods,
        get_supported_storage_types,
    )

    assert get_supported_storage_types() == list(STORAGE_BACKEND_SPECS.keys())

    for storage_type, spec in STORAGE_BACKEND_SPECS.items():
        backend_class = getattr(import_module(spec.module), spec.class_name)
        assert get_supported_retrieval_methods(storage_type) == list(
            backend_class.get_supported_retrieval_methods()
        )
        assert get_all_storage_retrieval_methods()[storage_type] == list(
            backend_class.get_supported_retrieval_methods()
        )


def test_get_supported_retrieval_methods_rejects_unknown_type() -> None:
    from knowledge_engine.storage.capabilities import get_supported_retrieval_methods

    with pytest.raises(ValueError, match="Unsupported storage type: unknown"):
        get_supported_retrieval_methods("unknown")


def test_create_storage_backend_from_runtime_config_requires_url() -> None:
    with pytest.raises(ValueError, match="storage url must be provided"):
        factory.create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="retriever-a",
                storage_config={
                    "type": "qdrant",
                },
            )
        )
