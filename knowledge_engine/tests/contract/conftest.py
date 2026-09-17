# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Shared fixture for the real-Milvus contract tests.

The fixture never skips. If ``MILVUS_CONTRACT_URI`` is missing or the service
is unreachable the tests fail, because a skipped contract test would report
green while proving nothing.
"""

from __future__ import annotations

import hashlib
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Iterator

import pytest
from llama_index.core.schema import TextNode
from pymilvus import MilvusClient

from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.milvus_backend import MilvusBackend
from knowledge_engine.storage.milvus_native import INDEX_BINDING_COLLECTION
from tests.contract.milvus_fault_injection import (
    SilentTcpTarget,
    SlowRpcMilvusPeer,
)

CONTRACT_URI_ENV = "MILVUS_CONTRACT_URI"
CONTRACT_DIMENSION = 1536
CONTRACT_CREATED_AT = "2026-01-01T00:00:00Z"
# Retrieval reads at Bounded, so the first reads after a write may be answered
# from a snapshot that predates it. Measured on the pinned 2.5.4 fixture, one
# fresh collection per round and five chunks per document: dense search ~0.42s,
# keyword search ~0.63s, document read up to ~0.87s (0.3-0.5s when the
# collection is already warmed). The write path returns without waiting for that
# window (ticket 11), so a contract test that asserts on a document it just
# wrote waits it out instead of asserting inside it.
VISIBILITY_WINDOW_SECONDS = 0.9
VISIBILITY_TIMEOUT_SECONDS = 2.0
VISIBILITY_POLL_SECONDS = 0.05


@pytest.fixture
def silent_tcp_target() -> Iterator[SilentTcpTarget]:
    """A local endpoint that accepts a connection and then goes silent."""
    target = SilentTcpTarget()
    try:
        yield target
    finally:
        target.close()


@pytest.fixture
def slow_rpc_milvus_peer() -> Iterator[SlowRpcMilvusPeer]:
    """A local gRPC peer that answers the handshake and delays other RPCs."""
    peer = SlowRpcMilvusPeer()
    try:
        yield peer
    finally:
        peer.close()


class DeterministicEmbedding:
    """Deterministic, provider-free vectors shared by the contract tests."""

    def __init__(self, dimension: int, *, model_name: str = "contract-model"):
        self.dimension = dimension
        self.model_name = model_name
        self._configured_dimension = dimension

    def _vector(self, text: str) -> list[float]:
        vector = [0.0] * self.dimension
        for token in text.lower().split():
            digest = hashlib.sha256(token.encode("utf-8")).digest()
            index = int.from_bytes(digest[:4], "big") % self.dimension
            vector[index] += 1.0
        if not any(vector):
            vector[0] = 1.0
        return vector

    def get_text_embedding_batch(self, texts, **kwargs):
        return [self._vector(text) for text in texts]

    def get_query_embedding(self, query: str) -> list[float]:
        return self._vector(query)


def index_nodes(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
    nodes: list[TextNode],
    created_at: str = CONTRACT_CREATED_AT,
    dimension: int = CONTRACT_DIMENSION,
) -> None:
    """Write prepared nodes through the storage entry the document service uses.

    The caller owns the node text and metadata, so a contract test can index a
    document with real chunk shapes without going through file ingestion.
    """
    chunk_metadata = ChunkMetadata(
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        source_file=f"document-{doc_ref}.txt",
        created_at=created_at,
    )
    chunk_metadata.apply_to_nodes(nodes)
    backend.index_with_metadata(
        nodes=nodes,
        chunk_metadata=chunk_metadata,
        embed_model=DeterministicEmbedding(dimension),
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        expected_chunks=len(nodes),
    )


def await_document_visibility(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
    expected_chunks: int | None = None,
    timeout: float = VISIBILITY_TIMEOUT_SECONDS,
    **read_kwargs,
):
    """Wait until the reading path serves a document that was just written.

    Milvus answers a ``Bounded`` read from a timestamp it keeps behind the
    newest data, so a read issued within ``VISIBILITY_WINDOW_SECONDS`` of a
    write can come back empty or partial. The product accepts that window - the
    write returns as soon as the server accepted the rows (ticket 11) - and
    contract tests wait for it here rather than loosening their assertions.

    The poll uses the product's own reading path, so this proves the write
    becomes readable. It never becomes a silent skip: a document that is still
    missing when the deadline passes fails with the time it waited, because a
    write that never lands is not the window the spec accepts.
    """
    started = time.monotonic()
    deadline = started + timeout
    while True:
        try:
            document = backend.get_document(knowledge_id, doc_ref, **read_kwargs)
        except ValueError:
            document = None
        if document is not None:
            visible_chunks = int(document.get("chunk_count") or 0)
            if expected_chunks is None or visible_chunks >= expected_chunks:
                return document
        if time.monotonic() >= deadline:
            waited = time.monotonic() - started
            raise AssertionError(
                f"document {doc_ref} of knowledge base {knowledge_id} was still "
                f"not readable {waited:.2f}s after its write returned; the "
                f"measured visibility window is ~{VISIBILITY_WINDOW_SECONDS}s, "
                "so this is a write that did not land, not that window."
            )
        time.sleep(VISIBILITY_POLL_SECONDS)


def is_milvus_lite(uri: str) -> bool:
    """A local ``*.db`` path means the embedded Milvus Lite server."""
    return not uri.startswith(("http://", "https://", "tcp://", "unix:"))


def drop_collection_with_contract(uri: str, collection_name: str) -> None:
    """Drop one stored collection, its parent sidecar and its contract."""
    client = MilvusClient(uri=uri)
    try:
        for name in (collection_name, f"{collection_name}__parents"):
            if client.has_collection(name):
                client.drop_collection(name)
        if client.has_collection(INDEX_BINDING_COLLECTION):
            client.delete(
                collection_name=INDEX_BINDING_COLLECTION,
                filter=f'collection_name == "{collection_name}"',
            )
    finally:
        client.close()


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
        for knowledge_id in self.created_knowledge_ids:
            drop_collection_with_contract(self.uri, self.collection_name(knowledge_id))


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
