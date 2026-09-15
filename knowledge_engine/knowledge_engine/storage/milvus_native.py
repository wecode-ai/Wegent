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

from pymilvus import CollectionSchema, DataType, FieldSchema, MilvusClient

from knowledge_engine.storage.errors import (
    IndexContractIncompatibleError,
    IndexMissingError,
    StorageBackendError,
)

logger = logging.getLogger(__name__)

# Bump when the physical row layout changes in a way that requires rebuilding.
SCHEMA_VERSION = 1
METRIC_TYPE = "COSINE"
INDEX_TYPE = "AUTOINDEX"

MAX_ID_LENGTH = 128
MAX_KEY_LENGTH = 512
MAX_TEXT_LENGTH = 65535
MAX_COUNT_ROWS = 16384

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
METADATA_JSON_FIELD = "metadata_json"
CREATED_AT_FIELD = "created_at"
PUBLISHED_FIELD = "published"
DENSE_VECTOR_FIELD = "dense_vector"

NODE_KIND_CHUNK = "chunk"

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
    METADATA_JSON_FIELD,
    CREATED_AT_FIELD,
    PUBLISHED_FIELD,
]

INDEX_BINDING_COLLECTION = "wegent_index_bindings"
BINDING_VECTOR_FIELD = "binding_vector"
# Milvus rejects dimensions below 2, so the registry placeholder is 2d even
# though it is never searched.
BINDING_VECTOR_DIM = 2
BINDING_VECTOR_VALUE = [0.0, 0.0]
BINDING_STATE_FIELD = "state"
BINDING_STATE_CREATING = "creating"
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
    # Reserved for the analyzer-backed sparse slice; empty for dense-only.
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


def build_collection_schema(dimension: int) -> CollectionSchema:
    """Build the physical row layout for a dense Milvus index."""
    if dimension <= 0:
        raise ValueError("dimension must be a positive integer")
    fields = _scalar_row_fields() + [
        FieldSchema(
            name=DENSE_VECTOR_FIELD,
            dtype=DataType.FLOAT_VECTOR,
            dim=dimension,
        ),
    ]
    return CollectionSchema(
        fields=fields,
        auto_id=False,
        enable_dynamic_field=False,
        description=f"wegent knowledge index schema v{SCHEMA_VERSION}",
    )


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
        ),
        FieldSchema(
            name=DISPLAY_TEXT_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
        FieldSchema(
            name=METADATA_JSON_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_TEXT_LENGTH,
        ),
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
        FieldSchema(
            name=BINDING_STATE_FIELD,
            dtype=DataType.VARCHAR,
            max_length=MAX_KEY_LENGTH,
        ),
        # Milvus requires every collection to own a vector field. This
        # placeholder is never searched; the registry only answers filters.
        FieldSchema(
            name=BINDING_VECTOR_FIELD,
            dtype=DataType.FLOAT_VECTOR,
            dim=BINDING_VECTOR_DIM,
        ),
    ]
    return CollectionSchema(
        fields=fields,
        auto_id=False,
        enable_dynamic_field=False,
        description="wegent index binding registry",
    )


