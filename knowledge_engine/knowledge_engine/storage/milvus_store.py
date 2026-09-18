# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded PyMilvus access: client lifetimes, RPCs and the index contract.

This module owns the talking part - one short-lived official client per bounded
operation, the RPCs the adapters call, and reading and confirming the index
contract a collection declares in its own description. The row layout, contract
vocabulary, row identifiers and filters it works with live in ``milvus_native``.
It never resolves retrieval text or calls an embedding provider, so the adapter
above it can be tested against real Milvus without a model.
"""

from __future__ import annotations

import logging
import uuid
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Sequence

import grpc
from pymilvus import AnnSearchRequest, MilvusClient, WeightedRanker
from pymilvus.exceptions import MilvusException
from pymilvus.orm.iterator import QueryIterator

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
)
from knowledge_engine.storage.milvus_errors import rpc_failure
from knowledge_engine.storage.milvus_native import (
    ANALYZER_TYPE,
    DEFAULT_RPC_TIMEOUT_SECONDS,
    DENSE_VECTOR_FIELD,
    HEAVY_RPC_TIMEOUT_SECONDS,
    ID_FIELD,
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
    build_collection_schema,
    read_collection_description,
    strip_connection_credentials,
)

logger = logging.getLogger(__name__)


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

    def read_contract(
        self,
        client: MilvusClient,
        collection_name: str,
    ) -> MilvusIndexBinding | None:
        """Read the index contract a collection declares about itself.

        The contract is read from the collection it describes, so this is the
        only lookup the whole write, read and delete path needs - and it never
        creates anything. ``None`` means there is no such collection, which is
        what a knowledge base that was never indexed looks like. A collection
        that exists without a readable contract was not created by this code and
        is refused instead of being adopted, and so is one whose own contract
        disagrees with the dimension it declares.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return None
        described = read_collection_description(
            client, collection_name, timeout=self.rpc_timeout
        )
        binding = described.binding
        if binding is None:
            raise IndexContractIncompatibleError(
                collection_name,
                "the collection declares no readable index contract",
            )
        if described.dimension != binding.dimension:
            raise IndexContractIncompatibleError(
                collection_name,
                "the collection vector dimension differs from its own contract",
                details={
                    "declared_dimension": binding.dimension,
                    "collection_dimension": described.dimension,
                },
            )
        return binding

    def confirm_contract(
        self,
        collection_name: str,
        binding: MilvusIndexBinding,
        *,
        dimension: int,
        embedding_space: str,
    ) -> None:
        """Confirm a contract the caller already read serves this request.

        The comparison is in memory: the caller read the contract from the
        collection itself, so serving it twice would only add a round trip.
        """
        binding.assert_compatible(
            self.build_binding(
                collection_name,
                dimension=dimension,
                embedding_space=embedding_space,
            )
        )

    def ensure_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dimension: int,
        embedding_space: str,
    ) -> MilvusIndexBinding:
        """Create the index once, or confirm the contract it already declares.

        The collection is the only atomic ownership resource Milvus offers, and
        its own description carries the contract, so a collection this code
        created always answers with the contract it was created under. A
        collection that declares a different contract - including the same
        dimension in another embedding space - is refused rather than
        overwritten, and a collection that declares no readable contract is
        refused rather than adopted.

        ``create_collection`` is not a compare-and-swap, so a create is
        followed by reading the contract back from the collection: a concurrent
        writer of another contract may have created the name first, and this
        writer must fail instead of writing rows into a collection it does not
        own. Nothing waits for that writer: the race either lands on this
        writer's contract or fails explicitly.
        """
        requested = self.build_binding(
            collection_name,
            dimension=dimension,
            embedding_space=embedding_space,
        )
        declared = self.read_contract(client, collection_name)
        if declared is None:
            self._create_collection(client, requested)
            declared = self._read_created_collection(client, requested)
        declared.assert_compatible(requested)
        return declared

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

    def _create_collection(
        self, client: MilvusClient, binding: MilvusIndexBinding
    ) -> None:
        """Create the owned collection, contract included, in one request."""
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
                schema=build_collection_schema(binding),
                index_params=index_params,
                consistency_level=WRITE_CONSISTENCY_LEVEL,
                timeout=HEAVY_RPC_TIMEOUT_SECONDS,
            )
        except Exception:
            # A create that lost the name race answers with the server's
            # duplicate-collection rejection - measured on the pinned 2.5.4
            # fixture: an identical create is idempotent, a different contract
            # is rejected as "different parameters". This writer never waits
            # for the other one: it reads the collection back and either
            # confirms the contract it found or fails, and a create that leaves
            # nothing to read back is raised as it is.
            if not self.has_collection(client, binding.collection_name):
                raise
            logger.info(
                "[Milvus] Collection %s lost the create race; confirming the "
                "contract it declares",
                binding.collection_name,
            )

    def _read_created_collection(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> MilvusIndexBinding:
        """Read the contract the created collection declares about itself.

        This is the post-create read the contract needs: the collection exists,
        so the caller can compare the contract in its description with the one
        this writer asked for. A collection that cannot be read back is a fault,
        not an empty knowledge base.
        """
        declared = self.read_contract(client, requested.collection_name)
        if declared is None:
            raise IndexMissingError(
                requested.collection_name,
                "the collection is gone immediately after its creation",
            )
        return declared

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

    def open_row_iterator(
        self,
        client: MilvusClient,
        collection_name: str,
        filter_expr: str,
        *,
        batch_size: int,
        limit: int,
        output_fields: Sequence[str] | None = None,
        consistency_level: str = READ_CONSISTENCY_LEVEL,
    ) -> QueryIterator:
        """Open a bounded server iterator over the matching rows.

        The server continues the query from the primary key of the last row it
        returned, so the batches of one static collection neither repeat nor
        skip a row, while an ``offset`` the server re-applies to an unordered
        result promises neither. Each batch is one RPC on the read consistency
        level with this store's deadline, ``batch_size`` rows are asked for per
        call, and ``limit`` is the business ceiling the caller must not read
        past. The caller owns closing the iterator it is handed.
        """
        return client.query_iterator(
            collection_name=collection_name,
            batch_size=batch_size,
            limit=limit,
            filter=filter_expr,
            output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
            consistency_level=consistency_level,
            timeout=self.rpc_timeout,
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

    def hybrid_search(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dense_query_vector: Sequence[float],
        sparse_query_text: str,
        filter_expr: str,
        limit: int,
        vector_weight: float,
        keyword_weight: float,
        output_fields: Sequence[str] | None = None,
    ) -> List[Dict[str, Any]]:
        """Run one native hybrid search: both branches and the server ranker.

        Both branches carry the same filter, so the scope is applied inside the
        server before either branch is cut. ``WeightedRanker`` fuses the two
        branches with the shares the caller resolved, and the score it returns
        is the score this call reports: nothing here normalizes or remaps it.
        """
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return []
        requests = [
            AnnSearchRequest(
                data=[list(dense_query_vector)],
                anns_field=DENSE_VECTOR_FIELD,
                param={"metric_type": METRIC_TYPE, "params": {}},
                limit=limit,
                expr=filter_expr,
            ),
            AnnSearchRequest(
                data=[sparse_query_text],
                anns_field=SPARSE_VECTOR_FIELD,
                param={"metric_type": SPARSE_METRIC_TYPE, "params": {}},
                limit=limit,
                expr=filter_expr,
            ),
        ]
        results = client.hybrid_search(
            collection_name=collection_name,
            reqs=requests,
            ranker=WeightedRanker(vector_weight, keyword_weight),
            limit=limit,
            output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
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
