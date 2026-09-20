# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Real-Milvus compatibility smoke for the frozen legacy Milvus adapter.

These tests reach the adapter the way production does - through the storage
factory, from a Retriever's ``storageConfig.type: milvus`` - and then drive the
entries the business services use: ``DocumentService`` for the write, the
document read and the document delete, ``QueryExecutor`` for the retrieval
modes, and the adapter's own purge and drop entries for the knowledge base
cleanup. They prove that an existing knowledge base keeps serving the
collection the legacy implementation wrote, without calling the V2 adapter's
cleanup.

Legacy and V2 are configured with different Milvus databases, so both
generations can hold the same knowledge id, the same collection name and the
same parent sidecar name at once without colliding. The service is the pinned
standalone the V2 contract suite already starts, and the visibility window and
the parent-removal wait are that suite's own helpers: a smoke that cannot reach
the service fails instead of skipping, because a skipped compatibility test
proves nothing.

One physical difference the pinned server imposes: Milvus 2.5.4 refuses a
1-dimensional vector, and the frozen adapter creates its parent sidecar with
exactly that placeholder dimension. A legacy knowledge base's parent sidecar
therefore cannot be created by the adapter on this server at all, so
``LegacyContractEnv.write_parent_sidecar`` stores those rows itself - the
legacy fields, the legacy rows - and the parent tests then verify the
adapter's own read and expansion path over them. Every document row, on the
other hand, is written through the product's write seam.
"""

from __future__ import annotations

import asyncio
import json
import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Sequence

import pytest
from llama_index.core import Document
from llama_index.core.embeddings import BaseEmbedding
from llama_index.core.schema import BaseNode
from pymilvus import MilvusClient

from knowledge_engine.embedding.space import derive_embedding_space_id
from knowledge_engine.query.executor import QueryExecutor
from knowledge_engine.services.document_service import DocumentService
from knowledge_engine.splitter.hierarchical import (
    HierarchicalNodes,
    build_hierarchical_nodes,
)
from knowledge_engine.storage.base import BaseStorageBackend
from knowledge_engine.storage.chunk_metadata import ChunkMetadata
from knowledge_engine.storage.factory import create_storage_backend_from_runtime_config
from knowledge_engine.storage.milvus.backend import MilvusBackend as MilvusV2Backend
from knowledge_engine.storage.milvus_backend import MilvusBackend as LegacyMilvusBackend
from shared.models import RuntimeRetrieverConfig

from ..milvus.conftest import (
    CONTRACT_CREATED_AT,
    CONTRACT_DIMENSION,
    CONTRACT_USER_ID,
    VISIBILITY_POLL_SECONDS,
    VISIBILITY_TIMEOUT_SECONDS,
)
from ..milvus.conftest import DeterministicEmbedding as TokenVectors

CONTRACT_URI_ENV = "MILVUS_CONTRACT_URI"
# The production rule the transition's ADR sets: one Milvus database per
# storage type. It is what keeps the identical collection names, prefixes and
# parent sidecars of the two generations physically apart.
LEGACY_DATABASE = "wegent_legacy_contract"
V2_DATABASE = "default"
# Milvus 2.5.4 refuses vector dimensions below 2, so a legacy parent sidecar is
# reproduced with the smallest vector the pinned server accepts. The legacy
# implementation stores this field as a placeholder and never searches it.
SIDECAR_VECTOR_DIMENSION = 2
EMBEDDING_MODEL_NAME = "legacy-contract-model"

FLAT_SPLITTER = {
    "chunk_strategy": "flat",
    "format_enhancement": "none",
    "flat_config": {"chunk_size": 128, "chunk_overlap": 0, "separator": "\n\n"},
}
HIERARCHICAL_CONFIG = {
    "parent_chunk_size": 256,
    "child_chunk_size": 128,
    "child_chunk_overlap": 0,
    "parent_separator": "\n\n",
    "child_separator": "\n",
}

# The contract suite's deterministic vectors, read through one shared instance:
# the legacy adapter embeds through LlamaIndex and refuses a duck-typed model,
# so the shape is reused rather than the class.
_TOKEN_VECTORS = TokenVectors(CONTRACT_DIMENSION)


class DeterministicEmbedding(BaseEmbedding):
    """Provider-free vectors the LlamaIndex-backed legacy adapter accepts.

    The double carries the embedding space identity the V2 adapter binds a
    collection against, which keeps one double usable for both generations in
    the isolation tests.
    """

    dimension: int = CONTRACT_DIMENSION
    model_name: str = EMBEDDING_MODEL_NAME
    embedding_space_id: str = ""

    def __init__(self, **kwargs: Any) -> None:
        super().__init__(
            embedding_space_id=derive_embedding_space_id(
                protocol="contract",
                model_id=EMBEDDING_MODEL_NAME,
            ),
            **kwargs,
        )

    def _get_query_embedding(self, query: str) -> list[float]:
        return _TOKEN_VECTORS._vector(query)

    async def _aget_query_embedding(self, query: str) -> list[float]:
        return _TOKEN_VECTORS._vector(query)

    def _get_text_embedding(self, text: str) -> list[float]:
        return _TOKEN_VECTORS._vector(text)

    def _get_text_embeddings(self, texts: list[str]) -> list[list[float]]:
        return [_TOKEN_VECTORS._vector(text) for text in texts]


@dataclass
class LegacyContractEnv:
    """Builds both generations through the factory and cleans up after itself."""

    uri: str
    legacy_database: str = LEGACY_DATABASE
    v2_database: str = V2_DATABASE
    knowledge_ids: list[str] = field(default_factory=list)

    def new_knowledge_id(self) -> str:
        knowledge_id = uuid.uuid4().hex[:12]
        self.knowledge_ids.append(knowledge_id)
        return knowledge_id

    @property
    def legacy_url(self) -> str:
        """The retriever URL of the legacy generation, database included."""
        return f"{self.uri}/{self.legacy_database}"

    @property
    def v2_url(self) -> str:
        """The retriever URL of the V2 generation, which owns the default db."""
        return f"{self.uri}/{self.v2_database}"

    def legacy_backend(self, *, url: str | None = None) -> LegacyMilvusBackend:
        """Build the frozen adapter the way a ``milvus`` retriever resolves."""
        backend = create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="legacy-contract-retriever",
                storage_config={
                    "type": "milvus",
                    "url": url or self.legacy_url,
                    "indexStrategy": {"mode": "per_dataset", "prefix": "wegent"},
                    "ext": {"dim": CONTRACT_DIMENSION, "timeout": 30.0},
                },
            )
        )
        assert isinstance(backend, LegacyMilvusBackend)
        return backend

    def v2_backend(self, *, url: str | None = None) -> MilvusV2Backend:
        """Build the V2 adapter the way a ``milvus_v2`` retriever resolves."""
        backend = create_storage_backend_from_runtime_config(
            RuntimeRetrieverConfig(
                name="v2-contract-retriever",
                storage_config={
                    "type": "milvus_v2",
                    "url": url or self.v2_url,
                    "indexStrategy": {"mode": "per_dataset", "prefix": "wegent"},
                    "ext": {"timeout": 30.0},
                },
            )
        )
        assert isinstance(backend, MilvusV2Backend)
        return backend

    def inspector(self, database: str) -> MilvusClient:
        """A client on its own connection, for looking at stored collections.

        Each adapter opens and closes the SDK connection named by its URL and
        database, so an inspector sharing that connection would be closed
        underneath a test. This one registers an alias of its own.
        """
        return MilvusClient(uri=self.uri, db_name=database, alias=f"inspect-{database}")

    def collection_name(self, knowledge_id: str) -> str:
        return self.legacy_backend().get_index_name(knowledge_id)

    def parent_sidecar_name(self, knowledge_id: str) -> str:
        return self.legacy_backend().get_parent_store_name(knowledge_id)

    def write_parent_sidecar(
        self,
        knowledge_id: str,
        *,
        doc_ref: str,
        parent_nodes: Sequence[BaseNode],
    ) -> None:
        """Store the parent bodies of a legacy knowledge base's sidecar.

        Legacy's own ``save_parent_nodes`` creates this collection with a
        1-dimensional placeholder vector, which Milvus 2.5.4 refuses, so a
        sidecar can only exist here with the smallest vector the pinned server
        accepts. The fields, the rows and the read path are the legacy ones;
        only the never-searched placeholder dimension differs.
        """
        if not parent_nodes:
            return
        collection_name = self.parent_sidecar_name(knowledge_id)
        client = self.inspector(self.legacy_database)
        try:
            if not client.has_collection(collection_name):
                client.create_collection(
                    collection_name=collection_name,
                    dimension=SIDECAR_VECTOR_DIMENSION,
                    auto_id=True,
                    enable_dynamic_field=True,
                )
            client.insert(
                collection_name=collection_name,
                data=[
                    self._sidecar_row(
                        node,
                        knowledge_id=knowledge_id,
                        doc_ref=doc_ref,
                    )
                    for node in parent_nodes
                ],
            )
            client.flush(collection_name)
        finally:
            client.close()

    @staticmethod
    def _sidecar_row(
        node: BaseNode,
        *,
        knowledge_id: str,
        doc_ref: str,
    ) -> dict[str, Any]:
        """One sidecar row, in the layout the legacy read path binds."""
        # The product applies the chunk metadata to the parent nodes before it
        # hands them to storage, so the stored row names its own document.
        chunk_metadata = chunk_metadata_for(knowledge_id=knowledge_id, doc_ref=doc_ref)
        chunk_metadata.apply_to_nodes([node])
        metadata = dict(node.metadata or {})
        return {
            "vector": [0.0] * SIDECAR_VECTOR_DIMENSION,
            "parent_node_id": node.node_id,
            "knowledge_id": knowledge_id,
            "doc_ref": doc_ref,
            "source_file": metadata.get("source_file"),
            "content": node.text or "",
            "title": metadata.get("source_file", ""),
            "metadata_json": json.dumps(metadata),
        }

    def cleanup(self) -> None:
        """Drop the collections this run created, and nothing else.

        Only the two databases this environment owns are addressed, and only
        the collection names derived from the knowledge ids the tests minted.
        """
        for database in (self.legacy_database, self.v2_database):
            names = {
                name
                for knowledge_id in self.knowledge_ids
                for name in (
                    self.collection_name(knowledge_id),
                    self.parent_sidecar_name(knowledge_id),
                )
            }
            if not names:
                continue
            client = self.inspector(database)
            try:
                for name in sorted(names):
                    if client.has_collection(name):
                        client.drop_collection(name)
            finally:
                client.close()


def chunk_metadata_for(*, knowledge_id: str, doc_ref: str) -> ChunkMetadata:
    """The chunk metadata the product applies before it stores node rows."""
    return ChunkMetadata(
        knowledge_id=knowledge_id,
        doc_ref=doc_ref,
        source_file=f"document-{doc_ref}.txt",
        created_at=CONTRACT_CREATED_AT,
    )


def write_document(
    backend: BaseStorageBackend,
    *,
    knowledge_id: str,
    document_id: int,
    text: str,
    model: DeterministicEmbedding,
) -> dict[str, Any]:
    """Write one document through the entry the document service uses."""
    service = DocumentService(storage_backend=backend)
    return asyncio.run(
        service.index_document_from_binary(
            knowledge_id=knowledge_id,
            binary_data=text.encode("utf-8"),
            source_file=f"document-{document_id}.txt",
            file_extension=".txt",
            embed_model=model,
            user_id=CONTRACT_USER_ID,
            splitter_config=FLAT_SPLITTER,
            document_id=document_id,
        )
    )


def write_chunk_nodes(
    backend: BaseStorageBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
    nodes: Sequence[BaseNode],
    model: DeterministicEmbedding,
) -> None:
    """Write prepared chunk rows through the storage seam DocumentIndexer uses.

    The caller owns the node text and metadata, so a test can store the child
    chunks of a hierarchical document - the ones that carry their parent id -
    without going through file ingestion.
    """
    chunk_metadata = chunk_metadata_for(knowledge_id=knowledge_id, doc_ref=doc_ref)
    chunk_metadata.apply_to_nodes(list(nodes))
    backend.index_with_metadata(
        nodes=list(nodes),
        chunk_metadata=chunk_metadata,
        embed_model=model,
        user_id=CONTRACT_USER_ID,
    )


def delete_document(
    backend: BaseStorageBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
) -> dict[str, Any]:
    """Delete one document through the entry the delete caller uses."""
    service = DocumentService(storage_backend=backend)
    return asyncio.run(
        service.delete_document(
            knowledge_id=knowledge_id,
            doc_ref=doc_ref,
            user_id=CONTRACT_USER_ID,
        )
    )


def retrieve(
    backend: BaseStorageBackend,
    *,
    knowledge_id: str,
    query: str,
    model: DeterministicEmbedding,
    mode: str = "vector",
) -> dict[str, Any]:
    """Retrieve through the backend-agnostic query executor."""
    executor = QueryExecutor(storage_backend=backend, embed_model=model)
    return asyncio.run(
        executor.execute(
            knowledge_id=knowledge_id,
            query=query,
            retrieval_config={
                "top_k": 10,
                "score_threshold": 0.0,
                "retrieval_mode": mode,
            },
            user_id=CONTRACT_USER_ID,
        )
    )


def mentioning(records: Sequence[dict[str, Any]], marker: str) -> list[dict[str, Any]]:
    """Keep the records whose readable body carries the marker."""
    return [record for record in records if marker in (record.get("content") or "")]


def doc_refs(records: Sequence[dict[str, Any]]) -> set[str]:
    """The documents one record set names."""
    return {str((record.get("metadata") or {}).get("doc_ref")) for record in records}


def wait_for_document_removal(
    backend: BaseStorageBackend,
    *,
    knowledge_id: str,
    doc_ref: str,
    timeout: float = VISIBILITY_TIMEOUT_SECONDS,
) -> None:
    """Wait until the reading path stops serving a deleted document."""
    started = time.monotonic()
    deadline = started + timeout
    while True:
        try:
            backend.get_document(knowledge_id, doc_ref, user_id=CONTRACT_USER_ID)
        except ValueError as exc:
            # "not found" is the removal; anything else is a real read failure
            # that must not be mistaken for one.
            if "not found" in str(exc):
                return
            raise
        if time.monotonic() >= deadline:
            waited = time.monotonic() - started
            raise AssertionError(
                f"document {doc_ref} of knowledge base {knowledge_id} was still "
                f"readable {waited:.2f}s after its delete returned; the delete "
                "did not land."
            )
        time.sleep(VISIBILITY_POLL_SECONDS)


def collection_fields(client: MilvusClient, collection_name: str) -> set[str]:
    """The field names one stored collection declares."""
    description = client.describe_collection(collection_name)
    return {str(field.get("name")) for field in description.get("fields", [])}


def paragraph(*, key: str, index: int) -> str:
    """One indexed paragraph of filler text, carrying a searchable key."""
    return f"{key} paragraph {index} " + "topic filler sentence " * 8


def document_text(*, marker: str, key: str = "alpha") -> str:
    """A document whose last paragraph carries the marker a test searches for.

    The body is long enough to split into several chunks at the contract's
    chunk size, so a rewrite that stores fewer of them proves the previous
    version is gone rather than overwritten in place.
    """
    paragraphs = [paragraph(key=key, index=index) for index in range(6)]
    paragraphs.append(f"{marker} closing paragraph " + "topic filler sentence " * 8)
    return "\n\n".join(paragraphs)


def hierarchical_nodes(text: str) -> HierarchicalNodes:
    """The parent and child nodes one hierarchical document splits into."""
    return build_hierarchical_nodes(
        documents=[Document(text=text)],
        parent_chunk_size=HIERARCHICAL_CONFIG["parent_chunk_size"],
        child_chunk_size=HIERARCHICAL_CONFIG["child_chunk_size"],
        child_chunk_overlap=HIERARCHICAL_CONFIG["child_chunk_overlap"],
        parent_separator=HIERARCHICAL_CONFIG["parent_separator"],
        child_separator=HIERARCHICAL_CONFIG["child_separator"],
    )


@pytest.fixture(scope="session")
def milvus_uri() -> str:
    """The pinned Milvus service, or a failure - never a skip."""
    uri = os.environ.get(CONTRACT_URI_ENV)
    if not uri:
        pytest.fail(
            f"{CONTRACT_URI_ENV} must point at a real Milvus service "
            "(for example http://localhost:19530); the legacy compatibility "
            "smoke never skips.",
            pytrace=False,
        )
    client = None
    try:
        client = MilvusClient(uri=uri, alias="legacy-contract-probe")
        client.list_collections()
    except Exception as exc:  # pragma: no cover - depends on the environment
        pytest.fail(
            f"Milvus service at {uri} is unreachable: {exc}",
            pytrace=False,
        )
    finally:
        if client is not None:
            client.close()
    return uri


@pytest.fixture(scope="session")
def legacy_database(milvus_uri: str) -> str:
    """The legacy generation's database, created once and left in place.

    The database is the physical separation the two generations rely on, so
    the smoke creates it the way a deployment would. It is not this suite's to
    remove; the collections the tests store inside it are.
    """
    client = MilvusClient(uri=milvus_uri, alias="legacy-contract-database")
    try:
        if LEGACY_DATABASE not in client.list_databases():
            client.create_database(LEGACY_DATABASE)
    finally:
        client.close()
    return LEGACY_DATABASE


@pytest.fixture
def legacy_milvus_env(milvus_uri: str, legacy_database: str) -> LegacyContractEnv:
    env = LegacyContractEnv(uri=milvus_uri, legacy_database=legacy_database)
    try:
        yield env
    finally:
        env.cleanup()
