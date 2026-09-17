# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded PyMilvus access: client lifetimes, RPCs and the index contract.

This module owns the talking part - one short-lived official client per bounded
operation, the RPCs the adapters call, and reading, writing and verifying the
stored index contract. The row layout, contract vocabulary, row identifiers and
filters it works with live in ``milvus_native``. It never resolves retrieval
text or calls an embedding provider, so the adapter above it can be tested
against real Milvus without a model.
"""

from __future__ import annotations

import logging
import time
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Sequence

import grpc
from pymilvus import CollectionSchema, MilvusClient
from pymilvus.exceptions import MilvusException

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
)
from knowledge_engine.storage.milvus_errors import rpc_failure
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    BINDING_STATE_FIELD,
    BINDING_STATE_READY,
    BINDING_VECTOR_FIELD,
    BINDING_VECTOR_VALUE,
    DEFAULT_RPC_TIMEOUT_SECONDS,
    DENSE_VECTOR_FIELD,
    HEAVY_RPC_TIMEOUT_SECONDS,
    ID_FIELD,
    INDEX_BINDING_COLLECTION,
    INDEX_TYPE,
    MAX_COUNT_ROWS,
    METRIC_TYPE,
    READ_CONSISTENCY_LEVEL,
    ROW_OUTPUT_FIELDS,
    SCHEMA_VERSION,
    SPARSE_INDEX_TYPE,
    SPARSE_METRIC_TYPE,
    SPARSE_VECTOR_FIELD,
    WRITE_CONSISTENCY_LEVEL,
    MilvusIndexBinding,
    build_binding_collection_schema,
    build_collection_schema,
    collection_dimension,
    sanitize_filter_value,
    strip_connection_credentials,
)

logger = logging.getLogger(__name__)

# A concurrent creation is allowed a short bounded re-read before it is called
# a foreign collection; the wait never turns into an unbounded poll.
CONCURRENT_BINDING_TIMEOUT_SECONDS = 5.0
CONCURRENT_BINDING_POLL_SECONDS = 0.05


class MilvusDocumentStore:
    """Bounded, synchronous PyMilvus access with explicit client lifetimes."""

    def __init__(
        self,
        *,
        uri: str,
        token: str = "",
        db_name: str = "default",
        timeout: float = 10.0,
        client_factory: Callable[..., MilvusClient] = MilvusClient,
    ) -> None:
        self.uri = uri
        self.token = token
        self.db_name = db_name
        self.timeout = timeout
        self._client_factory = client_factory

    @contextmanager
    def client(self) -> Iterator[MilvusClient]:
        """Create a short-lived client and always release it."""
        client: MilvusClient | None = None
        try:
            client = self._client_factory(
                uri=self.uri,
                token=self.token,
                db_name=self.db_name,
                timeout=self.timeout,
                # Each bounded task owns its connection. Sharing the default
                # uri-derived alias would let one task's close() tear down
                # another task's connection.
                alias=f"wegent-{uuid.uuid4().hex}",
            )
            yield client
        except (MilvusException, grpc.RpcError) as exc:
            raise rpc_failure(exc) from exc
        finally:
            if client is not None:
                try:
                    client.close()
                except Exception:
                    logger.debug("[Milvus] Failed to close client", exc_info=True)

    @property
    def rpc_timeout(self) -> float:
        """Deadline for one Milvus RPC.

        The PyMilvus client constructor only bounds the initial connection: the
        SDK retries a per-call RPC until that call gets its own ``timeout``
        kwarg. Passing this value to every RPC is what makes an operation
        bounded, so it is the single source of truth for the per-call deadline.
        """
        return self.timeout or DEFAULT_RPC_TIMEOUT_SECONDS

    def connection_identity(self) -> str:
        return strip_connection_credentials(self.uri)

    def build_binding(
        self,
        collection_name: str,
        *,
        dimension: int,
        embedding_space: str,
    ) -> MilvusIndexBinding:
        return MilvusIndexBinding(
            collection_name=collection_name,
            connection=self.connection_identity(),
            database=self.db_name,
            schema_version=SCHEMA_VERSION,
            embedding_space=embedding_space,
            dimension=dimension,
            metric_type=METRIC_TYPE,
            index_type=INDEX_TYPE,
            analyzer=ANALYZER_TYPE,
        )

    def read_binding(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        consistency_level: str = READ_CONSISTENCY_LEVEL,
    ) -> MilvusIndexBinding | None:
        """Read the stored contract for a collection, creating nothing.

        ``consistency_level`` is an internal convention, not a caller knob.
        """
        if not client.has_collection(
            INDEX_BINDING_COLLECTION, timeout=self.rpc_timeout
        ):
            return None
        rows = client.query(
            collection_name=INDEX_BINDING_COLLECTION,
            filter=f'collection_name == "{sanitize_filter_value(collection_name)}"',
            output_fields=["binding_json"],
            limit=1,
            consistency_level=consistency_level,
            timeout=self.rpc_timeout,
        )
        if not rows:
            return None
        return MilvusIndexBinding.from_row(rows[0])

    def read_binding_strong(
        self, client: MilvusClient, collection_name: str
    ) -> MilvusIndexBinding | None:
        """Read a contract the write path owns, as soon as it lands."""
        return self.read_binding(
            client, collection_name, consistency_level=WRITE_CONSISTENCY_LEVEL
        )

    def write_binding(
        self,
        client: MilvusClient,
        binding: MilvusIndexBinding,
    ) -> None:
        self._ensure_registry_collection(
            client,
            INDEX_BINDING_COLLECTION,
            build_binding_collection_schema(),
            vector_field=BINDING_VECTOR_FIELD,
        )
        row = binding.to_row()
        row[BINDING_VECTOR_FIELD] = list(BINDING_VECTOR_VALUE)
        row[BINDING_STATE_FIELD] = BINDING_STATE_READY
        client.upsert(
            collection_name=INDEX_BINDING_COLLECTION,
            data=[row],
            timeout=HEAVY_RPC_TIMEOUT_SECONDS,
        )
        client.flush(INDEX_BINDING_COLLECTION, timeout=HEAVY_RPC_TIMEOUT_SECONDS)

    def _ensure_registry_collection(
        self,
        client: MilvusClient,
        collection_name: str,
        schema: CollectionSchema,
        *,
        vector_field: str,
    ) -> None:
        if client.has_collection(collection_name, timeout=self.rpc_timeout):
            return
        index_params = client.prepare_index_params()
        index_params.add_index(
            field_name=vector_field,
            index_type=INDEX_TYPE,
            metric_type="IP",
        )
        try:
            client.create_collection(
                collection_name=collection_name,
                schema=schema,
                index_params=index_params,
                timeout=HEAVY_RPC_TIMEOUT_SECONDS,
            )
        except Exception:
            if not client.has_collection(collection_name, timeout=self.rpc_timeout):
                raise

    def ensure_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dimension: int,
        embedding_space: str,
    ) -> MilvusIndexBinding:
        """Create the index once, then verify the bound contract afterwards.

        The physical collection is the only atomic ownership resource Milvus
        offers, so exactly one owning contract is guaranteed: the process that
        successfully creates the collection writes the binding, and any other
        writer - including one with the same dimension but a different
        embedding space - is rejected instead of confirming the collection.

        A collection that exists without a binding is an interrupted or
        foreign creation. It is never adopted automatically: the write fails
        loudly and an operator clears the empty collection before retrying.
        """
        requested = self.build_binding(
            collection_name,
            dimension=dimension,
            embedding_space=embedding_space,
        )
        bound = self.read_binding_strong(client, collection_name)
        collection_exists = client.has_collection(
            collection_name, timeout=self.rpc_timeout
        )

        if bound is not None:
            bound.assert_compatible(requested)
            if not collection_exists:
                raise IndexMissingError(
                    collection_name,
                    "the bound collection confirmed earlier is gone",
                )
            self._assert_collection_dimension(client, requested)
            return bound

        if collection_exists:
            raise IndexContractIncompatibleError(
                collection_name,
                "the collection exists without a stored index contract",
            )

        if self._create_collection(client, requested):
            self._assert_collection_dimension(client, requested)
            self.write_binding(client, requested)
            return requested
        return self._await_binding(client, requested)

    def _await_binding(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> MilvusIndexBinding:
        """Re-read a concurrently created collection until its contract lands."""
        deadline = time.monotonic() + CONCURRENT_BINDING_TIMEOUT_SECONDS
        while True:
            if self.read_binding_strong(client, requested.collection_name) is not None:
                return self._verify_existing(client, requested)
            if time.monotonic() >= deadline:
                raise IndexContractIncompatibleError(
                    requested.collection_name,
                    "the collection has no confirmed index contract",
                )
            time.sleep(CONCURRENT_BINDING_POLL_SECONDS)

    def verify_bound_contract(
        self,
        client: MilvusClient,
        collection_name: str,
        binding: MilvusIndexBinding,
        *,
        dimension: int,
        embedding_space: str,
    ) -> None:
        """Verify the contract a caller read for this request and space.

        A caller that read the stored contract once verifies it here instead of
        paying a second registry read. The contract itself is not re-read, so a
        collection dropped and rebuilt inside the same request window - same
        dimension, different embedding space - is not detected. The read paths
        never promised cross-process linearity.
        """
        requested = self.build_binding(
            collection_name,
            dimension=dimension,
            embedding_space=embedding_space,
        )
        binding.assert_compatible(requested)
        self._assert_collection_dimension(client, requested)

    def verify_keyword_binding(
        self, collection_name: str, binding: MilvusIndexBinding
    ) -> None:
        """Verify the keyword capability of a contract the caller already read.

        Keyword retrieval never consults the embedding model, so the stored
        contract alone decides the capability and no client is needed here. A
        bound index whose contract predates the BM25 analyzer fails explicitly:
        an index without the keyword capability must not answer keyword queries
        with an empty result set.
        """
        if not binding.analyzer:
            raise IndexContractIncompatibleError(
                collection_name,
                "the bound index was created without a keyword analyzer",
                details={"analyzer": binding.analyzer},
            )

    def require_bound(
        self, client: MilvusClient, collection_name: str
    ) -> MilvusIndexBinding | None:
        """Return the bound contract of an existing collection, None if absent.

        Deletes use this so a collection is never mutated through a contract
        it does not declare, and they read at the write level to do it.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return None
        bound = self.read_binding_strong(client, collection_name)
        if bound is None:
            raise IndexContractIncompatibleError(
                collection_name,
                "the collection has no stored index contract",
            )
        return bound

    def _create_collection(
        self, client: MilvusClient, binding: MilvusIndexBinding
    ) -> bool:
        index_params = client.prepare_index_params()
        index_params.add_index(
            field_name=DENSE_VECTOR_FIELD,
            index_type=binding.index_type,
            metric_type=binding.metric_type,
        )
        index_params.add_index(
            field_name=SPARSE_VECTOR_FIELD,
            index_type=SPARSE_INDEX_TYPE,
            metric_type=SPARSE_METRIC_TYPE,
        )
        try:
            client.create_collection(
                collection_name=binding.collection_name,
                schema=build_collection_schema(
                    binding.dimension, binding.embedding_space
                ),
                index_params=index_params,
                consistency_level=WRITE_CONSISTENCY_LEVEL,
                timeout=HEAVY_RPC_TIMEOUT_SECONDS,
            )
            return True
        except Exception:
            # A concurrent writer may have created the same collection first.
            if not self._wait_for_collection(client, binding.collection_name):
                raise
            logger.info(
                "[Milvus] Collection %s was created concurrently",
                binding.collection_name,
            )
            return False

    def _wait_for_collection(self, client: MilvusClient, name: str) -> bool:
        """Wait briefly for a concurrently created collection to appear."""
        deadline = time.monotonic() + CONCURRENT_BINDING_TIMEOUT_SECONDS
        while True:
            if client.has_collection(name, timeout=self.rpc_timeout):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(CONCURRENT_BINDING_POLL_SECONDS)

    def _verify_existing(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> MilvusIndexBinding:
        bound = self.read_binding_strong(client, requested.collection_name)
        if bound is None:
            raise IndexContractIncompatibleError(
                requested.collection_name,
                "the collection has no stored index contract",
            )
        self.verify_bound_contract(
            client,
            requested.collection_name,
            bound,
            dimension=requested.dimension,
            embedding_space=requested.embedding_space,
        )
        return bound

    def _assert_collection_dimension(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> None:
        actual_dimension = collection_dimension(
            client,
            requested.collection_name,
            timeout=self.rpc_timeout,
        )
        if actual_dimension != requested.dimension:
            raise IndexContractIncompatibleError(
                requested.collection_name,
                "collection vector dimension differs from the stored contract",
                details={"actual_dimension": actual_dimension},
            )

    def upsert_rows(
        self,
        client: MilvusClient,
        collection_name: str,
        rows: Sequence[Dict[str, Any]],
    ) -> int:
        """Write rows without waiting for a server-side flush.

        Callers own their durability stance: neither this write nor its caller
        waits for the segment to be sealed or for a later read to see it (the
        accepted visibility window, see ``READ_CONSISTENCY_LEVEL``), while the
        delete path flushes the collection explicitly.
        """
        if not rows:
            return 0
        client.upsert(
            collection_name=collection_name,
            data=list(rows),
            timeout=self.rpc_timeout,
        )
        return len(rows)

    def delete_rows(
        self,
        client: MilvusClient,
        collection_name: str,
        filter_expr: str,
        *,
        flush: bool = True,
    ) -> None:
        """Delete the matching rows, flushing unless the caller says otherwise.

        The delete entry point flushes so the removal is durable before it is
        reported. The write path passes ``flush=False``: it re-reads the scope
        through a separate Strong consistency client to prove the rows are
        gone, and it must not seal the segment on every rewrite.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return
        client.delete(
            collection_name=collection_name,
            filter=filter_expr,
            timeout=self.rpc_timeout,
        )
        if flush:
            client.flush(collection_name, timeout=self.rpc_timeout)

    def count_rows(
        self, client: MilvusClient, collection_name: str, filter_expr: str
    ) -> int:
        rows = self.query_rows(
            client,
            collection_name,
            filter_expr,
            output_fields=[ID_FIELD],
            limit=MAX_COUNT_ROWS,
            consistency_level=WRITE_CONSISTENCY_LEVEL,
        )
        if len(rows) >= MAX_COUNT_ROWS:
            raise StorageBackendError(
                "Milvus row count exceeded the verification budget; the count "
                "cannot be trusted for deletion.",
                details={"collection_name": collection_name, "budget": MAX_COUNT_ROWS},
            )
        return len(rows)

    def query_rows(
        self,
        client: MilvusClient,
        collection_name: str,
        filter_expr: str,
        *,
        output_fields: Sequence[str] | None = None,
        limit: int,
        offset: int = 0,
        consistency_level: str = READ_CONSISTENCY_LEVEL,
    ) -> List[Dict[str, Any]]:
        """Read one page of matching rows.

        Milvus does not order a query result, so ``offset`` continues the
        server's own order: it pages a static collection the way ``limit``
        alone cannot, and the caller owns any order it promises on top.

        ``consistency_level`` is an internal convention rather than a caller
        knob: retrieval pages with the read level, and a count that decides a
        deletion uses the write level, which waits for the newest data.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return []
        return list(
            client.query(
                collection_name=collection_name,
                filter=filter_expr,
                output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
                limit=limit,
                offset=offset,
                consistency_level=consistency_level,
                timeout=self.rpc_timeout,
            )
        )

    def search(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        query_vector: Sequence[float],
        filter_expr: str,
        limit: int,
        output_fields: Sequence[str] | None = None,
    ) -> List[Dict[str, Any]]:
        """Dense vector search returning raw database similarity scores."""
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return []
        results = client.search(
            collection_name=collection_name,
            data=[list(query_vector)],
            anns_field=DENSE_VECTOR_FIELD,
            filter=filter_expr,
            limit=limit,
            output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
            search_params={"metric_type": METRIC_TYPE, "params": {}},
            consistency_level=READ_CONSISTENCY_LEVEL,
            timeout=self.rpc_timeout,
        )
        return self._hits_from_results(results)

    def sparse_search(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        query_text: str,
        filter_expr: str,
        limit: int,
        output_fields: Sequence[str] | None = None,
    ) -> List[Dict[str, Any]]:
        """Server-side BM25 keyword search over the analyzed retrieval text.

        The query is plain text: Milvus analyzes it with the collection's
        analyzer and scores it against the sparse terms it indexed. No
        embedding provider is involved.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return []
        results = client.search(
            collection_name=collection_name,
            data=[query_text],
            anns_field=SPARSE_VECTOR_FIELD,
            filter=filter_expr,
            limit=limit,
            output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
            search_params={"metric_type": SPARSE_METRIC_TYPE, "params": {}},
            consistency_level=READ_CONSISTENCY_LEVEL,
            timeout=self.rpc_timeout,
        )
        return self._hits_from_results(results)

    @staticmethod
    def _hits_from_results(results: Sequence[Any]) -> List[Dict[str, Any]]:
        """Normalize SDK hits into row dictionaries carrying ``__score__``."""
        hits: List[Dict[str, Any]] = []
        for hit in results[0] if results else []:
            entity = dict(hit.get("entity") or {})
            entity["__score__"] = float(hit.get("distance", 0.0))
            hits.append(entity)
        return hits

    def has_collection(self, client: MilvusClient, collection_name: str) -> bool:
        return bool(client.has_collection(collection_name, timeout=self.rpc_timeout))
