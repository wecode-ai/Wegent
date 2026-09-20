# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Bounded PyMilvus access: the shared connection, RPCs and the index contract.

This module owns the talking part - the alias one connection identity is
reused under, the RPCs the adapters call, and reading and confirming what a
collection declares about itself. The row layout, contract vocabulary, row
identifiers and filters it works with live in ``native``. It never resolves
retrieval text or calls an embedding provider, so the adapter above it can be
tested against real Milvus without a model.
"""

from __future__ import annotations

import hashlib
import json
from contextlib import contextmanager
from typing import Any, Callable, Dict, Iterator, List, Sequence
from urllib.parse import urlparse, urlunparse

import grpc
from pymilvus import AnnSearchRequest, MilvusClient, WeightedRanker
from pymilvus.exceptions import MilvusException
from pymilvus.orm.iterator import QueryIterator

from knowledge_engine.storage.milvus.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    rpc_failure,
)
from knowledge_engine.storage.milvus.native import (
    DEFAULT_RPC_TIMEOUT_SECONDS,
    DENSE_VECTOR_FIELD,
    HEAVY_RPC_TIMEOUT_SECONDS,
    METRIC_TYPE,
    READ_CONSISTENCY_LEVEL,
    ROW_OUTPUT_FIELDS,
    SCHEMA_VERSION,
    SPARSE_METRIC_TYPE,
    SPARSE_VECTOR_FIELD,
    WRITE_CONSISTENCY_LEVEL,
    CollectionDescription,
    MilvusIndexBinding,
    assert_collection_structure,
    build_collection_schema,
    declare_collection_indexes,
    read_collection_description,
    read_collection_indexes,
)

# The prefix keeps the aliases this code registers recognisable next to the
# SDK's own "default" alias; the digest is what makes them unique.
ALIAS_PREFIX = "wegent-milvus-"
# 128 bits of the digest is plenty to separate connection identities, and short
# enough to stay readable in an SDK error that names the alias.
ALIAS_DIGEST_LENGTH = 32


def derive_connection_alias(*, uri: str, db_name: str, token: str) -> str:
    """Derive the PyMilvus alias one connection identity is registered under.

    The alias is the irreversible digest of the connection identity: the
    normalized URI, the database and the authentication identity. Two tasks
    that address the same service, database and credential therefore share
    PyMilvus's own connection instead of opening one each, while a different
    service, database or credential never joins that connection. The credential
    enters the payload as its own digest, so the alias separates two identities
    without ever carrying a token.
    """
    canonical_payload = json.dumps(
        {
            "uri": _normalized_uri(uri),
            "db_name": str(db_name),
            "auth_identity": _auth_identity_digest(token),
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    digest = hashlib.sha256(canonical_payload.encode("utf-8")).hexdigest()
    return ALIAS_PREFIX + digest[:ALIAS_DIGEST_LENGTH]


def _normalized_uri(uri: str) -> str:
    """One spelling per service: scheme and host lowercased, no trailing slash.

    A URI without a scheme is a local Milvus Lite file, so only its trailing
    slashes are dropped - lowercasing a path would name another file. Only the
    host is case-insensitive: userinfo inside the netloc is a credential, so
    two spellings of it are two identities and must stay apart.
    """
    text = str(uri).strip()
    parsed = urlparse(text)
    if not parsed.scheme:
        return text.rstrip("/")
    userinfo, separator, host = parsed.netloc.rpartition("@")
    return urlunparse(
        (
            parsed.scheme.lower(),
            f"{userinfo}{separator}{host.lower()}" if separator else host.lower(),
            parsed.path.rstrip("/"),
            parsed.params,
            parsed.query,
            "",
        )
    )


def _auth_identity_digest(token: str) -> str:
    """The credential's own digest, or a marker when the service is open."""
    if not token:
        return "anonymous"
    return hashlib.sha256(str(token).encode("utf-8")).hexdigest()


