# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

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
