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

import pytest
from llama_index.core.schema import TextNode
from pymilvus import MilvusClient

from knowledge_engine.embedding.space import derive_embedding_space_id
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_engine.storage.milvus.backend import MilvusBackend
from shared.models import RuntimeRetrieverConfig

CONTRACT_URI_ENV = "MILVUS_CONTRACT_URI"
# The prefix that routes this suite's ``milvus`` retriever to the second
# generation. It is written out instead of imported: a contract suite that read
# the constant would follow the routing rule rather than pin the value a
# deployment is configured with.
V2_RESERVED_PREFIX = "wegent_v2"
CONTRACT_DIMENSION = 1536
CONTRACT_CREATED_AT = "2026-01-01T00:00:00Z"
CONTRACT_USER_ID = 1
# Retrieval reads at Bounded, so the first reads after a write may be answered
# from a snapshot that predates it. Measured on the pinned 2.5.4 fixture with one
# fresh collection per round, the document read, the dense search and the
# keyword search all become visible in the same 0.2-0.5s window. The write path
# returns without waiting for it (ticket 11), so a contract test that asserts on
# a document it just wrote waits it out instead of asserting inside it.
VISIBILITY_WINDOW_SECONDS = 0.5
VISIBILITY_TIMEOUT_SECONDS = 2.0
VISIBILITY_POLL_SECONDS = 0.05


class DeterministicEmbedding:
    """Deterministic, provider-free vectors shared by the contract tests."""

    def __init__(self, dimension: int, *, model_name: str = "contract-model"):
        self.dimension = dimension
        self.model_name = model_name
        self._configured_dimension = dimension
        # The embedding factory derives this for every model it builds, so the
        # double carries the identity the storage contract binds against.
        self.embedding_space_id = derive_embedding_space_id(
            protocol="contract",
            model_id=model_name,
        )

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
    user_id: int = CONTRACT_USER_ID,
) -> None:
    """Write prepared nodes through the storage entry the document service uses.

    The caller owns the node text and metadata, so a contract test can index a
    document with real chunk shapes without going through file ingestion. The
    user is part of the call because a strategy that shares a collection - the
    per-user one - names that collection from it.
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
        user_id=user_id,
    )
    await_document_visibility(
        backend,
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        expected_chunks=len(nodes),
        user_id=user_id,
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

    ``expected_chunks`` is matched exactly, so a snapshot of a longer previous
    version does not satisfy a wait meant for the shorter rewrite that
    replaced it.
    """
    started = time.monotonic()
    deadline = started + timeout
    while True:
        try:
            document = backend.get_document(knowledge_id, doc_ref, **read_kwargs)
        except ValueError as exc:
            # "not found" is the window; anything else is a real read failure.
            if "not found" not in str(exc):
                raise
            document = None
        if document is not None:
            visible_chunks = int(document.get("chunk_count") or 0)
            if expected_chunks is None or visible_chunks == expected_chunks:
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


def await_parent_removal(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    parent_node_ids: list[str],
    timeout: float = VISIBILITY_TIMEOUT_SECONDS,
    **read_kwargs,
) -> None:
    """Wait until the reading path stops serving deleted parent nodes.

    The same ``Bounded`` snapshot that hides a fresh write for a moment also
    still answers with rows a delete has already removed, so a read issued
    inside ``VISIBILITY_WINDOW_SECONDS`` of ``delete_parent_nodes`` can expand
    a child hit to the parent body it was supposed to lose. The product
    accepts that window - the delete returns as soon as the server accepted it
    - so a contract test waits it out here rather than asserting inside it.

    The poll uses the storage entry the expansion uses, so this proves the
    removal becomes readable. A parent that is still stored when the deadline
    passes fails with the time it waited, because a delete that never lands is
    not the window the spec accepts.
    """
    started = time.monotonic()
    deadline = started + timeout
    while True:
        if not backend.get_parent_nodes(knowledge_id, parent_node_ids, **read_kwargs):
            return
        if time.monotonic() >= deadline:
            waited = time.monotonic() - started
            raise AssertionError(
                f"parent nodes {parent_node_ids} of knowledge base "
                f"{knowledge_id} were still readable {waited:.2f}s after their "
                f"delete returned; the measured visibility window is "
                f"~{VISIBILITY_WINDOW_SECONDS}s, so this is a delete that did "
                "not land, not that window."
            )
        time.sleep(VISIBILITY_POLL_SECONDS)


def await_parent_visibility(
    backend: MilvusBackend,
    *,
    knowledge_id: str,
    parent_refs: list[tuple[str, str]],
    timeout: float = VISIBILITY_TIMEOUT_SECONDS,
    **read_kwargs,
) -> dict:
    """Wait until the reading path serves the parent rows that were just written.

    The sidecar lives in its own ``Bounded`` collection, so a read issued
    inside the accepted visibility window can miss a fresh parent row for the
    same reason the index can. The poll uses the product's own read entry and
    never becomes a silent skip: a parent row that is still missing when the
    deadline passes fails with the time it waited.
    """
    parent_node_ids = [parent_node_id for _, parent_node_id in parent_refs]
    started = time.monotonic()
    deadline = started + timeout
    while True:
        found = backend.get_parent_nodes(
            knowledge_id,
            parent_node_ids,
            parent_refs=parent_refs,
            **read_kwargs,
        )
        if set(found) == set(parent_node_ids):
            return found
        if time.monotonic() >= deadline:
            waited = time.monotonic() - started
            raise AssertionError(
                f"parent nodes {parent_node_ids} of knowledge base "
                f"{knowledge_id} were still not readable {waited:.2f}s after "
                "their write returned; the measured visibility window is "
                f"~{VISIBILITY_WINDOW_SECONDS}s, so this is a write that did "
                "not land, not that window."
            )
        time.sleep(VISIBILITY_POLL_SECONDS)


def drop_collection_with_contract(uri: str, collection_name: str) -> None:
    """Drop one stored collection, its parent sidecar and its contract.

    The contract lives in the collection's own description, so dropping the
    collection is all it takes to remove it.
    """
    client = MilvusClient(uri=uri)
    try:
        for name in (collection_name, f"{collection_name}__parents"):
            if client.has_collection(name):
                client.drop_collection(name)
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
        """Build the V2 adapter the way a reserved-prefix Retriever resolves.

        The routing rule is the factory's, so this is the config a Retriever
        declares for the second generation - one public storage type plus the
        reserved prefix - rather than the adapter constructed by hand.
        """
        ext = {"timeout": 30.0}
        if dimension is not None:
            ext["dim"] = dimension
        backend = create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="v2-contract-retriever",
                storage_config={
                    "type": "milvus",
                    "url": self.uri,
                    "indexStrategy": {
                        "mode": "per_dataset",
                        "prefix": V2_RESERVED_PREFIX,
                    },
                    "ext": ext,
                },
            )
        )
        assert isinstance(backend, MilvusBackend)
        return backend

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
    # Fail here, not deep inside a test, when the service cannot answer.
    client = MilvusClient(uri=uri)
    try:
        client.list_collections()
    except Exception as exc:  # pragma: no cover - depends on the environment
        pytest.fail(
            f"Milvus contract service at {uri} is unreachable: {exc}",
            pytrace=False,
        )
    finally:
        client.close()
    return uri


@pytest.fixture
def milvus_env(milvus_uri) -> MilvusContractEnv:
    env = MilvusContractEnv(uri=milvus_uri)
    try:
        yield env
    finally:
        env.cleanup()
