# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared fixture for the real-Milvus contract tests.

The fixture never skips. If ``MILVUS_CONTRACT_URI`` is missing or the service
is unreachable the tests fail, because a skipped contract test would report
green while proving nothing.
"""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass, field

import pytest
from pymilvus import MilvusClient

from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.milvus_native import INDEX_BINDING_COLLECTION

CONTRACT_URI_ENV = "MILVUS_CONTRACT_URI"


def is_milvus_lite(uri: str) -> bool:
    """A local ``*.db`` path means the embedded Milvus Lite server."""
    return not uri.startswith(("http://", "https://", "tcp://", "unix:"))


@dataclass
class MilvusContractEnv:
    """Creates isolated knowledge bases and removes them afterwards."""

    uri: str
    created_knowledge_ids: list[str] = field(default_factory=list)

    def new_knowledge_id(self) -> str:
        knowledge_id = uuid.uuid4().hex[:12]
        self.created_knowledge_ids.append(knowledge_id)
        return knowledge_id

    def backend(self, *, dimension: int | None = None) -> MilvusBackend:
        ext = {"timeout": 30.0}
        if dimension is not None:
            ext["dim"] = dimension
        return MilvusBackend(
            {
                "url": self.uri,
                "indexStrategy": {"mode": "per_dataset", "prefix": "wegent"},
                "ext": ext,
            }
        )

    def collection_name(self, knowledge_id: str) -> str:
        return self.backend().get_index_name(knowledge_id)

    def has_collection(self, knowledge_id: str) -> bool:
        client = MilvusClient(uri=self.uri)
        try:
            return bool(client.has_collection(self.collection_name(knowledge_id)))
        finally:
            client.close()

    def cleanup(self) -> None:
        client = MilvusClient(uri=self.uri)
        try:
            for knowledge_id in self.created_knowledge_ids:
                for name in (
                    self.collection_name(knowledge_id),
                    f"{self.collection_name(knowledge_id)}__parents",
                ):
                    if client.has_collection(name):
                        client.drop_collection(name)
                if client.has_collection(INDEX_BINDING_COLLECTION):
                    client.delete(
                        collection_name=INDEX_BINDING_COLLECTION,
                        filter=(
                            f'collection_name == "{self.collection_name(knowledge_id)}"'
                        ),
                    )
        finally:
            client.close()


@pytest.fixture(scope="session")
def milvus_uri() -> str:
    uri = os.environ.get(CONTRACT_URI_ENV)
    if not uri:
        pytest.fail(
            f"{CONTRACT_URI_ENV} must point at a real Milvus service "
            "(for example http://localhost:19530); contract tests never skip.",
            pytrace=False,
        )
    return uri


@pytest.fixture
def milvus_env(milvus_uri) -> MilvusContractEnv:
    env = MilvusContractEnv(uri=milvus_uri)
    try:
        # Fail here, not deep inside a test, when the service is unreachable.
        client = MilvusClient(uri=milvus_uri)
        client.list_collections()
        client.close()
    except Exception as exc:  # pragma: no cover - depends on the environment
        pytest.fail(
            f"Milvus contract service at {milvus_uri} is unreachable: {exc}",
            pytrace=False,
        )
    try:
        yield env
    finally:
        env.cleanup()


@pytest.fixture
def milvus_server_env(
    milvus_env: MilvusContractEnv, milvus_uri: str
) -> MilvusContractEnv:
    """Fixture for contracts that need an atomic server-side collection create.

    Milvus Lite creates collections through the local filesystem, so two
    concurrent creates can both fail and leave a half-created directory. That
    is a limitation of the embedded engine, not of the storage contract, so
    these tests require a real server - and in CI they must never be skipped.
    """
    if is_milvus_lite(milvus_uri):
        if os.environ.get("CI"):
            pytest.fail(
                "concurrency contracts require a real Milvus server in CI, "
                f"but {CONTRACT_URI_ENV}={milvus_uri} looks like Milvus Lite",
                pytrace=False,
            )
        pytest.skip(
            "concurrency contracts require an atomic server-side create; "
            "Milvus Lite creates collection directories non-atomically"
        )
    return milvus_env