def collection_dimension(client: MilvusClient, collection_name: str) -> int | None:
    """Read the dense vector dimension from an existing collection."""
    description = client.describe_collection(collection_name)
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
        try:
            yield client
        finally:
            try:
                client.close()
            except Exception:
                logger.debug("[Milvus] Failed to close client", exc_info=True)

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
        )

    def read_binding(
        self, client: MilvusClient, collection_name: str
    ) -> MilvusIndexBinding | None:
        binding, _ = self.read_binding_entry(client, collection_name)
        return binding

    def read_binding_entry(
        self, client: MilvusClient, collection_name: str
    ) -> tuple[MilvusIndexBinding | None, str | None]:
        """Read the stored contract and its lifecycle state, creating nothing."""
        if not client.has_collection(INDEX_BINDING_COLLECTION):
            return None, None
        rows = client.query(
            collection_name=INDEX_BINDING_COLLECTION,
            filter=f'collection_name == "{sanitize_filter_value(collection_name)}"',
            output_fields=["binding_json", BINDING_STATE_FIELD],
            limit=1,
            consistency_level="Strong",
        )
        if not rows:
            return None, None
        state = rows[0].get(BINDING_STATE_FIELD)
        return MilvusIndexBinding.from_row(rows[0]), (str(state) if state else None)

    def write_binding(
        self,
        client: MilvusClient,
        binding: MilvusIndexBinding,
        *,
        state: str = BINDING_STATE_READY,
    ) -> None:
        if not client.has_collection(INDEX_BINDING_COLLECTION):
            index_params = client.prepare_index_params()
            index_params.add_index(
                field_name=BINDING_VECTOR_FIELD,
                index_type=INDEX_TYPE,
                metric_type="IP",
            )
            try:
                client.create_collection(
                    collection_name=INDEX_BINDING_COLLECTION,
                    schema=build_binding_collection_schema(),
                    index_params=index_params,
                )
            except Exception:
                if not client.has_collection(INDEX_BINDING_COLLECTION):
                    raise
        row = binding.to_row()
        row[BINDING_VECTOR_FIELD] = list(BINDING_VECTOR_VALUE)
        row[BINDING_STATE_FIELD] = state
        client.upsert(
            collection_name=INDEX_BINDING_COLLECTION,
            data=[row],
        )
        client.flush(INDEX_BINDING_COLLECTION)

    def ensure_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dimension: int,
        embedding_space: str,
    ) -> MilvusIndexBinding:
        """Create or repair the index, then verify the bound contract.

        A creation intent is persisted before the collection is created, so a
        process that dies between the two steps can be repaired by retrying
        with the same contract instead of leaving an unusable collection.
        """
        requested = self.build_binding(
            collection_name,
            dimension=dimension,
            embedding_space=embedding_space,
        )
        bound, state = self.read_binding_entry(client, collection_name)
        collection_exists = client.has_collection(collection_name)

        if bound is None:
            if collection_exists:
                # Unknown collection: never adopted, overwritten or dropped.
                raise IndexContractIncompatibleError(
                    collection_name,
                    "the collection has no stored index contract",
                )
            self.write_binding(client, requested, state=BINDING_STATE_CREATING)
        else:
            bound.assert_compatible(requested)
            if collection_exists:
                self._assert_collection_dimension(client, requested)
                if state != BINDING_STATE_READY:
                    self.write_binding(client, requested, state=BINDING_STATE_READY)
                return bound
            if state == BINDING_STATE_READY:
                raise IndexMissingError(
                    collection_name,
                    "the bound collection confirmed earlier is gone",
                )

        if self._create_collection(client, requested):
            self._assert_collection_dimension(client, requested)
            self.write_binding(client, requested, state=BINDING_STATE_READY)
            return requested
        return self._await_binding(client, requested)

    def _await_binding(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> MilvusIndexBinding:
        """Re-read a concurrently created collection until its contract lands."""
        deadline = time.monotonic() + CONCURRENT_BINDING_TIMEOUT_SECONDS
        while True:
            binding, state = self.read_binding_entry(client, requested.collection_name)
            if binding is not None and state == BINDING_STATE_READY:
                return self._verify_existing(client, requested)
            if time.monotonic() >= deadline:
                raise IndexContractIncompatibleError(
                    requested.collection_name,
                    "the collection has no confirmed index contract",
                )
            time.sleep(CONCURRENT_BINDING_POLL_SECONDS)

    def verify_index(
        self,
        client: MilvusClient,
        collection_name: str,
        *,
        dimension: int,
        embedding_space: str,
    ) -> MilvusIndexBinding | None:
        """Read-only contract check; None means the index does not exist."""
        if not client.has_collection(collection_name):
            return None
        requested = self.build_binding(
            collection_name,
            dimension=dimension,
            embedding_space=embedding_space,
        )
        return self._verify_existing(client, requested)

    def require_bound(
        self, client: MilvusClient, collection_name: str
    ) -> MilvusIndexBinding | None:
        """Return the bound contract of an existing collection, None if absent.

        Reads and deletes use this so an unknown collection is never queried
        or mutated through a contract it does not declare.
        """
        if not client.has_collection(collection_name):
            return None
        bound = self.read_binding(client, collection_name)
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
        try:
            client.create_collection(
                collection_name=binding.collection_name,
                schema=build_collection_schema(binding.dimension),
                index_params=index_params,
                consistency_level="Strong",
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
            if client.has_collection(name):
                return True
            if time.monotonic() >= deadline:
                return False
            time.sleep(CONCURRENT_BINDING_POLL_SECONDS)

    def _verify_existing(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> MilvusIndexBinding:
        bound = self.read_binding(client, requested.collection_name)
        if bound is None:
            raise IndexContractIncompatibleError(
                requested.collection_name,
                "the collection has no stored index contract",
            )
        bound.assert_compatible(requested)
        self._assert_collection_dimension(client, requested)
        return bound

    def _assert_collection_dimension(
        self, client: MilvusClient, requested: MilvusIndexBinding
    ) -> None:
        actual_dimension = collection_dimension(client, requested.collection_name)
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
        if not rows:
            return 0
        client.upsert(collection_name=collection_name, data=list(rows))
        return len(rows)

    def delete_rows(
        self, client: MilvusClient, collection_name: str, filter_expr: str
    ) -> None:
        if not client.has_collection(collection_name):
            return
        client.delete(collection_name=collection_name, filter=filter_expr)
        client.flush(collection_name)

    def count_rows(
        self, client: MilvusClient, collection_name: str, filter_expr: str
    ) -> int:
        if not client.has_collection(collection_name):
            return 0
        rows = client.query(
            collection_name=collection_name,
            filter=filter_expr,
            output_fields=[ID_FIELD],
            limit=MAX_COUNT_ROWS,
            consistency_level="Strong",
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
    ) -> List[Dict[str, Any]]:
        if not client.has_collection(collection_name):
            return []
        return list(
            client.query(
                collection_name=collection_name,
                filter=filter_expr,
                output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
                limit=limit,
                consistency_level="Strong",
            )
        )

    def flush(self, client: MilvusClient, collection_name: str) -> None:
        if client.has_collection(collection_name):
            client.flush(collection_name)

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
        if not client.has_collection(collection_name):
            return []
        results = client.search(
            collection_name=collection_name,
            data=[list(query_vector)],
            anns_field=DENSE_VECTOR_FIELD,
            filter=filter_expr,
            limit=limit,
            output_fields=list(output_fields or ROW_OUTPUT_FIELDS),
            search_params={"metric_type": METRIC_TYPE, "params": {}},
            consistency_level="Strong",
        )
        hits: List[Dict[str, Any]] = []
        for hit in results[0] if results else []:
            entity = dict(hit.get("entity") or {})
            entity["__score__"] = float(hit.get("distance", 0.0))
            hits.append(entity)
        return hits

    def has_collection(self, client: MilvusClient, collection_name: str) -> bool:
        return bool(client.has_collection(collection_name))
