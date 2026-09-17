# SPDX-FileCopyrightText: 2026 Weibo, Inc.
#
# SPDX-License-Identifier: Apache-2.0

"""Native PyMilvus access layer for the knowledge engine.

This module owns everything that talks to Milvus: schema construction, index
binding verification, row identifiers, filters and the bounded client
lifecycle. It never resolves retrieval text or calls an embedding provider, so
the adapter above it can be tested against real Milvus without a model.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
import uuid
from contextlib import contextmanager
from dataclasses import asdict, dataclass
from typing import Any, Callable, Dict, Iterable, Iterator, List, Sequence

import grpc
from pymilvus import (
    CollectionSchema,
    DataType,
    FieldSchema,
    Function,
    FunctionType,
    MilvusClient,
)
from pymilvus.exceptions import MilvusException

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
)
from knowledge_engine.storage.milvus_errors import rpc_failure

logger = logging.getLogger(__name__)

# Bump when the physical row layout changes in a way that requires rebuilding.
SCHEMA_VERSION = 2
METRIC_TYPE = "COSINE"
INDEX_TYPE = "AUTOINDEX"
SPARSE_METRIC_TYPE = "BM25"
SPARSE_INDEX_TYPE = "SPARSE_INVERTED_INDEX"
# The keyword capability is a property of the collection: the analyzer decides
# which tokens BM25 indexes, so it is part of the stored index contract.
ANALYZER_TYPE = "chinese"
ANALYZER_PARAMS: Dict[str, Any] = {"type": ANALYZER_TYPE}
BM25_FUNCTION_NAME = "retrieval_text_bm25"

MAX_ID_LENGTH = 128
MAX_KEY_LENGTH = 512
MAX_TEXT_LENGTH = 65535
MAX_COUNT_ROWS = 16384

# Retrieval reads a snapshot the write path already published, so it pays no
# linearizable-read wait (~400ms Strong versus ~1ms Bounded on the contract
# fixture). Publication, deletion and creation do verify, so writing stays Strong.
READ_CONSISTENCY_LEVEL = "Bounded"
WRITE_CONSISTENCY_LEVEL = "Strong"

# Fallback deadline for one RPC when a store was constructed without one.
DEFAULT_RPC_TIMEOUT_SECONDS = 10.0
# Creating a collection and writing its contract are heavy server operations,
# so they get a wider - but still bounded - budget than a query or mutation.
HEAVY_RPC_TIMEOUT_SECONDS = 30.0

ID_FIELD = "id"
KNOWLEDGE_ID_FIELD = "knowledge_id"
DOC_REF_FIELD = "doc_ref"
SOURCE_FILE_FIELD = "source_file"
GENERATION_FIELD = "generation"
ATTEMPT_ID_FIELD = "attempt_id"
NODE_KIND_FIELD = "node_kind"
CHUNK_INDEX_FIELD = "chunk_index"
RETRIEVAL_TEXT_FIELD = "retrieval_text"
DISPLAY_TEXT_FIELD = "display_text"
METADATA_FIELD = "metadata"
CREATED_AT_FIELD = "created_at"
PUBLISHED_FIELD = "published"
DENSE_VECTOR_FIELD = "dense_vector"
SPARSE_VECTOR_FIELD = "sparse_vector"

NODE_KIND_CHUNK = "chunk"

# Physical scalar columns that a metadata condition may be compiled against.
# Row identity and publication state are deliberately absent: the write path
# owns them, so a query condition can never pin or fake them.
CHUNK_FIELDS_FOR_FILTERING: List[str] = [
    KNOWLEDGE_ID_FIELD,
    DOC_REF_FIELD,
    SOURCE_FILE_FIELD,
    GENERATION_FIELD,
    ATTEMPT_ID_FIELD,
    NODE_KIND_FIELD,
    CHUNK_INDEX_FIELD,
    CREATED_AT_FIELD,
]
NUMERIC_FILTER_FIELDS = frozenset({GENERATION_FIELD, CHUNK_INDEX_FIELD})

ROW_OUTPUT_FIELDS: List[str] = [
    ID_FIELD,
    KNOWLEDGE_ID_FIELD,
    DOC_REF_FIELD,
    SOURCE_FILE_FIELD,
    GENERATION_FIELD,
    ATTEMPT_ID_FIELD,
    NODE_KIND_FIELD,
    CHUNK_INDEX_FIELD,
    RETRIEVAL_TEXT_FIELD,
    DISPLAY_TEXT_FIELD,
    METADATA_FIELD,
    CREATED_AT_FIELD,
    PUBLISHED_FIELD,
]

INDEX_BINDING_COLLECTION = "wegent_index_bindings"
BINDING_VECTOR_FIELD = "binding_vector"
# Milvus rejects dimensions below 2, so the registry placeholder is 2d even
# though it is never searched.
BINDING_VECTOR_DIM = 2
BINDING_VECTOR_VALUE = [0.0, 0.0]
# The registry row keeps a state column for schema stability; a stored binding
# is always confirmed, so the value is constant.
BINDING_STATE_FIELD = "state"
BINDING_STATE_READY = "ready"
CONCURRENT_BINDING_TIMEOUT_SECONDS = 5.0
CONCURRENT_BINDING_POLL_SECONDS = 0.05


@dataclass(frozen=True)
class MilvusIndexBinding:
    """Server-maintained physical index contract for one knowledge base."""

    collection_name: str
    connection: str
    database: str
    schema_version: int
    embedding_space: str
    dimension: int
    metric_type: str
    index_type: str
    # Analyzer that tokenizes the BM25 keyword index. An empty value marks a
    # contract written before the keyword slice, which cannot serve keyword
    # retrieval and is rejected instead of answering with empty results.
    analyzer: str = ""

    def to_payload(self) -> Dict[str, Any]:
        return asdict(self)

    def to_row(self) -> Dict[str, Any]:
        row = self.to_payload()
        row["binding_json"] = json.dumps(row, sort_keys=True)
        return row

    @classmethod
    def from_payload(cls, payload: Dict[str, Any]) -> "MilvusIndexBinding":
        return cls(
            collection_name=str(payload["collection_name"]),
            connection=str(payload["connection"]),
            database=str(payload["database"]),
            schema_version=int(payload["schema_version"]),
            embedding_space=str(payload["embedding_space"]),
            dimension=int(payload["dimension"]),
            metric_type=str(payload["metric_type"]),
            index_type=str(payload["index_type"]),
            analyzer=str(payload.get("analyzer") or ""),
        )

    @classmethod
    def from_row(cls, row: Dict[str, Any]) -> "MilvusIndexBinding":
        raw = row.get("binding_json")
        if not isinstance(raw, str) or not raw:
            raise IndexContractIncompatibleError(
                str(row.get("collection_name") or "unknown"),
                "the stored binding row has no contract payload",
            )
        return cls.from_payload(json.loads(raw))

    def assert_compatible(self, other: "MilvusIndexBinding") -> None:
        """Raise when the requested contract differs from the bound one."""
        for field in (
            "connection",
            "database",
            "schema_version",
            "embedding_space",
            "dimension",
            "metric_type",
            "index_type",
            "analyzer",
        ):
            if getattr(self, field) != getattr(other, field):
                raise IndexContractIncompatibleError(
                    self.collection_name,
                    f"{field} mismatch",
                    details={
                        "bound": getattr(self, field),
                        "requested": getattr(other, field),
                    },
                )


def sanitize_filter_value(value: Any) -> str:
    """Escape a value for a Milvus boolean filter expression."""
    return str(value).replace("\\", "\\\\").replace('"', '\\"')


def node_row_id(
    *,
    knowledge_id: str,
    doc_ref: str,
    generation: int,
    attempt_id: str,
    node_kind: str,
    chunk_index: int,
) -> str:
    """Derive a stable primary key for one indexed node."""
    identity = "|".join(
        [
            str(knowledge_id),
            str(doc_ref),
            str(generation),
            str(attempt_id),
            str(node_kind),
            str(chunk_index),
        ]
    )
    return hashlib.sha256(identity.encode("utf-8")).hexdigest()


def build_scope_filter(
    *,
    knowledge_id: str,
    doc_refs: Sequence[Any] | None = None,
    extra_conditions: Iterable[str] | None = None,
    published: bool = True,
) -> str:
    """Compile the mandatory knowledge base and publication scope."""
    conditions = [f'knowledge_id == "{sanitize_filter_value(knowledge_id)}"']
    if published:
        conditions.append(f"{PUBLISHED_FIELD} == true")
    if doc_refs is not None:
        if not doc_refs:
            raise ValueError("doc_refs must not be an empty scope")
        escaped = [f'"{sanitize_filter_value(doc_ref)}"' for doc_ref in doc_refs]
        conditions.append(f"doc_ref in [{', '.join(escaped)}]")
    for condition in extra_conditions or ():
        normalized = condition.strip()
        if normalized:
            conditions.append(normalized)
    return " and ".join(conditions)


def contract_token_field(embedding_space: str) -> str:
    """Field name that pins the collection schema to one embedding space.

    Milvus creates a collection idempotently when the request matches an
    existing one, so "create succeeded" alone cannot tell two writers apart.
    Encoding the contract in the schema makes the server itself reject a
    different contract for the same collection name; the field is never
    queried or searched.
    """
    digest = hashlib.sha256(
        f"v{SCHEMA_VERSION}|{embedding_space}".encode("utf-8")
    ).hexdigest()
    return f"contract_{digest[:16]}"


def build_collection_schema(dimension: int, embedding_space: str) -> CollectionSchema:
    """Build the physical row layout for one Milvus knowledge index.

    The collection carries both retrieval paths: a dense vector for semantic
    search and a server-maintained sparse vector whose terms come from the
    BM25 function over the analyzed retrieval text. Filterable metadata is a
    native JSON column so it is applied by the server before ``top_k``.
    """
    if dimension <= 0:
        raise ValueError("dimension must be a positive integer")
    fields = _scalar_row_fields() + [
        FieldSchema(
            name=contract_token_field(embedding_space),
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(
            name=DENSE_VECTOR_FIELD,
            dtype=DataType.FLOAT_VECTOR,
            dim=dimension,
        ),
        FieldSchema(
            name=SPARSE_VECTOR_FIELD,
            dtype=DataType.SPARSE_FLOAT_VECTOR,
        ),
    ]
    schema = CollectionSchema(
        fields=fields,
        auto_id=False,
        enable_dynamic_field=False,
        description=f"wegent knowledge index schema v{SCHEMA_VERSION}",
    )
    schema.add_function(
        Function(
            name=BM25_FUNCTION_NAME,
            function_type=FunctionType.BM25,
            input_field_names=[RETRIEVAL_TEXT_FIELD],
            output_field_names=[SPARSE_VECTOR_FIELD],
            params={},
        )
    )
    return schema


def _scalar_row_fields() -> List[FieldSchema]:
    """Scalar columns shared by every knowledge index row."""
    return [
        FieldSchema(
            name=ID_FIELD,
            dtype=DataType.VARCHAR,
            is_primary=True,
            max_length=MAX_ID_LENGTH,
        ),
        FieldSchema(
            name=KNOWLEDGE_ID_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(
            name=DOC_REF_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(
            name=SOURCE_FILE_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name=GENERATION_FIELD, dtype=DataType.INT64),
        FieldSchema(
            name=ATTEMPT_ID_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_ID_LENGTH,
        ),
        FieldSchema(
            name=NODE_KIND_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        FieldSchema(name=CHUNK_INDEX_FIELD, dtype=DataType.INT64),
        FieldSchema(
            name=RETRIEVAL_TEXT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
            # The analyzer must be declared on the field itself: a
            # collection-level analyzer does not tokenize BM25 queries in
            # Milvus 2.5.4, which silently returns no Chinese hits.
            enable_analyzer=True,
            analyzer_params=dict(ANALYZER_PARAMS),
        ),
        FieldSchema(
            name=DISPLAY_TEXT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name=METADATA_FIELD, dtype=DataType.JSON, nullable=True),
        FieldSchema(
            name=CREATED_AT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name=PUBLISHED_FIELD, dtype=DataType.BOOL),
    ]


def build_binding_collection_schema() -> CollectionSchema:
    fields = [
        FieldSchema(
            name="collection_name",
            dtype=DataType.VARCHAR,
            is_primary=True,
            max_length=MAX_KEY_LENGTH,
        ),
    ]
    fields.extend(_binding_payload_fields())
    fields.append(
        FieldSchema(
            name=BINDING_STATE_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        )
    )
    # Milvus requires every collection to own a vector field. This
    # placeholder is never searched; the registry only answers filters.
    fields.append(
        FieldSchema(
            name=BINDING_VECTOR_FIELD,
            dtype=DataType.FLOAT_VECTOR,
            dim=BINDING_VECTOR_DIM,
        )
    )
    return CollectionSchema(
        fields=fields,
        auto_id=False,
        enable_dynamic_field=False,
        description="wegent index binding registry",
    )


def _binding_payload_fields() -> List[FieldSchema]:
    """Columns that mirror the stored index contract payload."""
    return [
        FieldSchema(
            name="connection", dtype=DataType.VARCHAR, max_length=MAX_TEXT_LENGTH
        ),
        FieldSchema(name="database", dtype=DataType.VARCHAR, max_length=MAX_KEY_LENGTH),
        FieldSchema(name="schema_version", dtype=DataType.INT64),
        FieldSchema(
            name="embedding_space",
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(name="dimension", dtype=DataType.INT64),
        FieldSchema(
            name="metric_type", dtype=DataType.VARCHAR, max_length=MAX_KEY_LENGTH
        ),
        FieldSchema(
            name="index_type", dtype=DataType.VARCHAR, max_length=MAX_KEY_LENGTH
        ),
        FieldSchema(name="analyzer", dtype=DataType.VARCHAR, max_length=MAX_KEY_LENGTH),
        FieldSchema(
            name="binding_json", dtype=DataType.VARCHAR, max_length=MAX_TEXT_LENGTH
        ),
    ]


def collection_dimension(
    client: MilvusClient,
    collection_name: str,
    *,
    timeout: float,
) -> int | None:
    """Read the dense vector dimension from an existing collection."""
    description = client.describe_collection(collection_name, timeout=timeout)
    for field in description.get("fields", []):
        if field.get("name") == DENSE_VECTOR_FIELD:
            dim = field.get("params", {}).get("dim")
            return int(dim) if dim is not None else None
    return None


def strip_connection_credentials(uri: str) -> str:
    """Remove userinfo from a connection URI before it is persisted."""
    if "://" not in uri:
        return uri
    scheme, _, remainder = uri.partition("://")
    authority, _, path = remainder.partition("/")
    if "@" in authority:
        authority = authority.rsplit("@", 1)[1]
    return f"{scheme}://{authority}/{path}" if path else f"{scheme}://{authority}"


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

        The write path raises the level; see ``read_owned_binding``.
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

    def read_owned_binding(
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
        bound = self.read_owned_binding(client, collection_name)
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
            if self.read_owned_binding(client, requested.collection_name) is not None:
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
        bound = self.read_owned_binding(client, collection_name)
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
        bound = self.read_owned_binding(client, requested.collection_name)
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

        Callers own their durability stance: the write path relies on the
        server's background flush and a Strong consistency read, while the
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
        if not client.has_collection(collection_name, timeout=self.rpc_timeout):
            return 0
        rows = client.query(
            collection_name=collection_name,
            filter=filter_expr,
            output_fields=[ID_FIELD],
            limit=MAX_COUNT_ROWS,
            consistency_level=WRITE_CONSISTENCY_LEVEL,
            timeout=self.rpc_timeout,
        )
        if len(rows) >= MAX_COUNT_ROWS:
            raise StorageBackendError(
                "Milvus row count exceeded the verification budget; the count "
                "cannot be trusted for publication or deletion.",
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
    ) -> List[Dict[str, Any]]:
        """Read one page of matching rows.

        Milvus does not order a query result, so ``offset`` continues the
        server's own order: it pages a static collection the way ``limit``
        alone cannot, and the caller owns any order it promises on top.
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
                consistency_level=READ_CONSISTENCY_LEVEL,
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