class MilvusDocumentStore:
    """Bounded, synchronous PyMilvus access over one shared connection."""

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

    @property
    def connection_alias(self) -> str:
        """The alias this store's URI, database and credential are reused under."""
        return derive_connection_alias(
            uri=self.uri,
            db_name=self.db_name,
            token=self.token,
        )

    @contextmanager
    def client(self) -> Iterator[MilvusClient]:
        """Yield the client that joins this connection identity's connection.

        The alias is the whole connection-sharing mechanism: PyMilvus registers
        one connection per alias and hands it back to every client built under
        that alias, so the connection outlives each operation and no cache,
        pool, reference count or reclaimer is added on top of it. Closing the
        client here would tear that connection down under every other operation
        that reused the alias, so an operation never closes it.

        Failures the SDK raises keep their stable storage classification across
        this boundary; anything else propagates as it is.
        """
        try:
            client = self._client_factory(
                uri=self.uri,
                token=self.token,
                db_name=self.db_name,
                timeout=self.timeout,
                alias=self.connection_alias,
            )
            yield client
        except (MilvusException, grpc.RpcError) as exc:
            raise rpc_failure(exc) from exc

    @property
    def rpc_timeout(self) -> float:
        """Deadline for one Milvus RPC.

        The PyMilvus client constructor only bounds the initial connection: the
        SDK retries a per-call RPC until that call gets its own ``timeout``
        kwarg. Passing this value to every RPC is what bounds each call, so it
        is the single source of truth for the per-call deadline. It bounds a
        call, not a wait loop the SDK runs inside one: creating a collection
        carries its own integer budget for that loop
        (``HEAVY_RPC_TIMEOUT_SECONDS``).
        """
        return self.timeout or DEFAULT_RPC_TIMEOUT_SECONDS

    def build_binding(
        self,
        *,
        dimension: int,
        embedding_space_id: str,
    ) -> MilvusIndexBinding:
        return MilvusIndexBinding(
            schema_version=SCHEMA_VERSION,
            embedding_space_id=embedding_space_id,
            dimension=dimension,
        )

    def read_contract(
        self,
        client: MilvusClient,
        collection_name: str,
    ) -> MilvusIndexBinding | None:
        """Read the index contract a collection declares about itself.

        The contract is read from the collection it describes, so this is the
        only lookup the read and delete paths need - and it never creates
        anything. ``None`` means there is no such collection, which is what a
        knowledge base that was never indexed looks like. A collection that
        exists without a readable contract was not created by this code and is
        refused instead of being adopted, and so is one whose own contract
        disagrees with the dimension it declares.

        This is deliberately the contract and nothing else: a read answers from
        the capabilities its own operation needs, and the physical structure a
        writer checks is not one of them.
        """
        described = self._describe_collection(client, collection_name)
        if described is None:
            return None
        return self._binding_of(collection_name, described)

    def _describe_collection(
        self,
        client: MilvusClient,
        collection_name: str,
    ) -> CollectionDescription | None:
        """Read what a collection declares, or ``None`` when it does not exist."""
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return None
        return read_collection_description(
            client, collection_name, timeout=self.rpc_timeout
        )

    @staticmethod
    def _binding_of(
        collection_name: str,
        described: CollectionDescription,
    ) -> MilvusIndexBinding:
        """Read the contract out of a description, refusing one that has none."""
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
        embedding_space_id: str,
    ) -> None:
        """Confirm a contract the caller already read serves this request.

        The comparison is in memory: the caller read the contract from the
        collection itself, so serving it twice would only add a round trip.
        """
        binding.assert_compatible(
            self.build_binding(
                dimension=dimension,
                embedding_space_id=embedding_space_id,
            ),
            collection_name=collection_name,
        )

    def ensure_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dimension: int,
        embedding_space_id: str,
    ) -> MilvusIndexBinding:
        """Create the index, or confirm the collection that already serves it.

        The collection is the only atomic ownership resource Milvus offers, and
        its own description carries the contract, so a collection this code
        created always answers with the contract it was created under. A
        collection that declares a different contract - including the same
        dimension in another embedding space - is refused rather than
        overwritten, and a collection that declares no readable contract is
        refused rather than adopted.

        A create that fails is reported as it is. Milvus rejects a create that
        duplicates a name with different parameters, and this writer never
        treats that rejection as its own success: it creates nothing else and
        reads nothing else, so the caller sees the failure. A later attempt
        reads the collection the winner created and either confirms it - the
        same contract, validated against the same real structure - or refuses
        it.

        A create that succeeds is read back, and so is an existing collection,
        which is where the structure check runs: a collection can declare this
        schema version while missing a field, the BM25 function or an index, so
        the writer confirms the real structure before it deletes or writes a
        row.
        """
        requested = self.build_binding(
            dimension=dimension,
            embedding_space_id=embedding_space_id,
        )
        described = self._describe_collection(client, collection_name)
        if described is None:
            self._create_collection(client, collection_name, requested)
            described = self._read_created_collection(client, collection_name)
        declared = self._binding_of(collection_name, described)
        declared.assert_compatible(requested, collection_name=collection_name)
        self._assert_structure(
            client,
            collection_name,
            described,
            binding=declared,
        )
        return declared

    def _create_collection(
        self,
        client: MilvusClient,
        collection_name: str,
        binding: MilvusIndexBinding,
    ) -> None:
        """Create the owned collection, contract included, in one request.

        A failure is raised as it is: nothing here reads the name back to guess
        whether another writer got there first, because a collection this
        writer did not watch being created is not one it may claim. The next
        attempt reads whatever is under the name and confirms or refuses it.
        """
        index_params = client.prepare_index_params()
        declare_collection_indexes(index_params)
        client.create_collection(
            collection_name=collection_name,
            schema=build_collection_schema(binding),
            index_params=index_params,
            consistency_level=WRITE_CONSISTENCY_LEVEL,
            timeout=HEAVY_RPC_TIMEOUT_SECONDS,
        )

    def _read_created_collection(
        self,
        client: MilvusClient,
        collection_name: str,
    ) -> CollectionDescription:
        """Read the collection this writer just created.

        This is the post-create read the contract needs: the collection exists,
        so the caller can compare the contract in its description with the one
        this writer asked for. A collection that cannot be read back is a fault,
        not an empty knowledge base.
        """
        described = self._describe_collection(client, collection_name)
        if described is None:
            raise IndexMissingError(
                collection_name,
                "the collection is gone immediately after its creation",
            )
        return described

    def _assert_structure(
        self,
        client: MilvusClient,
        collection_name: str,
        described: CollectionDescription,
        *,
        binding: MilvusIndexBinding,
    ) -> None:
        """Confirm the real fields, BM25 function and index state of a collection.

        The described structure came from the collection itself, so only the
        index metadata costs another RPC. This runs on the write path alone:
        the write is what must land in a collection this schema can read.
        """
        indexes = read_collection_indexes(
            client, collection_name, timeout=self.rpc_timeout
        )
        assert_collection_structure(
            described,
            indexes,
            binding=binding,
            collection_name=collection_name,
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
    ) -> int:
        """Delete the matching rows and report the count the RPC returned.

        The caller has already settled the collection's existence and contract,
        so the delete is the only RPC here. The delete entry point flushes so
        the removal is durable before it is reported; the write path passes
        ``flush=False`` because it must not seal the segment on every rewrite.
        """
        result = client.delete(
            collection_name=collection_name,
            filter=filter_expr,
            timeout=self.rpc_timeout,
        )
        if flush:
            client.flush(collection_name, timeout=self.rpc_timeout)
        deleted_count = result.get("delete_count", 0) if isinstance(result, dict) else 0
        return int(deleted_count)

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
        """Dense vector search returning raw database similarity scores.

        The caller read the collection's contract on the same client, so the
        search is the only RPC here: a collection that vanished in between is
        an RPC failure, not an empty result.
        """
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
        embedding provider is involved, and no extra RPC escorts the search.
        """
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
        branches with the shares the caller resolved, and this layer reports
        the ranker's score as it came back; the backend applies the shared
        result-set scoring rule. The whole request is one RPC on the client
        that read the contract.
        """
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
